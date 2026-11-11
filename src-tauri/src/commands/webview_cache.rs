//! WebView2（Chromium）缓存的统计与回收。
//!
//! 软件里每一个网页视图都是 Windows 的 WebView2，各自在磁盘上留一份 profile：
//! 主窗口一份，内置浏览器的网页 / 工具栏 / 下载面板 / 插件窗口各一份。
//! profile 里 `Default/Cache` 是取到的资源副本，`Default/Code Cache` 是 V8 编译后的
//! 字节码——两者都只是派生物，删掉之后内核按需重建，不丢任何用户数据。
//!
//! 但同一层里紧挨着 `Cookies`、`Local Storage`、`IndexedDB`、`Network`，那是登录态。
//! 所以这里**只按白名单删**：`CACHE_DIRS` 是纯缓存，`SITE_DIRS` 是站点数据，
//! 想清站点数据必须显式传 `sites: true`。主窗口的站点数据**永远不删**——
//! `localStorage` 里存着主题快照（首屏防闪）、语言包缓存、更新跳过版本号，
//! 清了界面会先白闪一下再变回深色，更新提示也会重新弹。
//!
//! 运行期间这些文件被内核持有，`remove_dir_all` 只能删掉没被打开的那部分。
//! 于是分两步：点击时尽量删，删不掉的写进 `PENDING_FILE`，
//! 下次启动在窗口创建之前再删一次——那时没有任何 webview 持有它们。
//!
//! 为什么不删整个 `EBWebView`：站点数据与缓存是邻居，整目录删等于顺手退出所有网页登录。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 相对 `<profile>/EBWebView` 的纯缓存目录：删了自动重建，不碰任何站点数据。
///
/// 只列实测存在的目录。`Service Worker` 不在这里——它存着注册信息与
/// CacheStorage，属于站点数据，只在 `SITE_DIRS` 里出现。
const CACHE_DIRS: &[&str] = &[
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "Default/Shared Dictionary",
    "GPUPersistentCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "Crashpad",
];

/// 站点数据：清了等于把这些网页的登录状态全部退出。
///
/// 新版 Chromium 把 Cookie 挪进了 `Network` 目录，所以 `Network` 必须一起删，
/// 只删 `Cookies` 那个文件是删不干净的。
const SITE_DIRS: &[&str] = &[
    "Default/Cookies",
    "Default/Cookies-journal",
    "Default/Network",
    "Default/Local Storage",
    "Default/Session Storage",
    "Default/IndexedDB",
    "Default/Service Worker",
    "Default/WebStorage",
    "Default/databases",
    "Default/File System",
    "Default/Extension Cookies",
];

/// 运行时没删干净的登记在这里，下次启动处理
const PENDING_FILE: &str = ".webview-clean-pending";

/// 同一份标记最多执行几次。
///
/// 单实例关闭后多开时，第二个实例也会跑启动清理，而文件正被第一个实例锁着——
/// 那次必然失败。靠这个上限保证标记不会永远留在磁盘上。
const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewUsage {
    /// 主窗口 profile 里可清的纯缓存
    pub app_bytes: i64,
    /// 内置浏览器一组 profile（网页 / 工具栏 / 面板 / 插件窗口）的纯缓存
    pub browser_bytes: i64,
    /// 内置浏览器的站点数据（Cookie / LocalStorage / IndexedDB）
    pub site_bytes: i64,
    /// 有上次没清完、等下次启动的登记
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCleanReport {
    /// 本次实际释放的字节（删完再量一次，不是删前估算）
    pub freed: i64,
    /// 其中属于站点数据的部分
    pub site_freed: i64,
    /// 还有残留，已登记下次启动清理
    pub pending: bool,
}

/// 待清理登记
#[derive(Debug, Serialize, Deserialize)]
struct Pending {
    /// 是否连站点数据一起清
    sites: bool,
    attempts: u32,
}

/* ---------------- 路径 ---------------- */

/// 主窗口的 profile 根。
///
/// Windows 上 Tauri 把 WebView2 的 user data folder 放在
/// `%LOCALAPPDATA%\<identifier>` 下，里面就是 `EBWebView`。
/// 其他平台走各自的系统内核（macOS 是 WKWebView），缓存不在这里，返回 None 即视为不支持。
fn main_profile_root(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")?;
        return Some(PathBuf::from(base).join(identifier).join("EBWebView"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = identifier;
        None
    }
}

/// 内置浏览器一组 profile 的根（data 目录下，每个是独立 `data_directory`，
/// WebView2 会在里面建自己的 `EBWebView`）。
fn data_profile_roots(data_dir: &Path) -> Vec<PathBuf> {
    [
        crate::browser::BROWSER_PROFILE_DIR,
        crate::browser::TOOLBAR_PROFILE_DIR,
        crate::browser::PANEL_PROFILE_DIR,
        crate::plugins::PLUGIN_WINDOW_PROFILE_DIR,
    ]
    .iter()
    .map(|dir| data_dir.join(dir).join("EBWebView"))
    .collect()
}

/* ---------------- 体积 / 清理 ---------------- */

fn path_size(path: &Path) -> i64 {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len() as i64;
    }
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            total += path_size(&entry.path());
        }
    }
    total
}

