use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

/// 短随机 ID：base62（0-9A-Za-z）× 12 位 ≈ 71.5 bit 熵。
/// 生日界约 8e10 条记录才有 50% 碰撞概率，本地笔记库绰绰有余，主键约束兜底。
const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SHORT_ID_LEN: usize = 12;

/// 生成 12 位 base62 短随机 ID（如 `3xK9fQ2mA7bR`）。
/// 不用「截断 UUID」：截断 hex 12 位只剩 48 bit 熵，碰撞概率高几个数量级；
/// 这里让 UUID v4 的整个 128 bit 随机源逐字节参与编码。
fn new_short_id() -> String {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut id = String::with_capacity(SHORT_ID_LEN);
    for b in bytes.iter().take(SHORT_ID_LEN) {
        id.push(BASE62[(b % 62) as usize] as char);
    }
    id
}

/// 生成新的笔记主键（短随机 ID，TEXT）
pub(crate) fn new_note_id() -> String {
    new_short_id()
}

/// 生成新的分组主键（与笔记同一生成器）
pub(crate) fn new_category_id() -> String {
    new_short_id()
}

/// 判断某张表是否存在（用于读取可选的数据表）
pub(crate) fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

/// 判断某张表是否已有指定列（用于幂等迁移）
pub(crate) fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows,
        Err(_) => return false,
    };
    for name in rows.flatten() {
        if name == column {
            return true;
        }
    }
    false
}

