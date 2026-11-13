use super::*;

/// 未分组笔记在选择列表里的键（前端「未分组」一项用它表示）
pub(crate) const SELECTION_UNGROUPED: &str = "__none__";

/// 恢复选项：要哪几类数据、冲突怎么处理、只恢复哪些分组。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSelection {
    pub categories: bool,
    pub notes: bool,
    pub tags: bool,
    pub history: bool,
    pub attachments: bool,
    pub providers: bool,
    pub sessions: bool,
    pub settings: bool,
    /// 同 id 冲突时保留本地版本（跳过备份条目）；默认 false = 用备份覆盖
    pub keep_local: bool,
    /// 只恢复这些分组 id（空 = 全部）；未分组用 `__none__` 表示
    pub category_ids: Vec<String>,
    /// 只恢复这些笔记 id（空 = 不限制）。非空时优先于分组范围：
    /// 分组只会带回来「被选中笔记所属的那几个」，避免恢复一堆空分组。
    pub note_ids: Vec<String>,
}

impl Default for BackupSelection {
    fn default() -> Self {
        Self {
            categories: true,
            notes: true,
            tags: true,
            history: true,
            attachments: true,
            providers: true,
            sessions: true,
            settings: true,
            keep_local: false,
            category_ids: Vec::new(),
            note_ids: Vec::new(),
        }
    }
}

impl BackupSelection {
    /// 给了笔记白名单时，只有名单内的笔记算选中
    pub(crate) fn note_selected(&self, note_id: &str) -> bool {
        self.note_ids.is_empty() || self.note_ids.iter().any(|id| id == note_id)
    }

    /// 某条笔记 / 某个分组是否在勾选范围内
    pub(crate) fn in_scope(&self, category_id: Option<&str>) -> bool {
        if self.category_ids.is_empty() {
            return true;
        }
        match category_id {
            Some(id) => self.category_ids.iter().any(|c| c == id),
            None => self.category_ids.iter().any(|c| c == SELECTION_UNGROUPED),
        }
    }
}

/// 预检里的一项分组：id / 名称 / 含多少笔记 / 是否加密
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupGroupInfo {
    pub id: String,
    pub name: String,
    pub notes: usize,
    pub encrypted: bool,
}

/// 预检里的一条笔记：够界面勾选与搜索，不带正文（几千篇正文会把摘要撑爆）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupNoteInfo {
    pub id: String,
    pub title: String,
    pub category_id: Option<String>,
    pub encrypted: bool,
    pub updated_at: String,
    /// 与本地同 id：会被覆盖（或按「保留本地」跳过）
    pub conflict: bool,
}

/// 预检里最多列出多少条笔记；超过就让用户改用分组筛选
pub(crate) const PREFLIGHT_NOTE_LIMIT: usize = 2000;

/// 恢复前的只读摘要：让用户在写库之前就知道「会发生什么」。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreflight {
    pub format: String,
    pub version: i64,
    pub exported_at: Option<String>,
    pub categories: usize,
    pub notes: usize,
    /// 加密笔记数（换机恢复需要原设备根密码）
    pub encrypted_notes: usize,
    pub encrypted_categories: usize,
    pub history: usize,
    pub tags: usize,
    pub attachments: usize,
    pub providers: usize,
    pub sessions: usize,
    pub messages: usize,
    pub settings: usize,
    /// 备份里带了密钥环（包裹后的 DEK）
    pub has_keyring: bool,
    /// 备份里带了根密码材料（app.security.root.*）
    pub has_root_key: bool,
    /// 与本地同 id 已存在的笔记数：会被覆盖（或按选择跳过）
    pub conflicts_notes: usize,
    pub conflicts_categories: usize,
    /// 本地是否已经设置过根密码：决定能不能直接采纳备份的根密码
    pub local_root_set: bool,
    pub groups: Vec<BackupGroupInfo>,
    /// 笔记清单（用于逐篇勾选）；超过上限时只给前 N 条
    pub note_list: Vec<BackupNoteInfo>,
    /// 笔记清单是否被截断
    pub note_list_truncated: bool,
}

