use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};

/// 宿主当前支持的插件 API 版本（ctx 契约版本）。加字段不用动它，改语义 / 删字段才 +1
pub(super) const PLUGIN_API_VERSION: u32 = 1;
/// 配置项 schema 的数量上限
const CONFIG_MAX_FIELDS: usize = 32;
/// 配置项 key 的长度上限
const CONFIG_KEY_MAX_LEN: usize = 64;

/// 插件清单（plugin.json 的结构），字段名与前端契约严格一致（camelCase）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// 插件身份（作者声明），不等于目录名
    pub id: String,
    /// 实例键：落盘目录名（JS 侧 camelCase 为 dirName）。zip 解析时为空，
    /// 落盘 / 列目录时填入；前端所有运行时操作都以它为准。
    #[serde(default)]
    pub dir_name: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    /// 插件图标的本应用协议 URL：由宿主按固定文件名探测后填充，插件无需在 plugin.json 里声明
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// 入口脚本，如 "main.js"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    /// 样式文件，如 "style.css"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// JSON 里是 defaultEnabled；未写时默认启用
    #[serde(default = "default_true")]
    pub default_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    /// 插件 API 版本：插件声明自己按哪一版 ctx 契约编写，宿主只接受 <= 自身支持版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_version: Option<u32>,
    /// 允许联网的主机名白名单（ctx.net.fetch）：按主机名或后缀匹配，空表示不允许联网
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub net_domains: Vec<String>,
    /// 运行方式：缺省 "inpage"（跑在主页面，能力全开但要信任插件）；
    /// "sandbox" = 跑在独立源的隐藏 iframe 里，只能通过 RPC 申请能力（安全边界真实）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// 插件名的本地化文本：语言标识 → 文本（缺省回落 name）
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub name_i18n: HashMap<String, String>,
    /// 插件简介的本地化文本（缺省回落 description）
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub description_i18n: HashMap<String, String>,
    /// 标签，仅用于展示
    #[serde(default)]
    pub tags: Vec<String>,
    /// 主页地址
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// 许可证，如 "MIT"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// 配置项 schema：决定 config.json 里允许出现哪些 key、分别是什么类型
    #[serde(default)]
    pub config: Vec<PluginConfigField>,
    /// 插件声明的权限标识符数组（domain.action 点分格式），为空表示不需要特殊权限
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 插件自带语言包：语言标识（如 zh / en）→ 插件目录内的 .json 相对路径
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub i18n: HashMap<String, String>,
}

/// 插件配置项 schema（plugin.json 的 config 数组元素）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigField {
    pub key: String,
    pub label: String,
    /// 各语言下的 label：`{ "en": "Shortcut" }`。
    ///
    /// 没有它的话，设置界面只能拿 `label` 的中文去查**宿主**词典——插件的文案不可能出现在
    /// 宿主词典里，于是英文界面下整片设置项都是中文。留空时回落到 `label` 本身。
    #[serde(default)]
    pub label_i18n: HashMap<String, String>,
    /// "boolean" | "string" | "number" | "select" | "shortcut"
    /// （shortcut 的值与 string 同构，都是 "Ctrl+Alt+P" 这样的组合键字符串，只是宿主用捕获框渲染）
    pub kind: String,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub description: Option<String>,
    /// 各语言下的 description，规则同 label_i18n
    #[serde(default)]
    pub description_i18n: HashMap<String, String>,
    #[serde(default)]
    pub options: Vec<PluginConfigOption>, // kind == select 时用
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
}

/// select 配置项的一个候选值
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigOption {
    pub value: String,
    pub label: String,
    /// 各语言下的候选文案，规则同 `PluginConfigField::label_i18n`
    #[serde(default)]
    pub label_i18n: HashMap<String, String>,
}

fn default_true() -> bool {
    true
}

/* ---------------- manifest 校验 ---------------- */

