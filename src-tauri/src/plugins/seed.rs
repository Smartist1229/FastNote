use std::path::Path;
use tauri::{AppHandle, Manager};

use super::manifest::PluginManifest;
use super::storage::{plugins_root, MANIFEST_NAME};

/// 内置插件种子标记（数据目录下）：存在即不再种回，保证卸载后不会被重新安装
const SEED_MARKER: &str = "plugin-seeded-v2";
/// 旧版种子标记（内置插件还是「字数统计」的时代）：迁移后清理
const LEGACY_SEED_MARKER: &str = "plugin-seeded-v1";
/// 旧版内置插件「字数统计」的目录名：只删精确匹配旧内置清单的那一个
const LEGACY_WORD_COUNT_DIR: &str = "word-count";
/// 内置插件「插件演示」的种子文件（编译期嵌入，运行时写到 plugin/plugin-demo/）
const SEED_PLUGIN_DEMO_MANIFEST: &str =
    include_str!("../../builtin-plugins/plugin-demo/plugin.json");
const SEED_PLUGIN_DEMO_MAIN: &str = include_str!("../../builtin-plugins/plugin-demo/main.js");
const SEED_PLUGIN_DEMO_STYLE: &str = include_str!("../../builtin-plugins/plugin-demo/style.css");
const SEED_PLUGIN_DEMO_ICON: &str = include_str!("../../builtin-plugins/plugin-demo/icon.svg");
const SEED_PLUGIN_DEMO_WINDOW: &str = include_str!("../../builtin-plugins/plugin-demo/window.html");
/// 演示插件的模块与语言包文件（多文件 ESM + 插件 i18n 演示）：(插件内相对路径, 文件内容)
const SEED_PLUGIN_DEMO_MODULES: &[(&str, &str)] = &[
    (
        "modules/menus.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/menus.js"),
    ),
    (
        "modules/commands.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/commands.js"),
    ),
    (
        "modules/toolbar.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/toolbar.js"),
    ),
    (
        "modules/effects.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/effects.js"),
    ),
    (
        "modules/modals.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/modals.js"),
    ),
    (
        "modules/hooks.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/hooks.js"),
    ),
    (
        "modules/notes.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/notes.js"),
    ),
    (
        "modules/ai.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/ai.js"),
    ),
    (
        "modules/settingsSection.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/settingsSection.js"),
    ),
    (
        "modules/utils.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/utils.js"),
    ),
    // 新扩展点的演示：自绘弹窗 / 插件私有表 / 快捷键 / 新窗口
    (
        "modules/sourceView.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/sourceView.js"),
    ),
    (
        "modules/prefs.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/prefs.js"),
    ),
    (
        "modules/storage.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/storage.js"),
    ),
    (
        "modules/shortcuts.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/shortcuts.js"),
    ),
    (
        "modules/windows.js",
        include_str!("../../builtin-plugins/plugin-demo/modules/windows.js"),
    ),
    // 语言包：写盘时由循环统一 create_dir_all 创建 locales/ 子目录，
    // 保证种子注入路径与安装校验同样能读到真实文件（否则只会回退空对象、英文失效）
    (
        "locales/zh.json",
        include_str!("../../builtin-plugins/plugin-demo/locales/zh.json"),
    ),
    (
        "locales/en.json",
        include_str!("../../builtin-plugins/plugin-demo/locales/en.json"),
    ),
];

/* ---------------- 内置插件种子 ---------------- */

/**
 * 把内置插件（插件演示）种到 plugin/ 下，只在首次运行时做一次。
 *
 * 标记文件 `plugin-seeded-v2` 写在数据目录：用户卸载内置插件后标记仍在，
 * 下次启动不会重新种回——内置插件和普通插件一样，卸载就是真的卸载。
 * 想装回来走设置页的「安装演示插件」（[`install_demo_plugin`]）。
 * 写入失败时不写标记，下次启动重试；启动流程由 lib.rs 调用，失败只打日志。
 *
 * 开发测试：设置环境变量 `FASTNOTE_FORCE_PLUGIN_SEED=1`（或 `true` / `yes`）
 * 可跳过标记检查，每次启动都把内置插件重写到 plugin/ 目录（目录已存在则覆盖）。
 *
 * 迁移：旧版本种下的「字数统计」只在内置原件精确匹配时删除（避免误删用户自己的
 * 同 id 插件），旧标记 `plugin-seeded-v1` 一并清理。
 */