pub(crate) fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            ai_access INTEGER NOT NULL DEFAULT 2
        )",
        [],
    )?;

    conn.execute(
        // 主键是随机短 ID（TEXT）。旧库的迁移见文件末尾 migrate_note_ids_to_uuid /
        // migrate_category_ids_to_uuid：已加密的笔记/分组保留原数字 id 字符串
        //（密文 AAD 里写死了它，换掉会永久解不开）。
        "CREATE TABLE IF NOT EXISTS notes (
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
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            api_base_url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            api_path TEXT,
            enabled_model TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            provider_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id)
        )",
        [],
    )?;

    // ---- 应用设置（AI 设置、记忆/前置提示词等）----
    // 键值对形式：每个设置一行，缺键时前端自动回退到默认值。
    // 老版本用 localStorage 存的设置会在首次读取时迁移进来（见前端 migrateLocalSettings）。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    /*
     * ---- 笔记内图片（附件）----
     * 字节落在 <数据目录>/attachments/<hash 前两位>/<hash>.<ext>，这里只存元数据：
     * - width/height 供预览提前占位，图片解码完不会把行高撑开（避免长文滚动条跳动）；
     * - data 平时为 NULL，只在 .db 快照备份时把字节写进快照，保证「一个 .db 文件」
     *   就能完整恢复（见 commands/backup.rs 的快照导出）。
     * 不存引用关系：谁引用了图片由正文扫描得出，见 src/attachments.rs 的 gc_attachments。
     */
    conn.execute(
        "CREATE TABLE IF NOT EXISTS attachments (
            hash TEXT PRIMARY KEY,
            ext TEXT NOT NULL,
            mime TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            data BLOB,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    /*
     * ---- 标签（跨分组的主题检索）----
     * 一篇笔记只能进一个分组，标签是第二条维度：多对多，用来回答「所有和 X 相关的笔记」。
     *
     * `source` 记在**关联表**上而不是标签上：同一个词（比如「待办」）可能用户自己打过、
     * 也被 AI 打过，把它拆成两个 tag 行会让计数与去重都变得很难解释。
     * 标签行的 source 表示「这个词最初是谁建的」，只用于展示；删除与否看关联表。
     */
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            source TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_tags (
            note_id TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL,
            PRIMARY KEY (note_id, tag_id)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)",
        [],
    )?;

    // ---- 笔记历史版本 ----
    // 内容/标题/分组变化前把旧版本存进来，但距上一条历史不足间隔时不重复记
    // （app.config.general.noteHistoryIntervalMinutes，默认 5 分钟）。
    // 超出上限（noteHistoryLimit）时只删中间的旧版本，最早一条始终保留。
    // 永久删除笔记时一并清理，回滚只恢复这几列（标签、AI 访问权限不动）。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id TEXT,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'auto',
            pinned INTEGER NOT NULL DEFAULT 0,
            saved_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_notes_history_note ON notes_history(note_id, id DESC)",
        [],
    )?;
    // ---- 迁移：历史版本来源与固定标记 ----
    // kind 区分自动 / 打开笔记时的会话基线 / 手动保存（早期数据还可能有回滚前快照）；
    // pinned 标记用户固定、永不自动清理的版本。
    if !has_column(conn, "notes_history", "kind") {
        conn.execute(
            "ALTER TABLE notes_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'",
            [],
        )?;
    }
    if !has_column(conn, "notes_history", "pinned") {
        conn.execute(
            "ALTER TABLE notes_history ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // ---- 迁移：多选模型列表 ----
    // 老库只有 enabled_model（单选），这里补上 enabled_models（JSON 数组）并把旧值回填进去
    if !has_column(conn, "ai_providers", "enabled_models") {
        conn.execute(
            "ALTER TABLE ai_providers ADD COLUMN enabled_models TEXT",
            [],
        )?;
    }
    let legacy: Vec<(i64, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, enabled_model FROM ai_providers
             WHERE (enabled_models IS NULL OR TRIM(enabled_models) = '')
               AND enabled_model IS NOT NULL AND TRIM(enabled_model) <> ''",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.flatten().collect()
    };
    for (id, model) in legacy {
        if let Some(model) = model {
            let json = serde_json::to_string(&vec![model]).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "UPDATE ai_providers SET enabled_models = ?1 WHERE id = ?2",
                params![json, id],
            )?;
        }
    }

    // ---- 迁移：笔记置顶字段 ----
    if !has_column(conn, "notes", "is_pinned") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN is_pinned INTEGER DEFAULT 0",
            [],
        )?;
    }

    // ---- 迁移：AI 访问档位（0=禁止 / 1=只读 / 2=完全）----
    // 老库默认全开，行为与升级前一致；档位分「分组」和「笔记」两级，实际生效取更严格的。
    if !has_column(conn, "notes", "ai_access") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN ai_access INTEGER NOT NULL DEFAULT 2",
            [],
        )?;
    }
    if !has_column(conn, "categories", "ai_access") {
        conn.execute(
            "ALTER TABLE categories ADD COLUMN ai_access INTEGER NOT NULL DEFAULT 2",
            [],
        )?;
    }

    // 一次性数据迁移：早期版本把 ai_access 当布尔用（1=开放），
    // 三档之后 1 表示"只读"。若不迁移，升级会把开放过的笔记静默降级成只读。
    // 用 schema_migrations 记住"已迁移"，否则每次启动都会把用户手动设的只读改成完全。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )",
        [],
    )?;
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = 'ai_access_levels_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if done == 0 {
        conn.execute("UPDATE notes SET ai_access = 2 WHERE ai_access = 1", [])?;
        conn.execute(
            "UPDATE categories SET ai_access = 2 WHERE ai_access = 1",
            [],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('ai_access_levels_v2', ?1)",
            params![Local::now().to_rfc3339()],
        )?;
    }

    // ---- 语义搜索 ----
    // 向量按块存（一篇笔记多行），文本与向量同表：检索命中后直接取片段，不必回查 notes。
    // 这里不建外键：永久删除笔记时由索引 worker 统一清孤儿，避免删除路径到处补级联。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_chunks (
            note_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            text TEXT NOT NULL,
            dim INTEGER NOT NULL,
            embedding BLOB NOT NULL,
            PRIMARY KEY (note_id, seq)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_chunks_note ON note_chunks(note_id)",
        [],
    )?;
    // 脏判定：notes.updated_at 与本表不一致（或本表无记录）就该重建该笔记的块。
    // 不用内容哈希——写入方只要碰过 updated_at 就会触发，创建/导入/恢复都自动覆盖。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_index_state (
            note_id TEXT PRIMARY KEY,
            note_updated_at TEXT NOT NULL,
            model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    // ---- 笔记 / 分组加密 ----
    // 密文与密钥元数据分开存：enc_mode 决定读路径，enc_tags 是标签快照密文，
    // encrypted_keys 里只有盐与被密码包裹的 DEK，没有明文密码。
    if !has_column(conn, "notes", "enc_mode") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN enc_mode INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !has_column(conn, "notes", "enc_tags") {
        conn.execute("ALTER TABLE notes ADD COLUMN enc_tags TEXT", [])?;
    }
    if !has_column(conn, "categories", "is_encrypted") {
        conn.execute(
            "ALTER TABLE categories ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS encrypted_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL CHECK(scope IN ('note','category')),
            -- 文本存 id：笔记是 UUID，分组是数字 id 的字符串形式。
            -- 加密的 AAD 里直接拼这个值，所以旧加密笔记迁移后必须保留原数字串。
            ref_id TEXT NOT NULL,
            meta_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(scope, ref_id)
        )",
        [],
    )?;

    // ---- 迁移：插件写笔记沙箱字段 ----
    // source_plugin 记录笔记由哪个插件创建；插件更新/删除笔记前必须校验它等于自己的 dir_name。
    // 现有笔记一律填 NULL（宿主创建），不影响读路径。
    if !has_column(conn, "notes", "source_plugin") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN source_plugin TEXT",
            [],
        )?;
    }

    // 主键类型迁移放在最后：上面所有 ALTER TABLE 补列都已完成，重建表时才能一次带上全部列
    migrate_note_ids_to_uuid(conn)?;
    migrate_category_ids_to_uuid(conn)?;

    Ok(())
}

/* ---------------- 一次性迁移：笔记主键 INTEGER → 短随机 ID(TEXT) ----------------
 * SQLite 不能就地改主键类型，只能「建新表 → 逐行搬数据 → 删旧表 → 改名 → 重建索引」。
 *
 * 已加密的笔记保留原来的数字 id（写成字符串）：
 * 密文 AAD 与 encrypted_keys 的 wrap AAD 里都拼进了旧 id，
 * 改 id 会让已有密文永久解不开，而重新包裹又必须先在运行时拿到用户密码。
 * 未加密笔记没有这个约束，一律换成随机 UUID。
 */
fn migrate_note_ids_to_uuid(conn: &Connection) -> rusqlite::Result<()> {
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
fn migrate_category_ids_to_uuid(conn: &Connection) -> rusqlite::Result<()> {
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
