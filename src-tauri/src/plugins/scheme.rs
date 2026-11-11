use std::path::{Component, Path, PathBuf};

use super::storage::plugins_root;

/* ---------------- 插件模块自定义协议（fastnote-plugin） ----------------
 * 插件 entry 通过「完整 URL + 动态 import」加载，而不是读文本转 Blob URL——
 * Blob URL 是 opaque path，`import "./modules/utils.js"` 这类相对路径解析不到
 * 任何真实文件，插件只能写单文件。注册自定义协议后，插件文件以真实 URL 形式
 * serve 给 webview，浏览器原生 ESM 相对路径解析即可工作，插件可以拆成多文件。
 *
 * 协议 URL 的平台差异（Tauri 对 wry 各后端的封装差异）：
 *   - Windows / Android：http://fastnote-plugin.localhost/<dirName>/<path>
 *   - macOS / Linux / iOS：fastnote-plugin://localhost/<dirName>/<path>
 * handler 只取 URI 的 path 部分，两种形式下都是 /<dirName>/<relPath>。
 *
 * 安全边界：只 serve 插件根目录内的 .js/.mjs，目录名与相对路径都过白名单校验，
 * canonical 复核防逃逸，单文件 ≤ 2MB。
 */

/// 协议名（lib.rs 里 register_uri_scheme_protocol 注册用）
pub(crate) const PLUGIN_SCHEME: &str = "fastnote-plugin";

/// 单个模块文件的大小上限（2MB）
const MODULE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 单个插件图标文件的大小上限（4MB）
const ICON_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// 插件图标固定文件名，按优先级从高到低；只认这些名字，且必须位于插件根目录
const PLUGIN_ICON_FILES: &[&str] = &["icon.png", "icon.svg", "icon.webp", "icon.jpg"];

/// 协议 URL 的平台前缀（编译期确定）
#[cfg(any(target_os = "windows", target_os = "android"))]
const PLUGIN_SCHEME_ORIGIN: &str = "http://fastnote-plugin.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
const PLUGIN_SCHEME_ORIGIN: &str = "fastnote-plugin://localhost";

/// 协议 handler 的错误：HTTP 状态码 + 简短中文提示
#[derive(Debug)]
struct SchemeError {
    status: u16,
    message: String,
}

impl SchemeError {
    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: 403,
            message: message.into(),
        }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            message: message.into(),
        }
    }
}

/// 协议路径里的目录名校验：^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$。
/// 比 validate_dir_name 宽松（允许大写与下划线）：白名单字符集本身排除了
/// 路径分隔符与 `..`，不会引入路径风险。
pub(super) fn validate_module_dir_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    let ok = bytes.first().is_some_and(|b| b.is_ascii_alphanumeric())
        && (1..=64).contains(&bytes.len())
        && bytes
            .iter()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "插件目录名不合法：「{name}」（需匹配 ^[a-zA-Z0-9][a-zA-Z0-9_-]{{0,63}}$）"
        ))
    }
}

/// 是否为允许的插件图标文件：只认插件根目录下的固定文件名（不区分大小写）
fn is_plugin_icon_file(rel_path: &str) -> bool {
    PLUGIN_ICON_FILES
        .iter()
        .any(|name| rel_path.eq_ignore_ascii_case(name))
}

/// 沙箱运行时页面（宿主内置，通过 `/<目录名>/__runtime.html` 提供）：
/// 不落盘、不可被插件覆盖——插件目录里就算放了同名文件也读不到，先拦后读。
pub(super) const SANDBOX_RUNTIME_PATH: &str = "__runtime.html";
const SANDBOX_RUNTIME_HTML: &str = include_str!("runtime.html");

/// 协议允许 serve 的静态资源扩展名：
///   - .js / .mjs：插件模块（动态 import）；
///   - .html：插件自己的窗口页面（ctx.window.open）；
///   - .css：插件窗口 / 页面的样式；
///   - .json：插件自带的数据文件；
///   - 图片：插件窗口里的素材。
/// 其余一律拒绝（不 serve 宿主可执行文件、不 serve 任意文本）。
const STATIC_ASSETS: &[&str] = &[
    "js", "mjs", "html", "htm", "css", "json", "svg", "png", "webp", "jpg", "jpeg", "gif", "woff2",
    "woff", "ttf",
];

/// 协议路径的 Content-Type：按扩展名给，未知扩展名按纯文本处理（不会走到这里，白名单已挡）
fn content_type_for(rel_path: &str) -> &'static str {
    let lower = rel_path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".ttf") {
        "font/ttf"
    } else {
        "text/javascript; charset=utf-8"
    }
}

