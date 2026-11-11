use std::collections::HashSet;

/// 插件可申请的权限白名单：只接受这里列出的标识符。
/// 权限标识符用点分格式 `domain.action`，未来扩展时往这里加即可。
pub const ALLOWED_PERMISSIONS: &[&str] = &[
    "notes.read",
    "notes.write",
    "editor.insert",
    "config.read_write",
    "ai.tool",
    "ai.prompt",
    "ai.provider",
    "ai.settings",
    "settings.section",
    // 插件私有表（只能碰 plugin_<目录名>__ 前缀的表）
    "db.read_write",
    // 用插件目录里的文件开独立窗口
    "window.open",
    // 注册全局快捷键
    "shortcut.register",
    // 插件数据目录内的文件读写（<数据目录>/plugin-data/<目录名>/）
    "fs.read_write",
    // 通过宿主代理联网（还要在 plugin.json 的 netDomains 里声明主机白名单）
    "net.fetch",
];

/// 权限白名单校验：每个权限标识符都必须在 ALLOWED_PERMISSIONS 里。
/// 空数组合法（表示插件不需要特殊权限）。
pub(super) fn validate_permissions(permissions: &[String]) -> Result<(), String> {
    let allowed: HashSet<&str> = ALLOWED_PERMISSIONS.iter().copied().collect();
    for perm in permissions {
        if !allowed.contains(perm.as_str()) {
            return Err(format!("未知权限：{perm}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::test_support::sample_manifest;
    use crate::plugins::manifest::validate_manifest;

    #[test]
    fn permissions_empty_array_is_accepted() {
        // 空权限数组合法——表示插件不需要特殊权限
        let mut m = sample_manifest("good");
        m.permissions = Vec::new();
        assert!(validate_manifest(&m).is_ok(), "空权限数组应被接受");
    }

    #[test]
    fn permissions_unknown_identifier_rejected() {
        let err = validate_permissions(&[
            "notes.read".into(),     // 合法
            "evil.something".into(), // 未知：不是白名单里的值
        ])
        .unwrap_err();
        assert!(
            err.contains("未知权限：evil.something"),
            "应返回中文错误，实际：{err}"
        );
    }

    #[test]
    fn permissions_all_allowed_values_pass() {
        // 白名单里的所有值都能通过
        for perm in ALLOWED_PERMISSIONS {
            assert!(
                validate_permissions(&[(*perm).to_string()]).is_ok(),
                "白名单里的权限 `{perm}` 应被接受"
            );
        }
    }
}
