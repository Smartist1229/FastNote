use super::*;

/* ---------------- 一次性迁移：笔记主键 INTEGER → 短随机 ID(TEXT) ----------------
 * SQLite 不能就地改主键类型，只能「建新表 → 逐行搬数据 → 删旧表 → 改名 → 重建索引」。
 *
 * 已加密的笔记保留原来的数字 id（写成字符串）：
 * 密文 AAD 与 encrypted_keys 的 wrap AAD 里都拼进了旧 id，
 * 改 id 会让已有密文永久解不开，而重新包裹又必须先在运行时拿到用户密码。
 * 未加密笔记没有这个约束，一律换成随机 UUID。
 */
pub(crate) fn migrate_note_ids_to_uuid(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // 已经是 TEXT 主键（新装库 / 迁移过）就直接打标记返回
    let id_type: Option<String> = tx
        .query_row(
            "SELECT type FROM pragma_table_info('notes') WHERE name = 'id'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if id_type
        .as_deref()
        .map(|t| t.eq_ignore_ascii_case("TEXT"))
        .unwrap_or(false)
    {
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('note_ids_uuid_v1', ?1)",
            params![Local::now().to_rfc3339()],
        )?;
        tx.commit()?;
        return Ok(());
    }
    let already: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = 'note_ids_uuid_v1'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if already > 0 {
        return Ok(());
    }

    // 旧 id → 新 id 的映射
    let mut mapping: HashMap<i64, String> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT n.id, COALESCE(n.enc_mode, 0),
                    EXISTS(SELECT 1 FROM encrypted_keys k
                           WHERE k.scope = 'note' AND k.ref_id = n.id)
             FROM notes n",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (old_id, enc_mode, has_key) = row?;
            let new_id = if enc_mode != 0 || has_key != 0 {
                old_id.to_string()
            } else {
                new_note_id()
            };
            mapping.insert(old_id, new_id);
        }
    }

    tx.execute_batch(
        "CREATE TABLE notes_uuid_migrated (
            id TEXT PRIMARY KEY,
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
            source_plugin TEXT,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        );
        CREATE TABLE note_tags_uuid_migrated (
            note_id TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL,
            PRIMARY KEY (note_id, tag_id)
        );
        CREATE TABLE notes_history_uuid_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id INTEGER,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'auto',
            pinned INTEGER NOT NULL DEFAULT 0,
            saved_at TEXT NOT NULL
        );
        CREATE TABLE note_chunks_uuid_migrated (
            note_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            text TEXT NOT NULL,
            dim INTEGER NOT NULL,
            embedding BLOB NOT NULL,
            PRIMARY KEY (note_id, seq)
        );
        CREATE TABLE note_index_state_uuid_migrated (
            note_id TEXT PRIMARY KEY,
            note_updated_at TEXT NOT NULL,
            model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL
        );
        CREATE TABLE encrypted_keys_uuid_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL CHECK(scope IN ('note','category')),
            ref_id TEXT NOT NULL,
            meta_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(scope, ref_id)
        );",
    )?;

    // notes
    {
        let mut read = tx.prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted,
                    deleted_at, is_pinned, ai_access, COALESCE(enc_mode, 0), enc_tags, source_plugin
             FROM notes",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO notes_uuid_migrated
                (id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                 is_pinned, ai_access, enc_mode, enc_tags, source_plugin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for row in rows {
            let r = row?;
            let id = mapping.get(&r.0).cloned().unwrap_or_else(|| r.0.to_string());
            write.execute(params![
                id,
                r.1,
                r.2,
                r.3,
                r.4,
                r.5,
                r.6.unwrap_or(0),
                r.7,
                r.8.unwrap_or(0),
                r.9,
                r.10,
                r.11,
                r.12
            ])?;
        }
    }

    // note_tags
    {
        let mut read =
            tx.prepare("SELECT note_id, tag_id, source, created_at FROM note_tags")?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT OR IGNORE INTO note_tags_uuid_migrated (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for row in rows {
            let r = row?;
            let Some(id) = mapping.get(&r.0) else {
                continue;
            };
            write.execute(params![id, r.1, r.2, r.3])?;
        }
    }

    // notes_history
    {
        let mut read = tx.prepare(
            "SELECT id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at
             FROM notes_history",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO notes_history_uuid_migrated
                (id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for row in rows {
            let r = row?;
            let Some(id) = mapping.get(&r.1) else {
                continue;
            };
            write.execute(params![r.0, id, r.2, r.3, r.4, r.5, r.6, r.7, r.8])?;
        }
    }

    // note_chunks
    {
        let mut read = tx.prepare(
            "SELECT note_id, seq, text, dim, embedding FROM note_chunks",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Vec<u8>>(4)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT OR IGNORE INTO note_chunks_uuid_migrated (note_id, seq, text, dim, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for row in rows {
            let r = row?;
            let Some(id) = mapping.get(&r.0) else {
                continue;
            };
            write.execute(params![id, r.1, r.2, r.3, r.4])?;
        }
    }

    // note_index_state
    {
        let mut read = tx.prepare(
            "SELECT note_id, note_updated_at, model_id, indexed_at FROM note_index_state",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT OR IGNORE INTO note_index_state_uuid_migrated
                (note_id, note_updated_at, model_id, indexed_at)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for row in rows {
            let r = row?;
            let Some(id) = mapping.get(&r.0) else {
                continue;
            };
            write.execute(params![id, r.1, r.2, r.3])?;
        }
    }

    // encrypted_keys：笔记作用域按映射走（加密笔记本来就是原数字），分组作用域转成数字字符串
    {
        let mut read = tx.prepare(
            "SELECT id, scope, ref_id, meta_json, created_at FROM encrypted_keys",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO encrypted_keys_uuid_migrated (id, scope, ref_id, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for row in rows {
            let r = row?;
            let ref_id = if r.1 == "note" {
                match mapping.get(&r.2) {
                    Some(id) => id.clone(),
                    None => continue,
                }
            } else {
                r.2.to_string()
            };
            write.execute(params![r.0, r.1, ref_id, r.3, r.4])?;
        }
    }

    tx.execute_batch(
        "DROP TABLE notes;
         DROP TABLE note_tags;
         DROP TABLE notes_history;
         DROP TABLE note_chunks;
         DROP TABLE note_index_state;
         DROP TABLE encrypted_keys;
         ALTER TABLE notes_uuid_migrated RENAME TO notes;
         ALTER TABLE note_tags_uuid_migrated RENAME TO note_tags;
         ALTER TABLE notes_history_uuid_migrated RENAME TO notes_history;
         ALTER TABLE note_chunks_uuid_migrated RENAME TO note_chunks;
         ALTER TABLE note_index_state_uuid_migrated RENAME TO note_index_state;
         ALTER TABLE encrypted_keys_uuid_migrated RENAME TO encrypted_keys;
         CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
         CREATE INDEX IF NOT EXISTS idx_notes_history_note ON notes_history(note_id, id DESC);
         CREATE INDEX IF NOT EXISTS idx_note_chunks_note ON note_chunks(note_id);",
    )?;

    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('note_ids_uuid_v1', ?1)",
        params![Local::now().to_rfc3339()],
    )?;
    tx.commit()?;
    Ok(())
}

/* ---------------- 一次性迁移：分组主键 INTEGER → 短随机 ID(TEXT) ----------------
 * 与笔记迁移同款约束：已加密分组保留原数字 id 的字符串形式
 * （encrypted_keys 的 wrap AAD 里写死了旧 id），未加密分组换新随机 ID。
 * notes / notes_history 的 category_id 一并重建为 TEXT 并套用映射；
 * encrypted_keys 里 scope='category' 的 ref_id 同样过映射（加密的本来就是恒等映射）。
 */
pub(crate) fn migrate_category_ids_to_uuid(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // 已经是 TEXT 主键（新装库 / 迁移过）就直接打标记返回
    let id_type: Option<String> = tx
        .query_row(
            "SELECT type FROM pragma_table_info('categories') WHERE name = 'id'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if id_type
        .as_deref()
        .map(|t| t.eq_ignore_ascii_case("TEXT"))
        .unwrap_or(false)
    {
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('category_ids_uuid_v1', ?1)",
            params![Local::now().to_rfc3339()],
        )?;
        tx.commit()?;
        return Ok(());
    }

    // 旧 id（字符串形式）→ 新 id
    let mut mapping: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT CAST(c.id AS TEXT), COALESCE(c.is_encrypted, 0),
                    EXISTS(SELECT 1 FROM encrypted_keys k
                           WHERE k.scope = 'category' AND k.ref_id = CAST(c.id AS TEXT))
             FROM categories c",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (old_id, is_encrypted, has_key) = row?;
            let new_id = if is_encrypted != 0 || has_key != 0 {
                old_id.clone()
            } else {
                new_category_id()
            };
            mapping.insert(old_id, new_id);
        }
    }

    tx.execute_batch(
        "CREATE TABLE categories_uuid_migrated (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            ai_access INTEGER NOT NULL DEFAULT 2,
            is_encrypted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE notes_cat_migrated (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            deleted_at TEXT,
            is_pinned INTEGER DEFAULT 0,
            ai_access INTEGER NOT NULL DEFAULT 2,
            enc_mode INTEGER NOT NULL DEFAULT 0,
            enc_tags TEXT,
            source_plugin TEXT,
            -- 先指向 categories_uuid_migrated，RENAME 时 SQLite 会自动改写为 categories
            FOREIGN KEY (category_id) REFERENCES categories_uuid_migrated(id)
        );
        CREATE TABLE notes_history_cat_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id TEXT,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'auto',
            pinned INTEGER NOT NULL DEFAULT 0,
            saved_at TEXT NOT NULL
        );
        CREATE TABLE encrypted_keys_cat_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL CHECK(scope IN ('note','category')),
            ref_id TEXT NOT NULL,
            meta_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(scope, ref_id)
        );",
    )?;

    // categories
    {
        let mut read = tx.prepare(
            "SELECT CAST(id AS TEXT), name, created_at, ai_access, COALESCE(is_encrypted, 0)
             FROM categories",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO categories_uuid_migrated (id, name, created_at, ai_access, is_encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for row in rows {
            let r = row?;
            let id = mapping.get(&r.0).cloned().unwrap_or(r.0);
            write.execute(params![id, r.1, r.2, r.3, r.4])?;
        }
    }

    // notes：category_id 套映射（映射缺失说明指向已不存在的分组，原样保留）
    {
        let mut read = tx.prepare(
            "SELECT CAST(id AS TEXT), title, content, CAST(category_id AS TEXT),
                    created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access,
                    COALESCE(enc_mode, 0), enc_tags, source_plugin
             FROM notes",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO notes_cat_migrated
                (id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                 is_pinned, ai_access, enc_mode, enc_tags, source_plugin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for row in rows {
            let r = row?;
            let category_id = r.3.map(|c| mapping.get(&c).cloned().unwrap_or(c));
            write.execute(params![
                r.0,
                r.1,
                r.2,
                category_id,
                r.4,
                r.5,
                r.6.unwrap_or(0),
                r.7,
                r.8.unwrap_or(0),
                r.9,
                r.10,
                r.11,
                r.12
            ])?;
        }
    }

    // notes_history：同样套映射
    {
        let mut read = tx.prepare(
            "SELECT id, note_id, title, content, CAST(category_id AS TEXT), is_pinned, kind, pinned, saved_at
             FROM notes_history",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO notes_history_cat_migrated
                (id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for row in rows {
            let r = row?;
            let category_id = r.4.map(|c| mapping.get(&c).cloned().unwrap_or(c));
            write.execute(params![r.0, r.1, r.2, r.3, category_id, r.5, r.6, r.7, r.8])?;
        }
    }

    // encrypted_keys：category 作用域过映射，note 作用域原样保留（此时已是字符串）
    {
        let mut read = tx.prepare(
            "SELECT id, scope, CAST(ref_id AS TEXT), meta_json, created_at FROM encrypted_keys",
        )?;
        let rows = read.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut write = tx.prepare(
            "INSERT INTO encrypted_keys_cat_migrated (id, scope, ref_id, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for row in rows {
            let r = row?;
            let ref_id = if r.1 == "category" {
                mapping.get(&r.2).cloned().unwrap_or(r.2)
            } else {
                r.2
            };
            write.execute(params![r.0, r.1, ref_id, r.3, r.4])?;
        }
    }

    // 先删子表再删父表（rusqlite 默认开外键约束）
    tx.execute_batch(
        "DROP TABLE notes;
         DROP TABLE notes_history;
         DROP TABLE encrypted_keys;
         DROP TABLE categories;
         ALTER TABLE categories_uuid_migrated RENAME TO categories;
         ALTER TABLE notes_cat_migrated RENAME TO notes;
         ALTER TABLE notes_history_cat_migrated RENAME TO notes_history;
         ALTER TABLE encrypted_keys_cat_migrated RENAME TO encrypted_keys;
         CREATE INDEX IF NOT EXISTS idx_notes_history_note ON notes_history(note_id, id DESC);",
    )?;

    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('category_ids_uuid_v1', ?1)",
        params![Local::now().to_rfc3339()],
    )?;
    tx.commit()?;
    Ok(())
}