/// 插件 id 规则：^[a-z0-9][a-z0-9-]{1,63}$（手写字符检查，不引正则依赖）。
/// 注意 id 只是插件身份；目录名（实例键）另由 `validate_dir_name` 校验。
fn validate_plugin_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    let first_ok = bytes
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let rest_ok = bytes.get(1..).is_some_and(|rest| {
        rest.iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    });
    let len_ok = (2..=64).contains(&bytes.len());
    if first_ok && rest_ok && len_ok {
        Ok(())
    } else {
        Err(format!(
            "插件 ID 不合法：「{id}」（需匹配 ^[a-z0-9][a-z0-9-]{{1,63}}$）"
        ))
    }
}

/// entry/style 必须是包内相对路径：非空、不以 / 或盘符开头、不含 .. 段
fn validate_relative_resource(path: &str, field: &str) -> Result<(), String> {
    let p = Path::new(path);
    if path.is_empty()
        || p.is_absolute()
        || path.starts_with('/')
        || path.starts_with('\\')
        || p.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "plugin.json 的 {field} 字段不是合法的相对路径：「{path}」"
        ));
    }
    Ok(())
}

/// i18n 语言包路径：在 entry/style 的相对路径规则之上，额外拒绝反斜杠、
/// 非普通路径段（`.` / `..`），且扩展名只允许 .json。
fn validate_i18n_resource(lang: &str, path: &str) -> Result<(), String> {
    let field = format!("i18n.{lang}");
    validate_relative_resource(path, &field)?;
    let p = Path::new(path);
    if path.contains('\\') || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!(
            "plugin.json 的 {field} 字段不是合法的相对路径：「{path}」"
        ));
    }
    if !path.to_ascii_lowercase().ends_with(".json") {
        return Err(format!(
            "plugin.json 的 {field} 只允许 .json 文件：「{path}」"
        ));
    }
    Ok(())
}

/// 解压后校验 i18n 声明的语言包文件都实际存在于插件目录内；缺失则拒绝安装。
pub(super) fn validate_i18n_files_exist(
    plugin_dir: &Path,
    i18n: &HashMap<String, String>,
) -> Result<(), String> {
    for rel_path in i18n.values() {
        if !plugin_dir.join(rel_path).is_file() {
            return Err(format!("i18n 文件不存在：{rel_path}"));
        }
    }
    Ok(())
}

/// config 里的一项 key：非空、≤64 字符、只允许 [a-zA-Z0-9_.-]
fn validate_config_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("plugin.json 的 config 里存在空 key".into());
    }
    if key.len() > CONFIG_KEY_MAX_LEN {
        return Err(format!(
            "配置项 key 过长：「{key}」（上限 {CONFIG_KEY_MAX_LEN} 个字符）"
        ));
    }
    if !key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return Err(format!(
            "配置项 key 不合法：「{key}」（只允许字母、数字、下划线、点与连字符）"
        ));
    }
    Ok(())
}

/// 值是否与配置项的 kind 对应：boolean=bool、number=数字、string/select/shortcut=字符串
/// （shortcut 只是换了个控件渲染，值仍是组合键字符串）
pub(super) fn value_matches_kind(value: &Value, kind: &str) -> bool {
    match kind {
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "string" | "select" | "shortcut" => value.is_string(),
        _ => false,
    }
}

/// kind 的中文名，用于错误提示
pub(super) fn kind_label(kind: &str) -> &'static str {
    match kind {
        "boolean" => "布尔值",
        "number" => "数字",
        "string" => "字符串",
        "select" => "字符串（选项值）",
        "shortcut" => "组合键字符串（如 Ctrl+Alt+P）",
        _ => "合法值",
    }
}