/// 模块相对路径校验：必须是插件目录内的静态资源（见 STATIC_ASSETS），
/// 或插件根目录下的固定图标文件——拒绝空 / 过长 / 反斜杠 / 绝对路径 / `..` 与 `.` 段。
fn validate_module_rel_path(rel_path: &str) -> Result<(), String> {
    let path = Path::new(rel_path);
    if rel_path.is_empty()
        || rel_path.len() > 512
        || rel_path.contains('\\')
        || rel_path.starts_with('/')
        || path.is_absolute()
        || !path.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("非法的插件资源路径：「{rel_path}」"));
    }
    let allowed = Path::new(rel_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| STATIC_ASSETS.contains(&ext.as_str()));
    if !allowed && !is_plugin_icon_file(rel_path) {
        return Err(format!(
            "插件协议只允许 {} 类型的文件或插件根目录的固定图标：「{rel_path}」",
            STATIC_ASSETS.join(" / ")
        ));
    }
    Ok(())
}

/// 百分号解码 URL path（模块文件名可能带空格等非 ASCII 字符）。
/// 拒绝孤立的 %、非法十六进制与非 UTF-8 结果。
fn percent_decode_path(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = bytes.get(i + 1..i + 3).ok_or(())?;
            let hi = (pair[0] as char).to_digit(16).ok_or(())?;
            let lo = (pair[1] as char).to_digit(16).ok_or(())?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// 百分号编码单个路径段：RFC 3986 unreserved 字符原样保留，其余按 UTF-8 编 %XX。
/// 与 percent_decode_path 互逆，plugin_module_url 生成 URL 时用。
fn percent_encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for &b in segment.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 去掉可选的版本段：`v12/modules/utils.js` → `modules/utils.js`。
/// 版本段由 build_module_url 在「重新激活」时生成，目的是让整张模块图换 URL——
/// 只给 entry 加 `?v=` 的话，子模块 URL 不变，webview 会一直用缓存里的旧代码
/// （改完插件子模块不重启就看不到效果，就是这么来的）。
fn strip_version_segment(rel: &str) -> &str {
    let Some(rest) = rel.strip_prefix('v') else {
        return rel;
    };
    let Some((digits, tail)) = rest.split_once('/') else {
        return rel;
    };
    if !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !tail.is_empty()
    {
        tail
    } else {
        rel
    }
}

/// 从协议 URI 的 path（形如 /<dirName>/[v<版本>/]<relPath>）解析并校验出（dirName, relPath）
fn parse_scheme_path(raw_path: &str) -> Result<(String, String), SchemeError> {
    let decoded = percent_decode_path(raw_path)
        .map_err(|_| SchemeError::forbidden("插件模块路径不是合法的百分号编码"))?;
    let trimmed = decoded.strip_prefix('/').unwrap_or(decoded.as_str());
    let (dir_name, rest) = trimmed
        .split_once('/')
        .ok_or_else(|| SchemeError::forbidden("插件模块路径需为 /<目录名>/<相对路径>"))?;
    validate_module_dir_name(dir_name).map_err(SchemeError::forbidden)?;
    let rel_path = strip_version_segment(rest);
    validate_module_rel_path(rel_path).map_err(SchemeError::forbidden)?;
    Ok((dir_name.to_string(), rel_path.to_string()))
}

/// 把（dirName, relPath）解析成磁盘上的真实文件：先过同一套校验（纵深防御），
/// 再 canonicalize 复核解析结果仍在插件根目录内（防符号链接等逃逸）。
fn resolve_module_in(root: &Path, dir_name: &str, rel_path: &str) -> Result<PathBuf, SchemeError> {
    validate_module_dir_name(dir_name).map_err(SchemeError::forbidden)?;
    validate_module_rel_path(rel_path).map_err(SchemeError::forbidden)?;
    let root_canonical = root
        .canonicalize()
        .map_err(|_| SchemeError::not_found("插件根目录不可用"))?;
    let target = root.join(dir_name).join(rel_path);
    let target_canonical = target
        .canonicalize()
        .map_err(|_| SchemeError::not_found(format!("插件模块不存在：{rel_path}")))?;
    if !target_canonical.starts_with(&root_canonical) || !target_canonical.is_file() {
        return Err(SchemeError::not_found(format!("插件模块不存在：{rel_path}")));
    }
    Ok(target_canonical)
}

/// 读取模块 / 图标文件内容：脚本 ≤ 2MB，图片 ≤ 4MB
fn read_module_bytes(path: &Path, rel_path: &str) -> Result<Vec<u8>, SchemeError> {
    let limit = if is_plugin_icon_file(rel_path) {
        ICON_MAX_BYTES
    } else {
        MODULE_MAX_BYTES
    };
    let size = std::fs::metadata(path)
        .map_err(|e| SchemeError::not_found(format!("读取插件模块失败：{e}")))?
        .len();
    if size > limit {
        return Err(SchemeError::forbidden(format!(
            "插件文件过大：{size} 字节（上限 {limit} 字节）"
        )));
    }
    std::fs::read(path).map_err(|e| SchemeError::not_found(format!("读取插件模块失败：{e}")))
}

/// fastnote-plugin 协议的请求 handler：把插件目录内的 .js/.mjs 以 ESM 形式、插件根目录
/// 固定图标文件以图片形式 serve 给 webview。路径校验失败 403，文件不存在 404；
/// 成功 200 + `Cache-Control: no-store`
/// （重新激活时拿到新代码）+ `Access-Control-Allow-Origin: *`（Windows 上模块加载
/// 相对主窗口是跨源请求，模块脚本走 CORS，没有这个头会被 webview 拦下；
/// 该协议只在本应用的 webview 内可达，放行无额外暴露面）。
pub fn handle_plugin_scheme_request(
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let result = parse_scheme_path(request.uri().path()).and_then(|(dir_name, rel_path)| {
        // 沙箱运行时：宿主内置页面，直接返回，不去磁盘上找
        if rel_path == SANDBOX_RUNTIME_PATH {
            validate_module_dir_name(&dir_name).map_err(SchemeError::forbidden)?;
            return Ok((
                SANDBOX_RUNTIME_HTML.as_bytes().to_vec(),
                "text/html; charset=utf-8",
            ));
        }
        let root = plugins_root().map_err(SchemeError::forbidden)?;
        let path = resolve_module_in(&root, &dir_name, &rel_path)?;
        let bytes = read_module_bytes(&path, &rel_path)?;
        Ok((bytes, content_type_for(&rel_path)))
    });
    match result {
        Ok((bytes, content_type)) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .expect("构建插件模块响应失败"),
        Err(err) => tauri::http::Response::builder()
            .status(err.status)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(err.message.into_bytes())
            .expect("构建插件模块响应失败"),
    }
}

/// 拼插件模块 / 图标的完整协议 URL：dirName/relPath 与 handler 同一套校验，
/// 这里通不过的输入 handler 也一定会拒绝；路径段逐个百分号编码，与解码侧互逆。
pub(super) fn build_module_url(
    dir_name: &str,
    rel_path: &str,
    version: Option<u64>,
) -> Result<String, String> {
    validate_module_dir_name(dir_name)?;
    validate_module_rel_path(rel_path)?;
    let encoded = rel_path
        .split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    // 版本段参与 URL，子模块的相对 import 也会带上它（相对解析基于入口的目录）——
    // 重新激活时整张模块图换 URL，旧缓存自然失效
    let version_segment = version.map(|v| format!("/v{v}")).unwrap_or_default();
    Ok(format!(
        "{PLUGIN_SCHEME_ORIGIN}/{dir_name}{version_segment}/{encoded}"
    ))
}

/// 在插件目录根下按固定优先级找图标文件名；都没有时返回 None
fn find_plugin_icon(plugin_dir: &Path) -> Option<&'static str> {
    PLUGIN_ICON_FILES
        .iter()
        .copied()
        .find(|name| plugin_dir.join(name).is_file())
}

