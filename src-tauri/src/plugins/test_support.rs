use std::collections::HashMap;
use std::path::PathBuf;

use super::manifest::{PluginConfigField, PluginManifest};

pub(super) fn sample_manifest(id: &str) -> PluginManifest {
    PluginManifest {
        id: id.to_string(),
        dir_name: String::new(),
        name: "示例插件".into(),
        version: "1.0.0".into(),
        author: String::new(),
        description: String::new(),
        icon_url: None,
        entry: Some("main.js".into()),
        style: None,
        default_enabled: true,
        min_app_version: None,
        tags: Vec::new(),
        homepage: None,
        license: None,
        config: Vec::new(),
        permissions: Vec::new(),
        i18n: HashMap::new(),
    }
}

pub(super) fn config_field(key: &str, kind: &str) -> PluginConfigField {
    PluginConfigField {
        key: key.into(),
        label: key.into(),
        kind: kind.into(),
        default: None,
        description: None,
        options: Vec::new(),
        min: None,
        max: None,
        step: None,
    }
}

pub(super) fn bool_field(key: &str, default: bool) -> PluginConfigField {
    let mut f = config_field(key, "boolean");
    f.default = Some(serde_json::json!(default));
    f
}

pub(super) fn string_field(key: &str, default: &str) -> PluginConfigField {
    let mut f = config_field(key, "string");
    f.default = Some(serde_json::json!(default));
    f
}

/// 两个配置项的 schema：menuEnabled(boolean)、greeting(string)
pub(super) fn demo_schema() -> Vec<PluginConfigField> {
    vec![
        bool_field("menuEnabled", true),
        string_field("greeting", "你好"),
    ]
}

/// 带 config 数组的 plugin.json 文本
pub(super) fn manifest_with_config(id: &str, version: &str, config: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"示例插件","version":"{version}","author":"FastNote","entry":"main.js","config":{config}}}"#
    )
}

/// 独占的临时根目录：用例间互不干扰，跑完不自动清理（系统会回收 temp）
pub(super) fn temp_root(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("fastnote-plugin-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
