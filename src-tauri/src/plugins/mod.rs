/* ---------------- 插件系统 ----------------
 * 插件包是一个 zip，特征文件是 plugin.json（没有它不算合法插件）。
 * 两种包内布局都认：
 *   1. 根目录直接放 plugin.json + 资源文件；
 *   2. 只有一个顶层文件夹包着 plugin.json（例如 GitHub「Download ZIP」的产物）。
 * 安装 = 解压到 <exe 同级>/plugin/<目录名>/，每个插件一个子目录。
 *
 * 两个标识的语义必须分清（改这里前先看明白）：
 *   - plugin.json 的 `id`：插件的**身份**，由作者声明，不同作者可能撞用同一个 id；
 *   - 目录名 `dirName`：插件的**实例键**，落盘后唯一的目录名。前端所有运行时操作
 *     （启用状态、卸载、读资源、注册贡献）一律用 dirName，绝不拿 id 当主键。
 * 安装时决定目录名：
 *   - 已存在同 id 且 author 相同（trim + 忽略大小写，均为空也算相同）→ 复用该目录整体覆盖，
 *     即升级/降级（不做 semver 比较）；
 *   - 同 id 但 author 不同 → `<id>-<6位十六进制>`，循环避开已有目录（撞名插件互不覆盖）；
 *   - 没有同 id → 用 `id` 作目录名。
 */

mod install;
mod manifest;
mod permissions;
mod scheme;
mod seed;
mod storage;
#[cfg(test)]
mod test_support;

pub use manifest::*;
pub use permissions::*;
pub use scheme::handle_plugin_scheme_request;
pub use seed::seed_builtin_plugins;
pub(crate) use scheme::PLUGIN_SCHEME;
pub(crate) use storage::{load_installed_manifest, plugins_root};

use serde_json::Value;
use tauri::AppHandle;

use install::{install_opened, list_installed_in, open_plugin_zip, resolve_target_dir_name};
use scheme::{build_module_url, plugin_icon_url_in, validate_module_dir_name};
use storage::{read_config_in, read_resource_in, validate_dir_name, write_config_in};

/* ---------------- Tauri 命令 ---------------- */

/// 列出已安装插件：扫描 plugin/ 下每个子目录的 plugin.json，成功解析并校验的
/// 填入 dirName（= 子目录名）；解析失败的目录跳过，不中断整体。
#[tauri::command]
pub fn plugin_list_installed(_app: AppHandle) -> Vec<PluginManifest> {
    let dir = match plugins_root() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("{e}");
            return Vec::new();
        }
    };
    // plugin/ 目录不存在时按需创建（失败也无妨，read_dir 会得到空列表）
    let _ = std::fs::create_dir_all(&dir);
    list_installed_in(&dir)
}

/// 安装插件包（zip）：定位并校验 plugin.json 后按目录规则落盘，返回带 dirName 的清单。
/// skip_confirm=true 时跳过权限白名单校验（供内部可信场景使用）；默认 false 严格校验。
#[tauri::command]
pub fn plugin_install_zip(
    _app: AppHandle,
    zip_path: String,
    skip_confirm: Option<bool>,
) -> Result<PluginManifest, String> {
    let dir = plugins_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    // 先走一遍 open_plugin_zip 拿到清单，这样可以先做权限校验再落盘
    let opened = open_plugin_zip(&zip_path)?;
    if !skip_confirm.unwrap_or(false) {
        validate_permissions(&opened.manifest.permissions)?;
    }
    let dir_name = resolve_target_dir_name(&dir, &opened.manifest);
    let target = dir.join(&dir_name);
    install_opened(opened, &target, &dir_name)
}

/// 插件目录路径：确保目录存在后返回字符串。
/// 前端拿它调用已有的 open_app_folder 打开（该命令放行 exe 目录，插件目录在其下）。
#[tauri::command]
pub fn plugin_folder_path() -> Result<String, String> {
    let dir = plugins_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 卸载插件：校验目录名（实例键）后删除 <plugin>/<dirName>。
/// 目录本就不存在时视为已卸载，返回成功。
#[tauri::command]
pub fn plugin_uninstall(_app: AppHandle, dir_name: String) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    let target = plugins_root()?.join(&dir_name);
    if !target.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&target).map_err(|e| format!("卸载插件失败：{e}"))
}

/// 读取插件目录内的文本资源（main.js / style.css 等）。
/// 防目录穿越：拒绝含 .. 的路径，并 canonicalize 复核解析结果仍在插件目录内。
#[tauri::command]
pub fn plugin_read_resource(
    _app: AppHandle,
    dir_name: String,
    rel_path: String,
) -> Result<String, String> {
    validate_dir_name(&dir_name)?;
    let plugin_dir = plugins_root()?.join(&dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    read_resource_in(&plugin_dir, &rel_path)
}

/// 读取插件配置（plugin_read_config）：config.json 不存在时按空对象处理，
/// 与 schema 的 defaults 合并（存储值优先），只返回 schema 声明的 key。
#[tauri::command]
pub fn plugin_read_config(_app: AppHandle, dir_name: String) -> Result<Value, String> {
    validate_dir_name(&dir_name)?;
    let plugin_dir = plugins_root()?.join(&dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    let manifest = load_installed_manifest(&plugin_dir)?;
    read_config_in(&plugin_dir, &manifest.config)
}

/// 写入插件配置（plugin_write_config）：必须是 JSON 对象；只写 schema 声明的 key，
/// 类型必须与 kind 对应；pretty JSON 原子落盘，不触发其他副作用。
#[tauri::command]
pub fn plugin_write_config(
    _app: AppHandle,
    dir_name: String,
    config: Value,
) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    let plugin_dir = plugins_root()?.join(&dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    let manifest = load_installed_manifest(&plugin_dir)?;
    write_config_in(&plugin_dir, &manifest.config, &config)
}

/// 生成插件模块的完整协议 URL（前端动态 import 用）：
/// Windows / Android 为 http://fastnote-plugin.localhost/<dirName>/<path>，
/// 其余平台为 fastnote-plugin://localhost/<dirName>/<path>。
#[tauri::command]
pub fn plugin_module_url(
    _app: AppHandle,
    dir_name: String,
    rel_path: String,
) -> Result<String, String> {
    build_module_url(&dir_name, &rel_path)
}

/// 探测已安装插件的图标并返回完整协议 URL：按 icon.png → icon.svg → icon.webp → icon.jpg
/// 的优先级取第一个存在的文件；都不存在返回 None。只读操作，无需权限校验。
#[tauri::command]
pub fn plugin_icon_url(dir_name: String) -> Option<String> {
    validate_module_dir_name(&dir_name).ok()?;
    let root = plugins_root().ok()?;
    plugin_icon_url_in(&root.join(&dir_name), &dir_name)
}
