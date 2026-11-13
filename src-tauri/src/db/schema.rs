use super::*;

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

