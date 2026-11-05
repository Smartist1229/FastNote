use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};

use super::manifest::{
    kind_label, validate_manifest, value_matches_kind, PluginConfigField, PluginManifest,
};

/// 已安装插件的根目录名（exe 同级）
pub(super) const PLUGINS_DIR: &str = "plugin";
/// 插件特征文件：包里必须有它才算合法插件
pub(super) const MANIFEST_NAME: &str = "plugin.json";
/// 插件配置文件：与 plugin.json 同级，保存用户可改的插件配置
pub(super) const CONFIG_NAME: &str = "config.json";
/// 配置序列化后的上限（256KB）
const CONFIG_MAX_BYTES: usize = 256 * 1024;

/// 插件根目录：exe 同级的 plugin/（软件安装目录下，用户可直接查看与替换）。
pub(crate) fn plugins_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位软件安装目录：{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法定位软件安装目录：exe 路径没有父目录".to_string())?;
    Ok(dir.join(PLUGINS_DIR))
}

/// 目录名（实例键）校验：只允许 [a-z0-9-]、长度 ≤ 80。
/// 白名单天然排除 `..`、绝对路径与盘符，保证拼出来的路径不会跑出插件根目录。
pub(super) fn validate_dir_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 80 {
        return Err(format!("插件目录名不合法：「{name}」（长度需为 1–80）"));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(format!(
            "插件目录名不合法：「{name}」（只允许小写字母、数字与连字符）"
        ));
    }
    Ok(())
}

pub(super) fn read_resource_in(plugin_dir: &Path, rel_path: &str) -> Result<String, String> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty() {
        return Err("插件资源路径不能为空".into());
    }
    let rel = Path::new(trimmed);
    if rel.is_absolute()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || rel.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("非法的插件资源路径：{rel_path}"));
    }
    let dir_canonical = plugin_dir
        .canonicalize()
        .map_err(|e| format!("插件目录不可用：{e}"))?;
    let target = plugin_dir.join(rel);
    let target_canonical = target
        .canonicalize()
        .map_err(|_| format!("插件资源不存在：{rel_path}"))?;
    if !target_canonical.starts_with(&dir_canonical) {
        return Err(format!("非法的插件资源路径：{rel_path}"));
    }
    std::fs::read_to_string(&target_canonical).map_err(|e| format!("读取插件资源失败：{e}"))
}