fn targets(root: &Path, include_site: bool) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = CACHE_DIRS.iter().map(|d| root.join(d)).collect();
    if include_site {
        list.extend(SITE_DIRS.iter().map(|d| root.join(d)));
    }
    list
}

fn list_size(root: &Path, include_site: bool) -> i64 {
    targets(root, include_site)
        .iter()
        .map(|p| path_size(p))
        .sum()
}

/// 一次遍历同时算出 `(纯缓存, 站点数据)`。
///
/// 分开写会走两遍：`list_size(true)` 本身就包含缓存目录，再减 `list_size(false)`
/// 等于把每个 profile 的缓存树爬两遍——764 MB 的量级上就是白白多等一秒。
fn split_size(root: &Path) -> (i64, i64) {
    let cache = CACHE_DIRS
        .iter()
        .map(|d| path_size(&root.join(d)))
        .sum::<i64>();
    let site = SITE_DIRS
        .iter()
        .map(|d| path_size(&root.join(d)))
        .sum::<i64>();
    (cache, site)
}

/// 删一个 profile 的白名单目录，返回 `(删前字节, 删后残留字节)`。
///
/// 残留不等于 0 说明有文件正被内核打开——调用方据此决定要不要登记下次启动。
fn sweep_profile(root: &Path, include_site: bool) -> (i64, i64) {
    let mut before = 0;
    let mut failed = false;

    for target in targets(root, include_site) {
        if !target.exists() {
            continue;
        }
        before += path_size(&target);
        let ok = if target.is_dir() {
            // 中途失败很常见（目录里一半文件被锁），能删的已经删了，剩下的靠下次启动
            std::fs::remove_dir_all(&target).is_ok()
        } else {
            std::fs::remove_file(&target).is_ok()
        };
        // 删失败的目录可能被删掉了一半，必须重算残留；全成功时不必再遍历一遍
        failed |= !ok;
    }

    let after = if failed { list_size(root, include_site) } else { 0 };
    (before, after)
}

/// 一组 profile 的总和，返回 `(删前, 删后)`
fn sweep_group(roots: &[PathBuf], include_site: bool) -> (i64, i64) {
    let mut before = 0;
    let mut after = 0;
    for root in roots {
        let (b, a) = sweep_profile(root, include_site);
        before += b;
        after += a;
    }
    (before, after)
}

/* ---------------- 待清理登记 ---------------- */

fn pending_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PENDING_FILE)
}

