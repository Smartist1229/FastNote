use serde_json::Value;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

use super::manifest::{validate_i18n_files_exist, validate_manifest, PluginManifest};
use super::scheme::plugin_icon_url_in;
use super::storage::{filtered_config, load_stored_config, write_config_file, MANIFEST_NAME};

/* ---------------- 插件包（zip）读取与解压 ---------------- */

/// 已打开并校验过的插件包：清单 + plugin.json 所在的根前缀
pub(super) struct OpenedPlugin {
    archive: zip::ZipArchive<std::fs::File>,
    pub(super) manifest: PluginManifest,
    /// 包内根前缀：根布局为 ""；单顶层文件夹布局为 "文件夹名/"（含结尾斜杠）
    prefix: String,
}

/// 在包内定位 plugin.json。根目录优先；否则必须恰好有一个顶层文件夹包着它。
/// 返回（plugin.json 的条目下标，根前缀）。
fn locate_manifest<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(usize, String), String> {
    let mut root_index: Option<usize> = None;
    let mut folder_candidates: Vec<(usize, String)> = Vec::new();

    for (index, name) in archive.file_names().enumerate() {
        // 条目名解不出来（编码异常）的条目不参与定位
        let Ok(name) = name else { continue };
        if name == MANIFEST_NAME {
            root_index = Some(index);
        } else if let Some(folder) = name
            .strip_suffix(MANIFEST_NAME)
            .and_then(|s| s.strip_suffix('/'))
        {
            // 形如 "<文件夹>/plugin.json"，且文件夹本身不再含更深层级
            if !folder.is_empty() && !folder.contains('/') {
                folder_candidates.push((index, folder.to_string()));
            }
        }
    }

    if let Some(index) = root_index {
        return Ok((index, String::new()));
    }
    match folder_candidates.len() {
        1 => Ok((folder_candidates[0].0, format!("{}/", folder_candidates[0].1))),
        0 => Err("不是有效的插件包：缺少 plugin.json".into()),
        _ => Err("不是有效的插件包：包内有多个 plugin.json，无法确定插件根目录".into()),
    }
}

/// 打开插件包：定位 plugin.json、解析清单并校验，随后包保持打开供解压
pub(super) fn open_plugin_zip(zip_path: &str) -> Result<OpenedPlugin, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("无法打开压缩包：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败：{e}"))?;

    let (index, prefix) = locate_manifest(&mut archive)?;
    let manifest = {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取 plugin.json 失败：{e}"))?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 plugin.json 失败：{e}"))?;
        let manifest: PluginManifest = serde_json::from_slice(&bytes)
            .map_err(|e| format!("不是有效的插件包：plugin.json 解析失败：{e}"))?;
        validate_manifest(&manifest)?;
        manifest
    };

    Ok(OpenedPlugin {
        archive,
        manifest,
        prefix,
    })
}