/// 读 JSON 备份并做格式校验
/// 备份版本校验：比当前程序新就直接拒绝。
///
/// 不校验的后果不是「报错」，而是「报告成功」—— serde 会忽略不认识的字段、
/// 缺失字段走默认值：未来版本改了某个字段的语义后，旧程序恢复出来的数据是错的，
/// 界面却显示「恢复完成 N 篇笔记」。宁可当场拒绝，让用户去升级。
pub(crate) fn check_backup_version(doc: &Value) -> Result<(), String> {
    let version = doc.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    if version > BACKUP_VERSION as i64 {
        return Err(format!(
            "这份备份来自更新版本的 FastNote（备份版本 {version}，当前支持 {BACKUP_VERSION}），请先升级软件再恢复"
        ));
    }
    Ok(())
}

pub(crate) fn load_backup_doc(path: &str) -> Result<Value, String> {
    let text = read_backup_text(path)?;
    let doc: Value =
        serde_json::from_str(&text).map_err(|_| "备份文件不是合法的 JSON".to_string())?;
    if doc.get("format").and_then(|v| v.as_str()) != Some(BACKUP_FORMAT) {
        return Err("这不是 FastNote 的备份文件".to_string());
    }
    check_backup_version(&doc)?;
    Ok(doc)
}