fn read_pending(data_dir: &Path) -> Option<Pending> {
    let raw = std::fs::read_to_string(pending_path(data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 写登记：多次点击不叠加尝试次数，只更新清理范围
fn write_pending(data_dir: &Path, sites: bool) {
    let attempts = read_pending(data_dir).map(|p| p.attempts).unwrap_or(0);
    let payload = serde_json::to_string(&Pending { sites, attempts }).unwrap_or_default();
    let _ = std::fs::write(pending_path(data_dir), payload);
}

fn bump_attempts(data_dir: &Path, pending: &Pending) {
    let payload = serde_json::to_string(&Pending {
        sites: pending.sites,
        attempts: pending.attempts + 1,
    })
    .unwrap_or_default();
    let _ = std::fs::write(pending_path(data_dir), payload);
}

/// 启动钩子：在窗口创建之前把上次没删干净的补上。
///
/// 必须由 `run()` 在 `Builder::run` 之前调用——配置文件里的主窗口是在
/// `Builder::run` 里创建的，那时 `Cache` 已被内核打开，再删就只能删一半。
pub fn run_pending_cleanup(identifier: &str, data_dir: &Path) {
    let Some(pending) = read_pending(data_dir) else {
        return;
    };

    if pending.attempts >= MAX_ATTEMPTS {
        // 反复删不掉（多半是被别的实例长期占着）：放弃，别让标记永远躺着
        let _ = std::fs::remove_file(pending_path(data_dir));
        return;
    }

    let mut leftover = 0;

    // 主窗口：只清纯缓存，站点数据一律不动
    if let Some(root) = main_profile_root(identifier) {
        let (_, after) = sweep_profile(&root, false);
        leftover += after;
    }

    let (_, after) = sweep_group(&data_profile_roots(data_dir), pending.sites);
    leftover += after;

    if leftover > 0 {
        bump_attempts(data_dir, &pending);
    } else {
        let _ = std::fs::remove_file(pending_path(data_dir));
    }
}

/* ---------------- 命令 ---------------- */

#[tauri::command(async)]
pub fn webview_usage(app: AppHandle) -> WebviewUsage {
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());

    let app_bytes = main_profile_root(&app.config().identifier)
        .map(|root| split_size(&root).0)
        .unwrap_or(0);

    let mut browser_bytes = 0;
    let mut site_bytes = 0;
    for root in data_profile_roots(&data_dir) {
        let (cache, site) = split_size(&root);
        browser_bytes += cache;
        // 站点数据只统计内置浏览器：主窗口那份是软件自己的界面状态，不该出现在这个数字里
        site_bytes += site;
    }

    WebviewUsage {
        app_bytes,
        browser_bytes,
        site_bytes,
        pending: read_pending(&data_dir).is_some(),
    }
}

/// 清 WebView2 缓存。`sites` 为 true 时连内置浏览器的站点数据一起清。
///
/// 必须 async：几万个文件的遍历与删除会持续几百毫秒以上，同步命令会冻住窗口。
#[tauri::command(async)]
pub fn clean_webview_cache(app: AppHandle, sites: bool) -> WebviewCleanReport {
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());

    let mut freed = 0;
    let mut leftover = 0;

    // 主窗口：`sites` 对它无效，界面自己的主题缓存与语言缓存必须留着
    if let Some(root) = main_profile_root(&app.config().identifier) {
        let (before, after) = sweep_profile(&root, false);
        freed += before - after;
        leftover += after;
    }

    let roots = data_profile_roots(&data_dir);

    // 站点数据必须**删除之前**量：删完再取「含站点 - 不含站点」，两者都归零，差值恒为 0
    let site_before: i64 = if sites {
        roots.iter().map(|r| split_size(r).1).sum()
    } else {
        0
    };

    let (before, after) = sweep_group(&roots, sites);
    freed += before - after;
    leftover += after;

    let site_freed = site_before.min(freed);

    let pending = leftover > 0;
    if pending {
        write_pending(&data_dir, sites);
    } else {
        let _ = std::fs::remove_file(pending_path(&data_dir));
    }

    WebviewCleanReport {
        freed,
        site_freed,
        pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个假 profile：白名单里的缓存目录、站点数据目录、以及列表外的无关文件
    fn make_profile(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "fastnote-webview-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);

        for dir in ["Default/Cache", "Default/Code Cache", "GrShaderCache"] {
            let path = root.join(dir);
            std::fs::create_dir_all(&path).expect("建缓存目录");
            std::fs::write(path.join("blob.bin"), vec![0u8; 1024]).expect("写缓存");
        }
        for dir in ["Default/Network", "Default/Local Storage"] {
            let path = root.join(dir);
            std::fs::create_dir_all(&path).expect("建站点数据目录");
            std::fs::write(path.join("state"), b"cookie").expect("写站点数据");
        }
        // 列表外的东西无论如何都不能碰
        std::fs::create_dir_all(root.join("Default/Extensions")).expect("建扩展目录");
        std::fs::write(root.join("Local State"), b"{}").expect("写 Local State");

        root
    }

    #[test]
    fn cache_only_keeps_site_data() {
        let root = make_profile("cache-only");

        let (before, after) = sweep_profile(&root, false);

        assert_eq!(before, 3 * 1024, "只算三个缓存目录");
        assert_eq!(after, 0, "缓存目录应被删空");
        assert!(!root.join("Default/Cache").exists());
        assert!(root.join("Default/Network").exists(), "站点数据不能删");
        assert!(root.join("Default/Local Storage").exists(), "站点数据不能删");
        assert!(root.join("Default/Extensions").exists(), "白名单外不能删");
        assert!(root.join("Local State").exists(), "白名单外不能删");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sites_flag_removes_site_data() {
        let root = make_profile("with-sites");

        let (before, after) = sweep_profile(&root, true);

        assert_eq!(before, 3 * 1024 + 2 * 6, "缓存 + 两个站点数据目录");
        assert_eq!(after, 0);
        assert!(!root.join("Default/Network").exists());
        assert!(!root.join("Default/Local Storage").exists());
        // 仍然不碰白名单外
        assert!(root.join("Default/Extensions").exists());
        assert!(root.join("Local State").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 标记最多执行 MAX_ATTEMPTS 次，之后自己消失，不会永远留在磁盘上
    #[test]
    fn pending_marker_expires() {
        let dir = std::env::temp_dir().join(format!(
            "fastnote-webview-pending-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建目录");

        write_pending(&dir, false);
        assert!(read_pending(&dir).is_some(), "登记应写入");

        // 没有对应 profile，清理会成功，标记随即删除
        run_pending_cleanup("com.example.none", &dir);
        assert!(read_pending(&dir).is_none(), "全清干净后标记应删除");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
