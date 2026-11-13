use super::*;

#[cfg(test)]
mod sqlite_selection_tests {
    use super::*;

    fn snapshot_conn(extra_notes_cols: bool) -> Connection {
        let conn = Connection::open_in_memory().expect("内存库");
        let enc_cols = if extra_notes_cols {
            ", enc_mode INTEGER NOT NULL DEFAULT 0, enc_tags TEXT"
        } else {
            ""
        };
        conn.execute_batch(&format!(
            "CREATE TABLE {SQLITE_BACKUP_META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE notes (
                 id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
                 category_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL{enc_cols}
             );
             CREATE TABLE ai_providers (
                 id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider_type TEXT NOT NULL,
                 api_base_url TEXT NOT NULL, api_key TEXT NOT NULL,
                 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE ai_chat_sessions (
                 id INTEGER PRIMARY KEY, title TEXT NOT NULL, provider_id INTEGER NOT NULL,
                 model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE ai_chat_messages (
                 id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL,
                 content TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO {SQLITE_BACKUP_META} (key, value) VALUES
                 ('format', '{SQLITE_BACKUP_FORMAT}'), ('version', '1');
             INSERT INTO categories (id, name, created_at) VALUES ('c1', '默认', '2026-01-01');
             INSERT INTO notes (id, title, content, category_id, created_at, updated_at)
                 VALUES ('n1', '标题', '正文', 'c1', '2026-01-01', '2026-01-02');
             INSERT INTO app_settings (key, value, updated_at)
                 VALUES ('app.security.root.salt', 'abcd', '2026-01-01');",
        ))
        .expect("建表");
        conn
    }

    /// 快照要能被读成与 JSON 备份同构的 data：缺列用默认值补，根密码材料也要读到
    #[test]
    fn snapshot_converts_to_backup_data() {
        let conn = snapshot_conn(false);
        let data = sqlite_snapshot_to_data(&conn).expect("转换失败");
        let notes = json_arr(&data, "notes");
        assert_eq!(notes.len(), 1);
        assert_eq!(json_str(&notes[0], "title"), "标题");
        // 旧快照没有 enc_mode 列：按 0 兜底，不能被当成加密笔记
        assert_eq!(json_i64(&notes[0], "enc_mode"), 0);
        assert_eq!(json_arr(&data, "categories").len(), 1);
        // app.security.* 必须一起读出来，换机解锁全靠它
        let settings = json_arr(&data, "settings");
        assert!(settings
            .iter()
            .any(|s| json_str(s, "key") == "app.security.root.salt"));
    }

    /// 有 enc_mode 列时如实读出，选择逻辑才知道哪些是加密笔记
    #[test]
    fn snapshot_reads_enc_mode_when_present() {
        let conn = snapshot_conn(true);
        conn.execute("UPDATE notes SET enc_mode = 1", []).expect("置加密");
        let data = sqlite_snapshot_to_data(&conn).expect("转换失败");
        assert_eq!(json_i64(&json_arr(&data, "notes")[0], "enc_mode"), 1);
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    /// 分组过滤：空列表 = 全部；给了白名单就只认白名单里的；
    /// 未分组笔记只有在显式勾了 `__none__` 时才算在范围内。
    #[test]
    fn in_scope_filters_by_category() {
        let all = BackupSelection::default();
        assert!(all.in_scope(None), "空列表应包含未分组");
        assert!(all.in_scope(Some("any")), "空列表应包含任意分组");

        let picked = BackupSelection {
            category_ids: vec!["a".to_string()],
            ..Default::default()
        };
        assert!(picked.in_scope(Some("a")));
        assert!(!picked.in_scope(Some("b")));
        assert!(!picked.in_scope(None), "没勾未分组时不应带回来");

        let ungrouped = BackupSelection {
            category_ids: vec![SELECTION_UNGROUPED.to_string()],
            ..Default::default()
        };
        assert!(ungrouped.in_scope(None));
        assert!(!ungrouped.in_scope(Some("a")));
    }
}

#[cfg(test)]
mod preserve_tests {
    use super::*;

    /// 恢复前后「本地独有内容」的保全：备份里有的以备份为准，备份里没有的补回来。
    #[test]
    fn copy_missing_rows_keeps_local_only_rows() {
        let main = Connection::open_in_memory().expect("内存库");
        main.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             INSERT INTO notes VALUES ('1', 'backup-version');",
        )
        .expect("准备 main");

        let prev_path = std::env::temp_dir().join(format!(
            "fastnote-preserve-test-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&prev_path);
        {
            let prev = Connection::open(&prev_path).expect("prev 库");
            prev.execute_batch(
                "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
                 INSERT INTO notes VALUES ('1', 'local-version');
                 INSERT INTO notes VALUES ('2', 'local-only');",
            )
            .expect("准备 prev");
        }

        main.execute(
            "ATTACH DATABASE ?1 AS prev",
            params![prev_path.to_string_lossy().to_string()],
        )
        .expect("挂载");

        let preserved = copy_missing_rows(&main, "notes", &[]);
        assert_eq!(preserved, 1, "只有本地独有的 id=2 应该被补回");
        let first: String = main
            .query_row("SELECT title FROM notes WHERE id = '1'", [], |r| r.get(0))
            .expect("读 id=1");
        assert_eq!(first, "backup-version", "同 id 冲突时以备份为准");
        let second: String = main
            .query_row("SELECT title FROM notes WHERE id = '2'", [], |r| r.get(0))
            .expect("读 id=2");
        assert_eq!(second, "local-only");

        let _ = main.execute("DETACH DATABASE prev", []);
        let _ = std::fs::remove_file(&prev_path);
    }
}

#[cfg(test)]
mod export_css_tests {
    use super::*;

    /// 导出的 HTML 必须给图片兜底尺寸限制：不限制的话原图按像素铺开，
    /// 一张 3000px 宽的截图会把整篇挤成横向滚动。
    #[test]
    fn note_html_page_limits_image_size() {
        let page = note_html_page("标题", "![a](attachments/3f/3f9c2a8e1d4b6c7a.png)");
        assert!(page.contains("<img"), "Markdown 里的图片应被渲染成 <img>");
        assert!(
            page.contains("img{display:block;max-width:100%"),
            "导出页缺少图片样式：{page}"
        );
    }
}

#[cfg(test)]
mod backup_gzip_tests {
    use super::*;

    /// `.gz` 写入后必须能被原样读回：云端备份靠这一对函数来回，
    /// 压缩写错会让「恢复」在解压阶段就失败，且是那种只有真机上才发现的错。
    #[test]
    fn gzip_backup_roundtrip() {
        let path = std::env::temp_dir()
            .join(format!("fastnote-gz-test-{}.gz", std::process::id()))
            .to_string_lossy()
            .to_string();
        // 用真实备份的结构（重复键名 + 中文正文）：payload 太小的话 gzip 头比数据还长
        let body = "中文正文".repeat(2000);
        let doc = json!({
            "format": BACKUP_FORMAT,
            "version": BACKUP_VERSION,
            "data": { "notes": [{ "content": body }] },
        });
        write_backup_json(&path, &doc).expect("写入失败");

        // 文件确实是 gzip（魔数 1f 8b），否则等于没压缩
        let bytes = std::fs::read(&path).expect("读取失败");
        assert_eq!(&bytes[..2], &[0x1f, 0x8b], "应按 gzip 写出");

        let text = read_backup_text(&path).expect("读回失败");
        assert!(bytes.len() < text.len(), "压缩后必须更小");
        // 写进去和读回来必须是同一份数据
        assert_eq!(
            serde_json::from_str::<Value>(&text).expect("解析失败"),
            doc
        );
        // 老备份是明文 JSON，同一个读取入口照样要认
        assert_eq!(
            backup_text_from_bytes(text.as_bytes()).expect("明文失败"),
            text
        );

        let _ = std::fs::remove_file(&path);
    }

    /// 原子写：失败时不能动已存在的目标文件，成功时不能留下 `.part` 残渣
    #[test]
    fn atomic_write_keeps_old_file_on_failure() {
        let dir = std::env::temp_dir();
        let path = dir
            .join(format!("fastnote-atomic-test-{}.gz", std::process::id()))
            .to_string_lossy()
            .to_string();
        write_backup_json(&path, &json!({ "old": true })).expect("首写失败");
        let before = std::fs::read(&path).expect("读取失败");

        // 写到一半报错 → 目标文件必须还是旧内容
        let failed = write_backup_atomic(&path, |_w| Err("模拟中断".to_string()));
        assert!(failed.is_err());
        assert_eq!(std::fs::read(&path).expect("读取失败"), before);

        // 不留 `.part`
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("列目录失败")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("fastnote-atomic-test") && n.ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");

        let _ = std::fs::remove_file(&path);
    }

    /// `.gz` 才压缩，明文 `.json` 保持原样（用户手点的导出仍是可读 JSON）
    #[test]
    fn json_path_detection() {
        assert!(is_gzip_path("a/b/fastnote-20260101-120000.gz"));
        assert!(is_gzip_path("a/b/fastnote-20260101-120000.json.gz"));
        assert!(!is_gzip_path("a/b/fastnote-20260101-120000.json"));
    }
}