/// 只读预检（JSON）：读文件 → 交给 `preflight_from_data` 统计
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn preflight_backup(state: State<AppState>, path: String) -> Result<BackupPreflight, String> {
    let doc = load_backup_doc(&path)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;
    preflight_from_data(
        &state,
        data,
        json_str(&doc, "format"),
        doc.get("version").and_then(|v| v.as_i64()).unwrap_or(0),
        doc.get("exported_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    )
}

/// 预检主体：JSON 备份与 SQLite 快照都转成同一份 `data` 结构后走这里。
pub(crate) fn preflight_from_data(
    state: &AppState,
    data: &Value,
    format: String,
    version: i64,
    exported_at: Option<String>,
) -> Result<BackupPreflight, String> {
    let categories = json_arr(data, "categories");
    let notes = json_arr(data, "notes");
    let settings = json_arr(data, "settings");

    // 本地已有的 id：用于统计「会被覆盖」的条数
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let local_notes: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM notes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let local_categories: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM categories")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let local_root_set: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'app.security.root.salt'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    drop(conn);

    // 每个分组装了几篇笔记：分组选择页要显示「恢复这个分组会带回来几篇」
    let mut per_group: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut ungrouped = 0usize;
    for n in notes {
        match json_opt_id(n, "category_id") {
            Some(id) => *per_group.entry(id).or_insert(0) += 1,
            None => ungrouped += 1,
        }
    }
    let mut groups: Vec<BackupGroupInfo> = categories
        .iter()
        .map(|c| {
            let id = json_id(c, "id");
            BackupGroupInfo {
                notes: per_group.get(&id).copied().unwrap_or(0),
                encrypted: json_bool_or(c, "is_encrypted", false),
                name: json_str(c, "name"),
                id,
            }
        })
        .collect();
    if ungrouped > 0 {
        groups.push(BackupGroupInfo {
            id: SELECTION_UNGROUPED.to_string(),
            name: String::new(),
            notes: ungrouped,
            encrypted: false,
        });
    }

    // 逐篇清单：界面用它做勾选与搜索，不带正文
    let note_list: Vec<BackupNoteInfo> = notes
        .iter()
        .take(PREFLIGHT_NOTE_LIMIT)
        .map(|n| {
            let id = json_id(n, "id");
            BackupNoteInfo {
                conflict: local_notes.contains(&id),
                category_id: json_opt_id(n, "category_id"),
                encrypted: json_i64(n, "enc_mode") != 0,
                title: json_str(n, "title"),
                updated_at: json_str(n, "updated_at"),
                id,
            }
        })
        .collect();

    let root_keys = ["app.security.root.salt", "app.security.root.verifier"];
    let has_root_key = settings
        .iter()
        .any(|s| root_keys.iter().any(|k| json_str(s, "key") == *k));

    Ok(BackupPreflight {
        format,
        version,
        exported_at,
        categories: categories.len(),
        notes: notes.len(),
        encrypted_notes: notes
            .iter()
            .filter(|n| json_i64(n, "enc_mode") != 0)
            .count(),
        encrypted_categories: categories
            .iter()
            .filter(|c| json_bool_or(c, "is_encrypted", false))
            .count(),
        history: json_arr(data, "notes_history").len(),
        tags: json_arr(data, "tags").len(),
        attachments: json_arr(data, "attachments").len(),
        providers: json_arr(data, "providers").len(),
        sessions: json_arr(data, "sessions").len(),
        messages: json_arr(data, "messages").len(),
        settings: settings.len(),
        has_keyring: !json_arr(data, "encrypted_keys").is_empty(),
        has_root_key,
        conflicts_notes: notes
            .iter()
            .filter(|n| local_notes.contains(&json_id(n, "id")))
            .count(),
        conflicts_categories: categories
            .iter()
            .filter(|c| local_categories.contains(&json_id(c, "id")))
            .count(),
        local_root_set,
        groups,
        note_list_truncated: notes.len() > PREFLIGHT_NOTE_LIMIT,
        note_list,
    })
}

/// 按勾选恢复：**合并**语义，只写选中分区，不删任何本地行。
///
/// 与 `import_backup` 的区别：
/// - `import_backup` = 清表重建（结果等于备份那一刻），本地独有内容靠恢复前快照补回；
/// - 本命令 = 直接 upsert，本地独有内容根本不会被碰，也不需要快照兜底。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_backup_selected(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    selection: BackupSelection,
) -> Result<BackupSummary, String> {
    let doc = load_backup_doc(&path)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;
    let exported_at = doc
        .get("exported_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    apply_backup_merge(&app, &state, &mut conn, data, &selection, exported_at)
}

/// 合并写入的公共实现：**JSON 备份与 SQLite 快照都走这里**。
///
/// 输入统一是与 `export_backup` 同构的 `data` 对象，所以两种备份格式的
/// 选择语义（分区、分组、笔记白名单、冲突策略）天然一致，不用各写一套。
pub(crate) fn apply_backup_merge(
    app: &AppHandle,
    state: &AppState,
    conn: &mut Connection,
    data: &Value,
    selection: &BackupSelection,
    exported_at: Option<String>,
) -> Result<BackupSummary, String> {
    // 本机现有的 Key 密文：按「名称+类型+地址」接回去，同机恢复不丢已填好的 Key
    let mut local_keys: std::collections::HashMap<(String, String, String), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT name, provider_type, api_base_url, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ),
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            local_keys.insert(row.0, row.1);
        }
    }

    let mut summary = BackupSummary {
        notes: 0,
        categories: 0,
        providers: 0,
        sessions: 0,
        messages: 0,
        settings: 0,
        skipped_encrypted: 0,
        exported_at,
        preserved: 0,
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // ---- 分组 ----
    /*
     * 勾选了具体笔记时，分组只带回来「这些笔记所属的那几个」：
     * 否则用户只想要 3 篇笔记，恢复完却多出一堆空分组。
     */
    let allowed_categories: Option<std::collections::HashSet<String>> =
        if selection.note_ids.is_empty() {
            None
        } else {
            Some(
                json_arr(data, "notes")
                    .iter()
                    .filter(|n| selection.note_selected(&json_id(n, "id")))
                    .filter_map(|n| json_opt_id(n, "category_id"))
                    .collect(),
            )
        };
    if selection.categories {
        for c in json_arr(data, "categories") {
            let id = json_id(c, "id");
            if !selection.in_scope(Some(&id)) {
                continue;
            }
            if let Some(allowed) = &allowed_categories {
                if !allowed.contains(&id) {
                    continue;
                }
            }
            // keep_local 用 OR IGNORE：本地已有的分组保留，只补缺
            let sql = if selection.keep_local {
                "INSERT OR IGNORE INTO categories (id, name, created_at, ai_access, is_encrypted)
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            } else {
                "INSERT INTO categories (id, name, created_at, ai_access, is_encrypted)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     ai_access = excluded.ai_access,
                     is_encrypted = excluded.is_encrypted"
            };
            tx.execute(
                sql,
                params![
                    id,
                    json_str(c, "name"),
                    non_empty_or_now(json_str(c, "created_at")),
                    json_level(c, "ai_access", 2),
                    if json_bool_or(c, "is_encrypted", false) { 1 } else { 0 }
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.categories += 1;
        }
    }

    // ---- 笔记 ----
    // 记下备份里每条笔记属于哪个分组，后面历史 / 标签关联要按同一份范围过滤
    let mut note_scope: std::collections::HashSet<String> = std::collections::HashSet::new();
    if selection.notes {
        for n in json_arr(data, "notes") {
            let id = json_id(n, "id");
            let category_id = json_opt_id(n, "category_id");
            if !selection.in_scope(category_id.as_deref()) || !selection.note_selected(&id) {
                continue;
            }
            note_scope.insert(id.clone());
            let sql = if selection.keep_local {
                "INSERT OR IGNORE INTO notes (id, title, content, category_id, created_at, updated_at,
                                              is_deleted, deleted_at, is_pinned, ai_access, enc_mode, enc_tags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
            } else {
                "INSERT INTO notes (id, title, content, category_id, created_at, updated_at,
                                    is_deleted, deleted_at, is_pinned, ai_access, enc_mode, enc_tags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                     title = excluded.title,
                     content = excluded.content,
                     category_id = excluded.category_id,
                     updated_at = excluded.updated_at,
                     is_deleted = excluded.is_deleted,
                     deleted_at = excluded.deleted_at,
                     is_pinned = excluded.is_pinned,
                     ai_access = excluded.ai_access,
                     enc_mode = excluded.enc_mode,
                     enc_tags = excluded.enc_tags"
            };
            tx.execute(
                sql,
                params![
                    id,
                    json_str(n, "title"),
                    json_str(n, "content"),
                    category_id,
                    non_empty_or_now(json_str(n, "created_at")),
                    non_empty_or_now(json_str(n, "updated_at")),
                    if json_bool(n, "is_deleted") { 1 } else { 0 },
                    json_opt_str(n, "deleted_at"),
                    if json_bool_or(n, "is_pinned", false) { 1 } else { 0 },
                    json_level(n, "ai_access", 2),
                    json_i64(n, "enc_mode"),
                    json_opt_str(n, "enc_tags")
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.notes += 1;
        }

        // 密钥环：加密笔记的 DEK。缺了它带回来的密文就是打不开的死壳。
        // keep_local 时用 OR IGNORE，避免把本地已经迁移过的包裹结果顶掉。
        for k in json_arr(data, "encrypted_keys") {
            tx.execute(
                "INSERT OR IGNORE INTO encrypted_keys (scope, ref_id, meta_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    json_str(k, "scope"),
                    json_str(k, "ref_id"),
                    json_str(k, "meta_json"),
                    non_empty_or_now(json_str(k, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- 历史版本 ----
    if selection.history {
        for h in json_arr(data, "notes_history") {
            let note_id = json_id(h, "note_id");
            // 笔记不在本次恢复范围 → 连带历史也不恢复，避免留下孤儿版本
            if !note_scope.contains(&note_id) {
                continue;
            }
            let saved_at = non_empty_or_now(json_str(h, "saved_at"));
            // 历史表的 id 是自增主键：不搬备份里的 id，改按「同一笔记 + 同一时间点」去重，
            // 重复恢复同一份备份不会堆出一串一模一样的版本。
            tx.execute(
                "INSERT INTO notes_history (note_id, title, content, category_id, is_pinned, kind,
                                            pinned, saved_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
                 WHERE NOT EXISTS (
                     SELECT 1 FROM notes_history WHERE note_id = ?1 AND saved_at = ?8
                 )",
                params![
                    note_id,
                    json_str(h, "title"),
                    json_str(h, "content"),
                    json_opt_id(h, "category_id"),
                    if json_bool_or(h, "is_pinned", false) { 1 } else { 0 },
                    normalize_history_kind(&json_str_or(h, "kind", HISTORY_KIND_AUTO)),
                    if json_bool_or(h, "pinned", false) { 1 } else { 0 },
                    saved_at
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- 标签 ----
    if selection.tags {
        for t in json_arr(data, "tags") {
            tx.execute(
                "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    json_i64(t, "id"),
                    json_str(t, "name"),
                    normalize_source(Some(json_str(t, "source"))),
                    non_empty_or_now(json_str(t, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        for nt in json_arr(data, "note_tags") {
            if !note_scope.contains(&json_id(nt, "note_id")) {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    json_id(nt, "note_id"),
                    json_i64(nt, "tag_id"),
                    normalize_source(Some(json_str(nt, "source"))),
                    non_empty_or_now(json_str(nt, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- AI 服务商 ----
    if selection.providers {
        for p in json_arr(data, "providers") {
            let api_key = match json_opt_str(p, "api_key").filter(|k| !k.is_empty()) {
                Some(plain) => encrypt_secret(&tx, &plain)?,
                None => local_keys
                    .get(&(
                        json_str(p, "name"),
                        json_str(p, "provider_type"),
                        json_str(p, "api_base_url"),
                    ))
                    .cloned()
                    .unwrap_or_default(),
            };
            let enabled_models = p
                .get("enabled_models")
                .and_then(|v| v.as_array())
                .map(|list| {
                    let models: Vec<&str> = list.iter().filter_map(|m| m.as_str()).collect();
                    serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
                })
                .unwrap_or_else(|| "[]".to_string());
            tx.execute(
                "INSERT OR REPLACE INTO ai_providers
                    (id, name, provider_type, api_base_url, api_key, api_path,
                     enabled_model, enabled_models, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    json_i64(p, "id"),
                    json_str(p, "name"),
                    json_str(p, "provider_type"),
                    json_str(p, "api_base_url"),
                    api_key,
                    json_opt_str(p, "api_path"),
                    json_opt_str(p, "enabled_model"),
                    enabled_models,
                    non_empty_or_now(json_str(p, "created_at")),
                    non_empty_or_now(json_str(p, "updated_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.providers += 1;
        }
    }

    // ---- AI 对话 ----
    if selection.sessions {
        for s in json_arr(data, "sessions") {
            tx.execute(
                "INSERT OR REPLACE INTO ai_chat_sessions
                    (id, title, provider_id, model, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    json_i64(s, "id"),
                    json_str(s, "title"),
                    json_i64(s, "provider_id"),
                    json_str(s, "model"),
                    non_empty_or_now(json_str(s, "created_at")),
                    non_empty_or_now(json_str(s, "updated_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.sessions += 1;
        }
        for m in json_arr(data, "messages") {
            tx.execute(
                "INSERT OR REPLACE INTO ai_chat_messages
                    (id, session_id, role, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    json_i64(m, "id"),
                    json_i64(m, "session_id"),
                    json_str(m, "role"),
                    json_str(m, "content"),
                    non_empty_or_now(json_str(m, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.messages += 1;
        }
    }

    // ---- 设置 ----
    if selection.settings {
        for st in json_arr(data, "settings") {
            let key = json_str(st, "key");
            // 根密码材料绝不在这里采纳：换掉它会让本机已有的加密笔记立刻失效。
            // 换机解锁走 verify_backup_root_password + import_backup_root_key 那条显式通道。
            if key.starts_with("app.security.") {
                continue;
            }
            let mut value = json_str(st, "value");
            if key == "webdav.password" && !value.is_empty() && !is_encrypted(&value) {
                value = encrypt_secret(&tx, &value)?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![key, value, non_empty_or_now(json_str(st, "updated_at"))],
            )
            .map_err(|e| e.to_string())?;
            summary.settings += 1;
        }
    }

    // ---- 图片 ----
    if selection.attachments {
        restore_backup_attachments(app, &tx, json_arr(data, "attachments"))?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    semantic::invalidate(&state.semantic);

    // 恢复是「一年用一次、那次必须查得清」的操作：条数写进日志，事后能对上账
    crate::log_info!(
        "restore done: notes {} · groups {} · providers {} · sessions {} · messages {} · settings {} · preserved {}",
        summary.notes,
        summary.categories,
        summary.providers,
        summary.sessions,
        summary.messages,
        summary.settings,
        summary.preserved
    );
    Ok(summary)
}


/* ---------------- SQLite 快照的选择性恢复 ----------------
 *
 * .db 快照本质是一个完整库文件，但它和 JSON 备份描述的是同一件事。
 * 这里把它读成与 `export_backup` 同构的 `data` 对象，然后复用同一套
 * `preflight_from_data` / `apply_backup_merge`——选择语义、冲突策略、
 * 加密处理全部一致，不需要为第二种格式再写一遍。
 */