pub fn seed_builtin_plugins(app: &AppHandle) {
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let marker = data_dir.join(SEED_MARKER);

    let force = std::env::var_os("FASTNOTE_FORCE_PLUGIN_SEED")
        .map(|v| matches!(
            v.to_string_lossy().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        ))
        .unwrap_or(false);

    let root = match plugins_root() {
        Ok(root) => root,
        Err(e) => {
            eprintln!("内置插件未初始化：{e}");
            return;
        }
    };

    let target = root.join("plugin-demo");
    // force 模式下每次都重写全部文件（目录已存在则覆盖，不存在则创建），
    // 这样改了 main.js / plugin.json / style.css / modules/*.js / locales/*.json 后重启就能看到效果。
    // 非 force 模式：内置版本与已安装版本不同（升级 / 回退）时同样重写，
    // 保证内置插件更新后用户能拿到新代码；config.json 不在重写清单里，用户配置不会丢。
    let bundled_version = seed_manifest_version();
    let installed_version = installed_demo_version(&target);
    let needs_upgrade = match (&bundled_version, &installed_version) {
        (Some(b), Some(i)) => b != i,
        (Some(_), None) => true,
        _ => false,
    };

    // 已经种过一次（标记存在）：用户主动删掉演示插件后不再自动恢复，
    // 只有磁盘上仍是旧版本时才按版本差异覆盖升级。
    if !force && marker.exists() && (installed_version.is_none() || !needs_upgrade) {
        return;
    }

    remove_legacy_word_count(&root);
    let _ = std::fs::remove_file(data_dir.join(LEGACY_SEED_MARKER));

    if force || !target.is_dir() || needs_upgrade {
        if let Err(e) = write_demo_plugin(&target) {
            eprintln!("写入内置插件失败：{e}");
            if !force {
                return; // 非强制模式：不写标记，下次启动重试
            }
            // 强制模式下失败仍写标记，避免每次启动都报同一个错
        }
    }
    if let Err(e) = std::fs::write(&marker, b"seeded") {
        eprintln!("写入内置插件标记失败：{e}");
    }
}

/// 手工安装内置演示插件（设置页「刷新」/「安装演示插件」按钮）：
/// 无条件覆盖写一份最新的，config.json 保留；同时补上标记，语义与「已经释放过一次」一致。
///
/// 与启动种子分开：启动种子是「第一次开软件才给」，用户删了就不该再冒出来；
/// 这里是用户明确要求的安装动作，所以永远执行。
pub fn install_demo_plugin(app: &AppHandle) -> Result<(), String> {
    let root = plugins_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建插件目录失败：{e}"))?;
    let target = root.join("plugin-demo");
    write_demo_plugin(&target).map_err(|e| format!("写入演示插件失败：{e}"))?;

    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let _ = std::fs::create_dir_all(&data_dir);
    std::fs::write(data_dir.join(SEED_MARKER), b"seeded")
        .map_err(|e| format!("写入演示插件标记失败：{e}"))?;
    Ok(())
}

/// 把内置演示插件的全部文件写到目标目录（覆盖已有文件，config.json 不在清单里所以不动）
fn write_demo_plugin(target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    std::fs::write(target.join(MANIFEST_NAME), SEED_PLUGIN_DEMO_MANIFEST)?;
    std::fs::write(target.join("main.js"), SEED_PLUGIN_DEMO_MAIN)?;
    std::fs::write(target.join("style.css"), SEED_PLUGIN_DEMO_STYLE)?;
    std::fs::write(target.join("icon.svg"), SEED_PLUGIN_DEMO_ICON)?;
    std::fs::write(target.join("window.html"), SEED_PLUGIN_DEMO_WINDOW)?;
    for (rel, content) in SEED_PLUGIN_DEMO_MODULES {
        let path = target.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
    }
    Ok(())
}

/// 内置演示插件在编译产物里的版本号（从 plugin.json 解析）
fn seed_manifest_version() -> Option<String> {
    serde_json::from_str::<serde_json::Value>(SEED_PLUGIN_DEMO_MANIFEST)
        .ok()?
        .get("version")?
        .as_str()
        .map(|s| s.to_string())
}

/// 已安装演示插件的版本号；读不到返回 None（按“需要写入”处理）
fn installed_demo_version(target: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(target.join(MANIFEST_NAME)).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()?
        .get("version")?
        .as_str()
        .map(|s| s.to_string())
}

/// 删除旧版内置「字数统计」：只有当目录里的 plugin.json 精确匹配旧内置清单
/// （id=word-count、author=FastNote、version=0.1.0）时才删，用户改过或自建的同名
/// 插件一律保留。
fn remove_legacy_word_count(root: &Path) {
    let dir = root.join(LEGACY_WORD_COUNT_DIR);
    let Ok(raw) = std::fs::read(dir.join(MANIFEST_NAME)) else {
        return;
    };
    let Ok(manifest) = serde_json::from_slice::<PluginManifest>(&raw) else {
        return;
    };
    if manifest.id == LEGACY_WORD_COUNT_DIR
        && manifest.author == "FastNote"
        && manifest.version == "0.1.0"
    {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            eprintln!("清理旧内置插件失败：{e}");
        }
    }
}
