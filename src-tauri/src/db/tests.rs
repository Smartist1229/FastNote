use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    /// 复刻升级前（id 为 INTEGER）的库结构，只保留迁移会碰到的表
    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                ai_access INTEGER NOT NULL DEFAULT 2,
                is_encrypted INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                is_deleted INTEGER DEFAULT 0,
                deleted_at TEXT,
                is_pinned INTEGER DEFAULT 0,
                ai_access INTEGER NOT NULL DEFAULT 2,
                enc_mode INTEGER NOT NULL DEFAULT 0,
                enc_tags TEXT,
                source_plugin TEXT
             );
             CREATE TABLE note_tags (
                note_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'user',
                created_at TEXT NOT NULL,
                PRIMARY KEY (note_id, tag_id)
             );
             CREATE TABLE notes_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category_id INTEGER,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'auto',
                pinned INTEGER NOT NULL DEFAULT 0,
                saved_at TEXT NOT NULL
             );
             CREATE TABLE note_chunks (
                note_id INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                text TEXT NOT NULL,
                dim INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                PRIMARY KEY (note_id, seq)
             );
             CREATE TABLE note_index_state (
                note_id INTEGER PRIMARY KEY,
                note_updated_at TEXT NOT NULL,
                model_id TEXT NOT NULL,
                indexed_at TEXT NOT NULL
             );
             CREATE TABLE encrypted_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL CHECK(scope IN ('note','category')),
                ref_id INTEGER NOT NULL,
                meta_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(scope, ref_id)
             );
             CREATE TABLE schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn seed(conn: &Connection) {
        conn.execute(
            "INSERT INTO categories (id, name, created_at) VALUES (1, '默认', '2026-01-01')",
            [],
        )
        .unwrap();
        // 1 号未加密 → 应该换 UUID；2 号已加密 → 必须保留 "2"；3 号未加密
        conn.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, enc_mode)
             VALUES (1, 'plain', 'a', 1, '2026-01-01', '2026-01-01', 0),
                    (2, 'secret', 'b', 1, '2026-01-01', '2026-01-01', 1),
                    (3, 'plain3', 'c', NULL, '2026-01-01', '2026-01-01', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_tags (note_id, tag_id, created_at) VALUES (1, 1, '2026-01-01'), (2, 2, '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes_history (note_id, title, content, saved_at) VALUES (1, 'plain', 'old', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_chunks (note_id, seq, text, dim, embedding) VALUES (1, 0, 'x', 2, X'00FF')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_index_state (note_id, note_updated_at, model_id, indexed_at)
             VALUES (1, '2026-01-01', 'm', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO encrypted_keys (scope, ref_id, meta_json, created_at)
             VALUES ('note', 2, '{}', '2026-01-01'), ('category', 1, '{}', '2026-01-01')",
            [],
        )
        .unwrap();
    }

    fn id_of(conn: &Connection, title: &str) -> String {
        conn.query_row("SELECT id FROM notes WHERE title = ?1", params![title], |row| {
            row.get(0)
        })
        .unwrap()
    }

    #[test]
    fn migration_rewrites_unencrypted_ids_and_keeps_encrypted() {
        let conn = legacy_db();
        seed(&conn);
        migrate_note_ids_to_uuid(&conn).unwrap();

        let plain = id_of(&conn, "plain");
        let plain3 = id_of(&conn, "plain3");
        // 未加密笔记换成 12 位 base62 短随机 ID
        assert_eq!(plain.len(), 12);
        assert!(plain.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(plain, plain3);
        // 已加密笔记保留原数字串，否则密文 AAD 对不上
        assert_eq!(id_of(&conn, "secret"), "2");

        // 引用表全部指向新 id
        let tag_note: String = conn
            .query_row("SELECT note_id FROM note_tags WHERE tag_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tag_note, plain);
        let history_note: String = conn
            .query_row("SELECT note_id FROM notes_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(history_note, plain);
        let chunk_note: String = conn
            .query_row("SELECT note_id FROM note_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunk_note, plain);
        let state_note: String = conn
            .query_row("SELECT note_id FROM note_index_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state_note, plain);

        // 密钥表：笔记作用域跟映射（加密笔记仍是 "2"），分组作用域变成数字字符串
        let note_ref: String = conn
            .query_row("SELECT ref_id FROM encrypted_keys WHERE scope = 'note'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note_ref, "2");
        let category_ref: String = conn
            .query_row("SELECT ref_id FROM encrypted_keys WHERE scope = 'category'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(category_ref, "1");

        let done: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE name = 'note_ids_uuid_v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(done, 1);
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = legacy_db();
        seed(&conn);
        migrate_note_ids_to_uuid(&conn).unwrap();
        let plain = id_of(&conn, "plain");
        assert_eq!(id_of(&conn, "secret"), "2");

        // 再跑一次走「已是 TEXT」分支，不应重建表或改 id
        migrate_note_ids_to_uuid(&conn).unwrap();
        assert_eq!(id_of(&conn, "plain"), plain);
        assert_eq!(id_of(&conn, "secret"), "2");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn category_migration_rewrites_ids_and_keeps_encrypted() {
        let conn = legacy_db();
        seed(&conn);
        // 再加一个未加密分组和指向它的笔记
        conn.execute(
            "INSERT INTO categories (id, name, created_at) VALUES (2, '工作', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute("UPDATE notes SET category_id = 2 WHERE id = 3", [])
            .unwrap();

        // 与 init_database 顺序一致：先笔记迁移，再分组迁移
        migrate_note_ids_to_uuid(&conn).unwrap();
        migrate_category_ids_to_uuid(&conn).unwrap();

        // 已加密分组（有 encrypted_keys 记录）保留原数字 id 字符串
        let kept: String = conn
            .query_row("SELECT id FROM categories WHERE name = '默认'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, "1");
        // 未加密分组换成 12 位 base62 短随机 ID
        let fresh: String = conn
            .query_row("SELECT id FROM categories WHERE name = '工作'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fresh.len(), 12);
        assert!(fresh.chars().all(|c| c.is_ascii_alphanumeric()));

        // notes / notes_history 的 category_id 已套用映射
        let note_cat: Option<String> = conn
            .query_row("SELECT category_id FROM notes WHERE title = 'plain3'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(note_cat.as_deref(), Some(fresh.as_str()));
        let kept_note_cat: Option<String> = conn
            .query_row("SELECT category_id FROM notes WHERE title = 'plain'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept_note_cat.as_deref(), Some("1"));

        // 密钥表的 category 引用保留 "1"（AAD 里写死了它）
        let category_ref: String = conn
            .query_row(
                "SELECT ref_id FROM encrypted_keys WHERE scope = 'category'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(category_ref, "1");

        // 列类型已变 TEXT
        let ty: String = conn
            .query_row(
                "SELECT type FROM pragma_table_info('categories') WHERE name = 'id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ty.eq_ignore_ascii_case("TEXT"));
        let note_cat_ty: String = conn
            .query_row(
                "SELECT type FROM pragma_table_info('notes') WHERE name = 'category_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(note_cat_ty.eq_ignore_ascii_case("TEXT"));

        // 幂等：再跑一次走「已是 TEXT」分支，id 不变
        migrate_category_ids_to_uuid(&conn).unwrap();
        let fresh2: String = conn
            .query_row("SELECT id FROM categories WHERE name = '工作'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fresh2, fresh);
    }

    #[test]
    fn print_sample_short_ids() {
        // 生成效果示例：cargo test print_sample_short_ids -- --nocapture
        for _ in 0..5 {
            println!("sample: {}", new_short_id());
        }
        assert_eq!(new_short_id().len(), 12);
    }
}

/* ---------------- 打开数据库：迁移前备份 + 损坏兜底 ---------------- */