/// 配置项 schema 校验：key 合法且不重复、kind 在四类之内、select 必须有选项、
/// default 的类型与 kind 对应；数组与 key 都有长度上限。
fn validate_config_schema(fields: &[PluginConfigField]) -> Result<(), String> {
    if fields.len() > CONFIG_MAX_FIELDS {
        return Err(format!(
            "plugin.json 的 config 最多支持 {CONFIG_MAX_FIELDS} 个配置项"
        ));
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for field in fields {
        validate_config_key(&field.key)?;
        if !seen.insert(field.key.as_str()) {
            return Err(format!("配置项 key 重复：「{}」", field.key));
        }
        match field.kind.as_str() {
            "boolean" | "number" | "string" | "shortcut" => {}
            "select" => {
                if field.options.is_empty() {
                    return Err(format!(
                        "配置项「{}」的 kind 是 select，options 不能为空",
                        field.key
                    ));
                }
            }
            other => {
                return Err(format!(
                        "配置项「{}」的 kind 不合法：「{other}」（只支持 boolean / string / number / select / shortcut）",
                        field.key
                    ))
            }
        }
        if let Some(value) = &field.default {
            if !value_matches_kind(value, &field.kind) {
                return Err(format!(
                    "配置项「{}」的默认值与 kind（{}）不匹配，应为{}",
                    field.key,
                    field.kind,
                    kind_label(&field.kind)
                ));
            }
        }
    }
    Ok(())
}

/// 安装前对 plugin.json 的完整性校验（不含权限白名单；权限校验在 plugin_install_zip 单独做）
pub(super) fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    validate_plugin_id(&m.id)?;
    if m.name.trim().is_empty() {
        return Err("plugin.json 的 name 字段不能为空".into());
    }
    if m.version.trim().is_empty() {
        return Err("plugin.json 的 version 字段不能为空".into());
    }
    if let Some(entry) = &m.entry {
        validate_relative_resource(entry, "entry")?;
    }
    if let Some(style) = &m.style {
        validate_relative_resource(style, "style")?;
    }
    for (lang, path) in &m.i18n {
        validate_i18n_resource(lang, path)?;
    }
    validate_config_schema(&m.config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::test_support::{bool_field, config_field, sample_manifest};

    #[test]
    fn i18n_path_validation_accepts_and_rejects() {
        for good in ["locales/zh.json", "locales/en.json", "en.json"] {
            assert!(
                validate_i18n_resource("zh", good).is_ok(),
                "{good} 应被接受"
            );
        }
        for bad in [
            "",
            "../evil.json",
            "locales/../zh.json",
            "/abs.json",
            "locales\\zh.json",
            "locales/zh.txt",
            "locales/zh",
        ] {
            assert!(
                validate_i18n_resource("zh", bad).is_err(),
                "{bad} 应被拒绝"
            );
        }

        let mut m = sample_manifest("with-i18n");
        m.i18n.insert("zh".into(), "locales/zh.json".into());
        m.i18n.insert("en".into(), "locales/en.json".into());
        assert!(validate_manifest(&m).is_ok());

        let mut m = sample_manifest("bad-i18n");
        m.i18n.insert("zh".into(), "../evil.json".into());
        assert!(validate_manifest(&m).is_err());

        let mut m = sample_manifest("bad-ext");
        m.i18n.insert("zh".into(), "locales/zh.txt".into());
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn manifest_validation_accepts_and_rejects() {
        assert!(validate_manifest(&sample_manifest("hello-world")).is_ok());

        // id 规则 ^[a-z0-9][a-z0-9-]{1,63}$
        for bad in ["", "Bad", "-bad", "a", "a b", "带中文"] {
            assert!(validate_manifest(&sample_manifest(bad)).is_err(), "{bad} 应被拒绝");
        }

        let mut m = sample_manifest("good");
        m.name = "   ".into();
        assert!(validate_manifest(&m).is_err());

        let mut m = sample_manifest("good");
        m.entry = Some("../evil.js".into());
        assert!(validate_manifest(&m).is_err());

        let mut m = sample_manifest("good");
        m.style = Some("/abs.css".into());
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn config_schema_validation_rejects_invalid() {
        let mut m = sample_manifest("good");
        m.config = vec![config_field("", "boolean")];
        assert!(validate_manifest(&m).is_err(), "空 key 应被拒绝");

        let mut m = sample_manifest("good");
        m.config = vec![config_field("bad key", "boolean")];
        assert!(validate_manifest(&m).is_err(), "非法字符 key 应被拒绝");

        let mut m = sample_manifest("good");
        m.config = vec![config_field(&"k".repeat(65), "boolean")];
        assert!(validate_manifest(&m).is_err(), "超长 key 应被拒绝");

        let mut m = sample_manifest("good");
        m.config = vec![config_field("kind", "text")];
        assert!(validate_manifest(&m).is_err(), "未知 kind 应被拒绝");

        let mut m = sample_manifest("good");
        m.config = vec![config_field("choice", "select")];
        assert!(validate_manifest(&m).is_err(), "select 无 options 应被拒绝");

        let mut m = sample_manifest("good");
        m.config = vec![config_field("dup", "boolean"), config_field("dup", "string")];
        assert!(validate_manifest(&m).is_err(), "重复 key 应被拒绝");

        // default 类型必须与 kind 对应
        let mut f = config_field("flag", "boolean");
        f.default = Some(serde_json::json!("yes"));
        let mut m = sample_manifest("good");
        m.config = vec![f];
        assert!(validate_manifest(&m).is_err(), "boolean 默认值不能是字符串");

        let mut f = config_field("count", "number");
        f.default = Some(serde_json::json!("3"));
        let mut m = sample_manifest("good");
        m.config = vec![f];
        assert!(validate_manifest(&m).is_err(), "number 默认值不能是字符串");

        let mut f = config_field("name", "string");
        f.default = Some(serde_json::json!(true));
        let mut m = sample_manifest("good");
        m.config = vec![f];
        assert!(validate_manifest(&m).is_err(), "string 默认值不能是布尔值");

        // 数量上限 32
        let mut m = sample_manifest("good");
        m.config = (0..33)
            .map(|i| config_field(&format!("k{i}"), "boolean"))
            .collect();
        assert!(validate_manifest(&m).is_err(), "超过 32 个配置项应被拒绝");

        // 合法 schema（含 select 选项与 number 默认值）
        let mut select = config_field("theme", "select");
        select.default = Some(serde_json::json!("none"));
        select.options = vec![PluginConfigOption {
            value: "none".into(),
            label: "不修改".into(),
            label_i18n: Default::default(),
        }];
        let mut number = config_field("scale", "number");
        number.default = Some(serde_json::json!(0.5));
        let mut m = sample_manifest("good");
        m.config = vec![bool_field("menuEnabled", true), select, number];
        assert!(validate_manifest(&m).is_ok());
    }
}

/// 极简版本比较：按 `.` 切分，数字段按数值比，非数字段按字典序。
/// 只用于「装得上吗」这种粗判断，不追求 semver 预发布规则。
pub(super) fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let pa: Vec<&str> = a.trim().split('.').collect();
    let pb: Vec<&str> = b.trim().split('.').collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or("0");
        let y = pb.get(i).copied().unwrap_or("0");
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            _ => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    Ordering::Equal
}

/// 安装前的兼容性校验：插件 API 版本不能高于宿主，minAppVersion 不能高于当前软件版本。
/// 手工拷进插件目录的插件不过这一关，宿主激活时还会再查一次（见 host.ts）。
pub(super) fn validate_compatibility(manifest: &PluginManifest, app_version: &str) -> Result<(), String> {
    if let Some(api) = manifest.api_version {
        if api > PLUGIN_API_VERSION {
            return Err(format!(
                "这个插件要求插件 API v{api}，当前软件只支持 v{PLUGIN_API_VERSION}，请先升级 FastNote"
            ));
        }
    }
    if let Some(required) = manifest.min_app_version.as_deref() {
        if !required.trim().is_empty()
            && compare_versions(app_version, required.trim()) == std::cmp::Ordering::Less
        {
            return Err(format!(
                "这个插件要求 FastNote ≥ {required}，当前是 {app_version}，请先升级软件"
            ));
        }
    }
    Ok(())
}