/// 读取已安装插件的 plugin.json（解析 + 校验），供配置命令取 schema
pub(crate) fn load_installed_manifest(plugin_dir: &Path) -> Result<PluginManifest, String> {
    let raw = std::fs::read(plugin_dir.join(MANIFEST_NAME))
        .map_err(|e| format!("读取插件清单失败：{e}"))?;
    let manifest: PluginManifest =
        serde_json::from_slice(&raw).map_err(|e| format!("插件清单解析失败：{e}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/* ---------------- config.json 读写 ---------------- */

/// 读取插件目录里的 config.json：不存在 / 不是 JSON 对象 → None；JSON 损坏 → 错误。
pub(super) fn load_stored_config(plugin_dir: &Path) -> Result<Option<Value>, String> {
    match std::fs::read(plugin_dir.join(CONFIG_NAME)) {
        Ok(raw) => match serde_json::from_slice::<Value>(&raw) {
            Ok(value) if value.is_object() => Ok(Some(value)),
            Ok(_) => Ok(None),
            Err(e) => Err(format!("插件配置不是合法的 JSON：{e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取插件配置失败：{e}")),
    }
}

/// 按 schema 过滤配置对象：只保留声明的 key；strict 时类型不符直接报错，
/// 非 strict（安装写回旧配置）时静默丢弃类型不符的值。
pub(super) fn filtered_config(
    schema: &[PluginConfigField],
    config: &Value,
    strict: bool,
) -> Result<Map<String, Value>, String> {
    let obj = config
        .as_object()
        .ok_or_else(|| "插件配置必须是 JSON 对象".to_string())?;
    let mut out = Map::new();
    for field in schema {
        let Some(value) = obj.get(field.key.as_str()) else {
            continue;
        };
        if value_matches_kind(value, &field.kind) {
            out.insert(field.key.clone(), value.clone());
        } else if strict {
            return Err(format!(
                "配置项「{}」的值类型不合法，应为{}",
                field.key,
                kind_label(&field.kind)
            ));
        }
    }
    Ok(out)
}

/// 读取配置并返回给前端：先取 schema 的 defaults，再用存储值覆盖（存储值优先），
/// 只保留 schema 声明的 key；存储值类型与 kind 不符时回退到默认值。
pub(super) fn read_config_in(
    plugin_dir: &Path,
    schema: &[PluginConfigField],
) -> Result<Value, String> {
    let stored = load_stored_config(plugin_dir)?;
    let mut out = Map::new();
    for field in schema {
        let stored_value = stored
            .as_ref()
            .and_then(|v| v.get(field.key.as_str()))
            .filter(|v| value_matches_kind(v, &field.kind));
        let value = match stored_value {
            Some(v) => Some(v.clone()),
            None => field.default.clone(),
        };
        if let Some(v) = value {
            out.insert(field.key.clone(), v);
        }
    }
    Ok(Value::Object(out))
}

/// 校验并写入配置：只写 schema 声明的 key，类型必须与 kind 对应。
/// 以已有配置为底、用传入对象覆盖，因此 `ctx.config.set({ 某一项 })` 这类局部更新
/// 不会把其他已保存的配置项冲掉。
pub(super) fn write_config_in(
    plugin_dir: &Path,
    schema: &[PluginConfigField],
    config: &Value,
) -> Result<(), String> {
    let patch = filtered_config(schema, config, true)?;
    let stored = load_stored_config(plugin_dir)
        .ok()
        .flatten()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut merged = filtered_config(schema, &stored, false)?;
    for (key, value) in patch {
        merged.insert(key, value);
    }
    write_config_file(plugin_dir, &Value::Object(merged))
}

/// 原子写配置：先写 config.json.tmp 再 rename，避免中途失败把原文件写坏。
pub(super) fn write_config_file(plugin_dir: &Path, config: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|e| format!("序列化插件配置失败：{e}"))?;
    if bytes.len() > CONFIG_MAX_BYTES {
        return Err(format!(
            "插件配置过大：序列化后 {} 字节（上限 {} 字节）",
            bytes.len(),
            CONFIG_MAX_BYTES
        ));
    }
    let target = plugin_dir.join(CONFIG_NAME);
    let tmp = plugin_dir.join(format!("{CONFIG_NAME}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入插件配置失败：{e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存插件配置失败：{e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::test_support::{demo_schema, manifest_with_config, temp_root};

    #[test]
    fn dir_name_validation_rejects_unsafe_names() {
        for good in ["word-count", "hello-world", "a1-b2"] {
            assert!(validate_dir_name(good).is_ok(), "{good} 应被接受");
        }
        for bad in ["", "..", "../x", "/abs", "C:\\x", "Word", "with space", "a/b"] {
            assert!(validate_dir_name(bad).is_err(), "{bad} 应被拒绝");
        }
        assert!(validate_dir_name(&"a".repeat(81)).is_err());
        assert!(validate_dir_name(&"a".repeat(80)).is_ok());
    }

    #[test]
    fn config_read_write_only_keeps_declared_keys() {
        let root = temp_root("config-rw");
        let plugin_dir = root.join("demo");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join(MANIFEST_NAME),
            manifest_with_config(
                "demo-plugin",
                "1.0.0",
                r#"[{"key":"menuEnabled","label":"菜单","kind":"boolean","default":true},{"key":"greeting","label":"问候","kind":"string","default":"你好"}]"#,
            ),
        )
        .unwrap();

        // 存储值优先；schema 外的 key 丢弃
        std::fs::write(
            plugin_dir.join(CONFIG_NAME),
            r#"{"menuEnabled":false,"greeting":"hi","extra":42}"#,
        )
        .unwrap();
        let schema = demo_schema();
        let got = read_config_in(&plugin_dir, &schema).unwrap();
        assert_eq!(got["menuEnabled"], serde_json::json!(false));
        assert_eq!(got["greeting"], serde_json::json!("hi"));
        assert!(got.get("extra").is_none(), "schema 外的 key 应被丢弃");

        // config.json 不存在时用 defaults 合并
        std::fs::remove_file(plugin_dir.join(CONFIG_NAME)).unwrap();
        let defaults = read_config_in(&plugin_dir, &schema).unwrap();
        assert_eq!(defaults["menuEnabled"], serde_json::json!(true));
        assert_eq!(defaults["greeting"], serde_json::json!("你好"));

        // 写入：额外 key 丢弃，落盘是 pretty JSON
        let config = serde_json::json!({ "menuEnabled": true, "greeting": "hey", "extra": 1 });
        write_config_in(&plugin_dir, &schema, &config).unwrap();
        let text = std::fs::read_to_string(plugin_dir.join(CONFIG_NAME)).unwrap();
        let raw: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(raw.as_object().unwrap().len(), 2);
        assert_eq!(raw["greeting"], serde_json::json!("hey"));
        assert!(raw.get("extra").is_none(), "写入时 schema 外的 key 应被丢弃");
        assert!(text.contains('\n'), "应以 pretty JSON 落盘");

        // 局部更新：只传一个 key，不冲掉其他已保存的配置项
        write_config_in(&plugin_dir, &schema, &serde_json::json!({ "menuEnabled": false }))
            .unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(plugin_dir.join(CONFIG_NAME)).unwrap())
                .unwrap();
        assert_eq!(raw["menuEnabled"], serde_json::json!(false));
        assert_eq!(raw["greeting"], serde_json::json!("hey"));

        // 类型不符、非对象都拒绝
        assert!(
            write_config_in(&plugin_dir, &schema, &serde_json::json!({ "menuEnabled": "yes" }))
                .is_err()
        );
        assert!(write_config_in(&plugin_dir, &schema, &serde_json::json!([1, 2])).is_err());
    }
}