/// 生成插件图标 URL：图标不存在或目录名不合法时返回 None（前端回落到默认图标）
pub(super) fn plugin_icon_url_in(plugin_dir: &Path, dir_name: &str) -> Option<String> {
    let icon = find_plugin_icon(plugin_dir)?;
    // 图标不参与版本化：它不随重新激活变化，缓不缓存都行
    build_module_url(dir_name, icon, None).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::test_support::temp_root;

    #[test]
    fn module_dir_name_rules() {
        for good in ["plugin-demo", "My_Plugin2", "a"] {
            assert!(validate_module_dir_name(good).is_ok(), "{good} 应被接受");
        }
        for bad in ["", "-bad", "_bad", "a/b", "a\\b", "a..b", "a b", "带中文"] {
            assert!(validate_module_dir_name(bad).is_err(), "{bad} 应被拒绝");
        }
        assert!(validate_module_dir_name(&"a".repeat(64)).is_ok());
        assert!(validate_module_dir_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn module_rel_path_rules() {
        for good in [
            "main.js",
            "modules/utils.js",
            "a/b/c.mjs",
            "main.JS",
            // 插件窗口要用的静态资源
            "window.html",
            "style.css",
            "data.json",
            "assets/logo.svg",
        ] {
            assert!(validate_module_rel_path(good).is_ok(), "{good} 应被接受");
        }
        for bad in [
            "",
            "../evil.js",
            "..\\evil.js",
            "/abs.js",
            "C:\\x.js",
            "modules/../x.js",
            "./main.js",
            // 可执行文件 / 未知类型一律不放行
            "tool.exe",
            "run.bat",
            "main.txt",
            "main",
        ] {
            assert!(validate_module_rel_path(bad).is_err(), "{bad} 应被拒绝");
        }
        assert!(validate_module_rel_path(&format!("{}.js", "a".repeat(509))).is_ok());
        assert!(validate_module_rel_path(&format!("{}.js", "a".repeat(510))).is_err());
    }

    #[test]
    fn percent_codec_roundtrip() {
        // 无需编码的 ASCII 原样通过
        assert_eq!(
            percent_decode_path("/plugin-demo/main.js").as_deref(),
            Ok("/plugin-demo/main.js")
        );
        // UTF-8 百分号编码可解出中文
        assert_eq!(
            percent_decode_path("/plugin-demo/modules/%E5%B7%A5%E5%85%B7.js").as_deref(),
            Ok("/plugin-demo/modules/工具.js")
        );
        // 非法十六进制、孤立 %、非 UTF-8 序列都拒绝
        assert!(percent_decode_path("/p/%zz.js").is_err());
        assert!(percent_decode_path("/p/%4.js").is_err());
        assert!(percent_decode_path("/p/%e4.js").is_err());
        // 编码与解码互逆；unreserved 字符不编码
        let seg = "我的 模块.mjs";
        assert_eq!(percent_decode_path(&percent_encode_segment(seg)).ok(), Some(seg.to_string()));
        assert_eq!(percent_encode_segment("utils.js"), "utils.js");
    }

    #[test]
    fn parse_scheme_path_validation() {
        let (dir, rel) = parse_scheme_path("/plugin-demo/modules/utils.js").unwrap();
        assert_eq!(dir, "plugin-demo");
        assert_eq!(rel, "modules/utils.js");
        // 百分号编码的路径段也能解析
        let (dir, rel) = parse_scheme_path("/plugin-demo/%E5%B7%A5%E5%85%B7.js").unwrap();
        assert_eq!(dir, "plugin-demo");
        assert_eq!(rel, "工具.js");
        // 版本段（重新激活时生成）会被剥掉，解析到同一个文件
        let (dir, rel) = parse_scheme_path("/plugin-demo/v7/modules/utils.js").unwrap();
        assert_eq!(dir, "plugin-demo");
        assert_eq!(rel, "modules/utils.js");
        // 非「v + 数字」的目录名不当版本段，原样当普通路径
        let (_, rel) = parse_scheme_path("/plugin-demo/vabc/main.js").unwrap();
        assert_eq!(rel, "vabc/main.js");
        // 缺 relPath
        assert!(parse_scheme_path("/plugin-demo").is_err());
        assert!(parse_scheme_path("/plugin-demo/").is_err());
        assert!(parse_scheme_path("/").is_err());
        // 路径穿越、非 js、目录名不合法一律 403
        assert_eq!(parse_scheme_path("/plugin-demo/../secret.js").unwrap_err().status, 403);
        assert_eq!(parse_scheme_path("/plugin-demo/tool.exe").unwrap_err().status, 403);
        // 插件窗口的静态资源是放行的
        assert!(parse_scheme_path("/plugin-demo/style.css").is_ok());
        assert_eq!(parse_scheme_path("/bad%20dir/main.js").unwrap_err().status, 403);
    }

    #[test]
    fn resolve_module_stays_inside_root() {
        let root = temp_root("scheme-resolve");
        let dir = root.join("plugin-demo");
        std::fs::create_dir_all(dir.join("modules")).unwrap();
        std::fs::write(dir.join("main.js"), "// main").unwrap();
        std::fs::write(dir.join("modules/utils.js"), "// utils").unwrap();
        // 插件根目录下、插件目录外的文件：任何方式都不该被 serve 进插件模块
        std::fs::write(root.join("outside.js"), "// outside").unwrap();

        let ok = resolve_module_in(&root, "plugin-demo", "main.js").unwrap();
        assert!(ok.ends_with("main.js"));
        assert!(resolve_module_in(&root, "plugin-demo", "modules/utils.js").is_ok());
        // .. 穿越在校验阶段就拒绝（不依赖文件是否存在）
        assert_eq!(
            resolve_module_in(&root, "plugin-demo", "../outside.js").unwrap_err().status,
            403
        );
        // 不存在的文件 404
        assert_eq!(
            resolve_module_in(&root, "plugin-demo", "nope.js").unwrap_err().status,
            404
        );
        // 静态资源（插件窗口用）允许读取，可执行文件仍然 403
        std::fs::write(dir.join("style.css"), "/* css */").unwrap();
        assert!(resolve_module_in(&root, "plugin-demo", "style.css").is_ok());
        std::fs::write(dir.join("tool.exe"), b"x").unwrap();
        assert_eq!(
            resolve_module_in(&root, "plugin-demo", "tool.exe").unwrap_err().status,
            403
        );
    }

    #[test]
    fn module_url_format_and_validation() {
        let url = build_module_url("plugin-demo", "modules/utils.js", None).unwrap();
        assert!(
            url.starts_with(PLUGIN_SCHEME_ORIGIN),
            "URL 应使用当前平台的协议前缀：{url}"
        );
        assert!(url.ends_with("/plugin-demo/modules/utils.js"));
        // 含中文的段会被百分号编码
        let url = build_module_url("plugin-demo", "模块.js", None).unwrap();
        assert!(url.ends_with("/plugin-demo/%E6%A8%A1%E5%9D%97.js"), "{url}");
        // 静态资源可以生成 URL（插件窗口要用），未知扩展名仍然拒绝
        assert!(build_module_url("plugin-demo", "style.css", None)
            .unwrap()
            .ends_with("/plugin-demo/style.css"));
        assert!(build_module_url("plugin-demo", "tool.exe", None).is_err());
        // 带版本时版本段落在目录名后面，子模块的相对解析会跟着带上
        assert!(build_module_url("plugin-demo", "modules/utils.js", Some(12))
            .unwrap()
            .ends_with("/plugin-demo/v12/modules/utils.js"));
        assert!(build_module_url("plugin-demo", "../x.js", None).is_err());
        assert!(build_module_url("bad dir", "main.js", None).is_err());
    }

    #[test]
    fn icon_file_rules_and_content_types() {
        for good in [
            "icon.png",
            "icon.svg",
            "icon.webp",
            "icon.jpg",
            "main.js",
            "modules/utils.mjs",
            "icon.gif",
            // 普通图片（插件窗口素材）也是合法静态资源，只管「能不能读」，与「是不是图标」无关
            "logo.png",
        ] {
            assert!(validate_module_rel_path(good).is_ok(), "{good} 应被接受");
        }
        for bad in [
            "icon.ico",
            "ICON.PNG.bak",
            // 可执行 / 未知类型
            "tool.exe",
        ] {
            assert!(validate_module_rel_path(bad).is_err(), "{bad} 应被拒绝");
        }
        assert_eq!(content_type_for("icon.png"), "image/png");
        assert_eq!(content_type_for("icon.svg"), "image/svg+xml");
        assert_eq!(content_type_for("icon.webp"), "image/webp");
        assert_eq!(content_type_for("icon.jpg"), "image/jpeg");
        assert_eq!(
            content_type_for("main.js"),
            "text/javascript; charset=utf-8"
        );
    }

    #[test]
    fn plugin_icon_url_prefers_fixed_name_and_ignores_others() {
        let root = temp_root("icon-url");
        let dir = root.join("plugin-demo");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(plugin_icon_url_in(&dir, "plugin-demo").is_none());

        std::fs::write(dir.join("icon.svg"), "<svg/>").unwrap();
        let url = plugin_icon_url_in(&dir, "plugin-demo").unwrap();
        assert!(url.starts_with(PLUGIN_SCHEME_ORIGIN), "{url}");
        assert!(url.ends_with("/plugin-demo/icon.svg"));

        // 非固定文件名不会被当作图标
        std::fs::write(dir.join("logo.png"), b"x").unwrap();
        assert!(plugin_icon_url_in(&dir, "plugin-demo")
            .unwrap()
            .ends_with("/icon.svg"));

        // png 优先级高于 svg
        std::fs::write(dir.join("icon.png"), b"x").unwrap();
        assert!(plugin_icon_url_in(&dir, "plugin-demo")
            .unwrap()
            .ends_with("/icon.png"));

        // handler 的解析与读取同样接受固定图标文件
        assert!(resolve_module_in(&root, "plugin-demo", "icon.png").is_ok());
        // 子目录里的 icon.svg 不算「图标」（不返回 icon URL），但作为普通静态资源可以读
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/icon.svg"), "<svg/>").unwrap();
        assert!(resolve_module_in(&root, "plugin-demo", "assets/icon.svg").is_ok());
    }
}