/// 把包内容（去掉根前缀）解压到 target 目录。任何条目出错都向上返回，由调用方清理残留。
fn extract_plugin(
    archive: &mut zip::ZipArchive<std::fs::File>,
    prefix: &str,
    target: &Path,
) -> Result<(), String> {
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| format!("解压失败：{e}"))?;
        // zip 9 的 name() 带 Result（非 UTF-8 名按编码规则解码），这里取成完整字符串
        let name = entry
            .name()
            .map_err(|e| format!("解压失败：{e}"))?
            .into_owned();
        // 根前缀之外的散落文件（比如与插件文件夹并排的 README）不属于插件，跳过
        let rel = if prefix.is_empty() {
            Some(name.as_str())
        } else {
            name.strip_prefix(prefix)
        };
        let Some(rel) = rel else { continue };
        if rel.is_empty() {
            continue; // 顶层文件夹自身的目录条目
        }
        // 防目录穿越：解压目标必须始终落在插件目录内
        let rel_path = Path::new(rel);
        let unsafe_path = rel_path.is_absolute()
            || rel_path.components().any(|c| {
                matches!(
                    c,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            });
        if unsafe_path {
            return Err(format!("插件包含不安全的路径条目：{name}"));
        }
        let dest = target.join(rel_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| format!("创建插件目录失败：{e}"))?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建插件目录失败：{e}"))?;
            }
            let mut out =
                std::fs::File::create(&dest).map_err(|e| format!("写入插件文件失败：{e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("写入插件文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// 扫描插件根目录下的已安装实例：返回（目录名, 清单），解析/校验失败的目录跳过。
pub(super) fn scan_installed(root: &Path) -> Vec<(String, PluginManifest)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut subdirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    subdirs.sort(); // 固定顺序，前端列表不跳
    let mut out = Vec::new();
    for dir in subdirs {
        let Some(name) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let Ok(raw) = std::fs::read(dir.join(MANIFEST_NAME)) else {
            continue; // 没有 plugin.json 的目录不算插件
        };
        let Ok(manifest) = serde_json::from_slice::<PluginManifest>(&raw) else {
            continue; // 解析失败的目录跳过
        };
        if validate_manifest(&manifest).is_err() {
            continue;
        }
        out.push((name, manifest));
    }
    out
}

/// author 比较：trim + 忽略大小写；两边都为空也视为相同（同作者维护的插件）。
fn same_author(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// 生成 6 位小写十六进制后缀：时间戳 nanos 经 splitmix64 混合 + 尝试序号。
/// 不引入 uuid/rand 依赖；循环重试由调用方保证不与已有目录重名。
fn random_suffix(attempt: u32) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos.wrapping_add((attempt as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    format!("{:06x}", x & 0x00FF_FFFF)
}

/// 决定安装目标目录名（实例键）：
/// - 同 id 且 author 相同 → 复用已有目录（整体覆盖，即升级/降级）；
/// - 同 id 但 author 都不同 → `<id>-<6位十六进制>`，循环避开已有目录；
/// - 没有同 id → 用 manifest.id。
pub(super) fn resolve_target_dir_name(root: &Path, manifest: &PluginManifest) -> String {
    let installed = scan_installed(root);
    let same_id: Vec<&(String, PluginManifest)> = installed
        .iter()
        .filter(|(_, m)| m.id == manifest.id)
        .collect();
    if let Some((name, _)) = same_id
        .iter()
        .find(|(_, m)| same_author(&m.author, &manifest.author))
    {
        return name.clone();
    }
    if !same_id.is_empty() {
        for attempt in 0.. {
            let candidate = format!("{}-{}", manifest.id, random_suffix(attempt));
            if !root.join(&candidate).exists() {
                return candidate;
            }
        }
    }
    manifest.id.clone()
}

/// 已打开的插件包落盘到 target：覆盖安装前先把旧 config.json 读进内存，
/// 解压完成后按新 schema 过滤写回（升级/降级不丢用户配置）；解压或写回失败都清理残留。
/// 返回的清单带上落盘目录名（dirName），供前端作实例键。
pub(super) fn install_opened(
    opened: OpenedPlugin,
    target: &Path,
    dir_name: &str,
) -> Result<PluginManifest, String> {
    let OpenedPlugin {
        mut archive,
        mut manifest,
        prefix,
    } = opened;
    // 损坏或读不出内容的旧配置当作没有，安装本身不该被它卡住
    let preserved = if target.is_dir() {
        load_stored_config(target).ok().flatten()
    } else {
        None
    };
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|e| format!("清理旧版本插件失败：{e}"))?;
    }
    if let Err(e) = extract_plugin(&mut archive, &prefix, target) {
        let _ = std::fs::remove_dir_all(target);
        return Err(e);
    }
    if let Err(e) = validate_i18n_files_exist(target, &manifest.i18n) {
        let _ = std::fs::remove_dir_all(target);
        return Err(e);
    }
    if let Some(old) = preserved {
        let restored = filtered_config(&manifest.config, &old, false)
            .and_then(|out| write_config_file(target, &Value::Object(out)));
        if let Err(e) = restored {
            let _ = std::fs::remove_dir_all(target);
            return Err(e);
        }
    }
    manifest.dir_name = dir_name.to_string();
    manifest.icon_url = plugin_icon_url_in(target, dir_name);
    Ok(manifest)
}

#[cfg(test)]
fn install_zip_file(zip_path: &str, root: &Path) -> Result<PluginManifest, String> {
    let opened = open_plugin_zip(zip_path)?;
    let dir_name = resolve_target_dir_name(root, &opened.manifest);
    let target = root.join(&dir_name);
    install_opened(opened, &target, &dir_name)
}

/// 列出已安装插件：扫描 plugin/ 下每个子目录的 plugin.json，成功解析并校验的
/// 填入 dirName（= 子目录名）；解析失败的目录跳过，不中断整体。
pub(super) fn list_installed_in(dir: &Path) -> Vec<PluginManifest> {
    scan_installed(dir)
        .into_iter()
        .map(|(dir_name, mut manifest)| {
            // 目录名才是实例键；zip 里的 plugin.json 不含 dirName
            manifest.icon_url = plugin_icon_url_in(&dir.join(&dir_name), &dir_name);
            manifest.dir_name = dir_name;
            manifest
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::storage::CONFIG_NAME;
    use crate::plugins::storage::write_config_in;
    use crate::plugins::test_support::{demo_schema, manifest_with_config, temp_root};
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    #[test]
    fn install_requires_declared_i18n_files() {
        let root = temp_root("i18n-missing");
        let missing = write_zip(
            &root,
            "missing.zip",
            &[
                (
                    "plugin.json",
                    r#"{"id":"i18n-demo","name":"示例插件","version":"1.0.0","entry":"main.js","i18n":{"zh":"locales/zh.json"}}"#,
                ),
                ("main.js", "// js"),
            ],
        );
        let err = install_zip_file(&missing, &root).unwrap_err();
        assert_eq!(err, "i18n 文件不存在：locales/zh.json");
        assert!(!root.join("i18n-demo").exists());

        let complete = write_zip(
            &root,
            "complete.zip",
            &[
                (
                    "plugin.json",
                    r#"{"id":"i18n-demo","name":"示例插件","version":"1.0.0","entry":"main.js","i18n":{"zh":"locales/zh.json","en":"locales/en.json"}}"#,
                ),
                ("main.js", "// js"),
                ("locales/zh.json", r#"{"menu":{"greet":"你好"}}"#),
                ("locales/en.json", r#"{"menu":{"greet":"Hello"}}"#),
            ],
        );
        let manifest = install_zip_file(&complete, &root).unwrap();
        assert!(
            root.join(&manifest.dir_name).join("locales/zh.json").is_file(),
            "合法的 i18n 文件应随包落盘"
        );
    }

    /// 在内存里构造一个 zip（不落盘），返回原始字节
    fn build_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn locate_prefix(bytes: Vec<u8>) -> Result<String, String> {
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        locate_manifest(&mut archive).map(|(_, prefix)| prefix)
    }

    #[test]
    fn zip_layout_recognition() {
        // 布局一：plugin.json 在根目录
        assert_eq!(
            locate_prefix(build_zip(&[("plugin.json", "{}"), ("main.js", "// js")])).unwrap(),
            ""
        );
        // 布局二：只有一个顶层文件夹包着 plugin.json
        assert_eq!(
            locate_prefix(build_zip(&[
                ("demo/plugin.json", "{}"),
                ("demo/main.js", "// js"),
                ("demo/style.css", "/* css */"),
            ]))
            .unwrap(),
            "demo/"
        );
        // 没有 plugin.json → 不是合法插件包
        assert!(locate_prefix(build_zip(&[("readme.txt", "x")])).is_err());
    }

    /// 把内存 zip 落成临时文件，返回路径字符串（install_zip_file 只收路径）
    fn write_zip(dir: &Path, name: &str, entries: &[(&str, &str)]) -> String {
        let path = dir.join(name);
        std::fs::write(&path, build_zip(entries)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn manifest_json(id: &str, version: &str, author: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"示例插件","version":"{version}","author":"{author}","entry":"main.js"}}"#
        )
    }

    #[test]
    fn install_same_id_same_author_overwrites() {
        let root = temp_root("overwrite");
        let v1 = write_zip(
            &root,
            "v1.zip",
            &[
                (
                    "plugin.json",
                    &manifest_json("hello-world", "0.1.0", "FastNote"),
                ),
                ("main.js", "// v1"),
            ],
        );
        let m1 = install_zip_file(&v1, &root).unwrap();
        assert_eq!(m1.dir_name, "hello-world");
        assert_eq!(m1.version, "0.1.0");

        // 升级：同 id 同 author（大小写与首尾空格不同也算同一作者）整体覆盖原目录
        let v2 = write_zip(
            &root,
            "v2.zip",
            &[
                (
                    "plugin.json",
                    &manifest_json("hello-world", "0.2.0", "  FASTNOTE  "),
                ),
                ("main.js", "// v2"),
            ],
        );
        let m2 = install_zip_file(&v2, &root).unwrap();
        assert_eq!(m2.dir_name, "hello-world");
        assert_eq!(m2.version, "0.2.0");
        assert_eq!(
            std::fs::read_to_string(root.join("hello-world/main.js")).unwrap(),
            "// v2"
        );

        // 降级：不做 semver 比较，再装 0.1.0 同样覆盖回原目录
        let m3 = install_zip_file(&v1, &root).unwrap();
        assert_eq!(m3.dir_name, "hello-world");
        assert_eq!(m3.version, "0.1.0");
        assert_eq!(
            std::fs::read_to_string(root.join("hello-world/main.js")).unwrap(),
            "// v1"
        );
    }

    #[test]
    fn same_id_different_author_gets_suffixed_dir() {
        let root = temp_root("author-conflict");
        let alice = write_zip(
            &root,
            "alice.zip",
            &[
                ("plugin.json", &manifest_json("hello-world", "1.0.0", "Alice")),
                ("main.js", "// alice"),
            ],
        );
        let bob = write_zip(
            &root,
            "bob.zip",
            &[
                ("plugin.json", &manifest_json("hello-world", "1.0.0", "Bob")),
                ("main.js", "// bob"),
            ],
        );

        let m_alice = install_zip_file(&alice, &root).unwrap();
        assert_eq!(m_alice.dir_name, "hello-world");

        // 同 id 不同 author → 另起 <id>-<6位小写十六进制>，不覆盖别人的插件
        let m_bob = install_zip_file(&bob, &root).unwrap();
        let suffix = m_bob
            .dir_name
            .strip_prefix("hello-world-")
            .expect("应带 <id>- 前缀");
        assert_eq!(suffix.len(), 6);
        assert!(
            suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "后缀应为 6 位小写十六进制：{suffix}"
        );
        assert!(root.join("hello-world").is_dir(), "原作者的目录不应被删除");
        assert!(root.join(&m_bob.dir_name).is_dir());
        assert_eq!(
            std::fs::read_to_string(root.join("hello-world/main.js")).unwrap(),
            "// alice"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&m_bob.dir_name).join("main.js")).unwrap(),
            "// bob"
        );

        // 再装同一作者的新版本 → 复用后缀目录，不再新增
        let m_bob2 = install_zip_file(&bob, &root).unwrap();
        assert_eq!(m_bob2.dir_name, m_bob.dir_name);
        let subdirs = scan_installed(&root);
        assert_eq!(subdirs.len(), 2, "应仍只有两个实例目录");
    }

    #[test]
    fn list_fills_dir_name_from_subdir() {
        let root = temp_root("list");
        std::fs::create_dir_all(root.join("custom-dir")).unwrap();
        std::fs::write(
            root.join("custom-dir/plugin.json"),
            manifest_json("hello-world", "1.0.0", "FastNote"),
        )
        .unwrap();
        // 解析失败的目录应被跳过，不影响其他
        std::fs::create_dir_all(root.join("broken")).unwrap();
        std::fs::write(root.join("broken/plugin.json"), "{").unwrap();

        let listed = list_installed_in(&root);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "hello-world");
        assert_eq!(listed[0].dir_name, "custom-dir");
    }

    #[test]
    fn install_preserves_config_json_across_upgrade() {
        let root = temp_root("preserve-config");
        let v1_manifest = manifest_with_config(
            "demo-plugin",
            "1.0.0",
            r#"[{"key":"menuEnabled","label":"菜单","kind":"boolean","default":true},{"key":"greeting","label":"问候","kind":"string","default":"你好"}]"#,
        );
        let v1 = write_zip(
            &root,
            "v1.zip",
            &[("plugin.json", v1_manifest.as_str()), ("main.js", "// v1")],
        );
        let m1 = install_zip_file(&v1, &root).unwrap();
        assert_eq!(m1.dir_name, "demo-plugin");
        let plugin_dir = root.join(&m1.dir_name);

        // 写入用户配置
        write_config_in(
            &plugin_dir,
            &demo_schema(),
            &serde_json::json!({ "menuEnabled": false, "greeting": "留下的问候" }),
        )
        .unwrap();
        assert!(plugin_dir.join(CONFIG_NAME).is_file());

        // 升级到 v2：新 schema 删掉了 greeting，写回时按新 schema 过滤
        let v2_manifest = manifest_with_config(
            "demo-plugin",
            "2.0.0",
            r#"[{"key":"menuEnabled","label":"菜单","kind":"boolean","default":true}]"#,
        );
        let v2 = write_zip(
            &root,
            "v2.zip",
            &[("plugin.json", v2_manifest.as_str()), ("main.js", "// v2")],
        );
        let m2 = install_zip_file(&v2, &root).unwrap();
        assert_eq!(m2.dir_name, "demo-plugin");
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(plugin_dir.join(CONFIG_NAME)).unwrap())
                .unwrap();
        assert_eq!(
            raw["menuEnabled"],
            serde_json::json!(false),
            "升级后用户配置应保留"
        );
        assert!(
            raw.get("greeting").is_none(),
            "新 schema 之外的 key 写回时应过滤掉"
        );
        assert_eq!(
            std::fs::read_to_string(plugin_dir.join("main.js")).unwrap(),
            "// v2",
            "升级应覆盖代码文件"
        );

        // 卸载后重装才会丢配置：先删目录再装，config.json 不应复活
        std::fs::remove_dir_all(&plugin_dir).unwrap();
        let m3 = install_zip_file(&v2, &root).unwrap();
        assert_eq!(m3.dir_name, "demo-plugin");
        assert!(!plugin_dir.join(CONFIG_NAME).exists());
    }
}
