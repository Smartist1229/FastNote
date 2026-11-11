use ring::rand::{SystemRandom, SecureRandom};
use rusqlite::{params, Connection};
use sha2::{Sha256, Digest};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

mod attachments;
mod autostart;
mod browser;
mod commands;
mod crypto;
mod db;
mod download;
mod encryption;
mod fingerprint;
mod i18n;
mod models;
mod opener;
mod plugins;
mod repaint;
mod semantic;
mod tray;
mod updater;
mod webdav;

use autostart::{launched_from_autostart, read_single_instance_enabled, sync_autostart_shortcut};
use db::init_database;
use tray::{create_tray, show_main_window};

pub use models::*;
pub(crate) use commands::categories::*;
pub(crate) use commands::notes::*;
pub(crate) use commands::tags::*;
pub(crate) use commands::history::*;
pub(crate) use commands::trash::*;
pub(crate) use commands::ai::*;
pub(crate) use commands::settings::*;
pub(crate) use commands::backup::*;
pub(crate) use commands::system::*;
pub(crate) use commands::shortcuts::*;
pub(crate) use plugins::*;
// 图片附件：命令与协议 handler 都从这里进
pub(crate) use attachments::{get_attachment_meta, attachments_usage, gc_attachments, save_attachment};

struct AppState {
    conn: Mutex<Connection>,
    semantic: semantic::SemanticState,
    download: download::DownloadState,
    webdav: webdav::WebdavState,
    updater: updater::UpdateState,
    encryption: encryption::EncryptionState,
    /// AI 请求运行时：复用的 HTTP 客户端 + 按 requestId 的取消标志
    ai: commands::ai::AiRuntime,
}

/// 解析数据库中的模型列表（JSON 数组 TEXT）
pub(crate) fn parse_models_json(raw: Option<String>) -> Vec<String> {
    let text = raw.unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(trimmed)
        .map(|models| {
            let mut seen = std::collections::HashSet::new();
            models
                .into_iter()
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty() && seen.insert(m.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// 主键冲突判定：随机短 id 撞车（SQLITE_CONSTRAINT_PRIMARYKEY）时才允许调用方换 id 重试，
/// 名称唯一索引等其他约束冲突不在此列。
pub(crate) fn is_primary_key_conflict(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(err, _)
        if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY)
}

pub(crate) fn map_row_to_note(row: &rusqlite::Row) -> Result<Note, rusqlite::Error> {
    // 使用列名获取，兼容旧数据没有 is_pinned 列的情况
    let is_pinned: i64 = match row.as_ref().column_index("is_pinned") {
        Ok(_) => row.get("is_pinned")?,
        Err(_) => 0,
    };
    // ai_access 一律按列名读取：所有 note 查询都必须带上这一列，漏了会直接报错，
    // 而不是悄悄把受保护的笔记当成"对 AI 开放"
    let ai_access: i64 = row.get::<_, i64>("ai_access")?.clamp(0, 2);
    // 老查询/老备份没有 enc_mode 列时按未加密处理，行为与升级前一致。
    let enc_mode: i64 = match row.as_ref().column_index("enc_mode") {
        Ok(_) => row.get("enc_mode")?,
        Err(_) => 0,
    };
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        category_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        is_deleted: row.get(6)?,
        deleted_at: row.get(7)?,
        is_pinned: is_pinned != 0,
        ai_access,
        enc_mode,
        is_locked: false,
        enc_hint: None,
    })
}

/* ---------------- API Key 加密存储 ----------------
 * 目标：数据库文件里绝不出现明文 Key。
 *
 * 方案：AES-256-GCM（ring）+ 独立密钥文件，密钥再与"当前用户 + 机器名"绑定派生。
 * 为什么不用非对称加密：本机应用如果把私钥随程序一起发出去，等于把钥匙和锁放一起，
 * 起不到保护作用；真正有效的是"密钥不写在数据库里、且换台机器/换个用户解不开"，
 * 这正是下面这套做法提供的性质。
 *
 * 存储格式：enc:v1:<hex(12 字节 nonce || 密文+tag)>；不带前缀的一律视为历史明文。
 */
const ENC_PREFIX: &str = "enc:v1:";

const KEY_FILE: &str = "fastnote.key";

fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(ENC_PREFIX)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err("密文格式不正确".into());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).ok_or("密文格式不正确")?;
        let lo = (pair[1] as char).to_digit(16).ok_or("密文格式不正确")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

/// 取（必要时生成）主密钥：文件存在则读，不存在则随机生成 32 字节写入。
/// 密钥文件与数据库同目录，但**不在数据库里**；复制走数据库文件也解不开。
fn load_or_create_master_key(conn: &Connection) -> Result<[u8; 32], String> {
    let db_path = conn.path().ok_or("无法定位数据库文件，不能保存加密密钥")?;
    let key_path = std::path::Path::new(db_path)
        .parent()
        .ok_or("数据库目录不可用")?
        .join(KEY_FILE);
    let raw = if key_path.exists() {
        std::fs::read(&key_path).map_err(|e| format!("读取密钥文件失败：{e}"))?
    } else {
        let mut buf = [0u8; 32];
        SystemRandom::new()
            .fill(&mut buf)
            .map_err(|_| "生成随机密钥失败".to_string())?;
        std::fs::write(&key_path, buf).map_err(|e| format!("写入密钥文件失败：{e}"))?;
        buf.to_vec()
    };
    if raw.len() < 32 {
        return Err("密钥文件已损坏（长度不足）".into());
    }
    // 再与当前用户 + 机器名混合派生：换用户或换机器都解不开
    let mut hasher = Sha256::new();
    hasher.update(&raw);
    hasher.update(b"|fastnote-api-key-v1|");
    hasher.update(std::env::var("USERNAME").unwrap_or_default().as_bytes());
    hasher.update(b"|");
    hasher.update(std::env::var("COMPUTERNAME").unwrap_or_default().as_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    Ok(key)
}

fn aead_key(conn: &Connection) -> Result<ring::aead::LessSafeKey, String> {
    let key = load_or_create_master_key(conn)?;
    let unbound = ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, &key)
        .map_err(|_| "初始化加密器失败".to_string())?;
    Ok(ring::aead::LessSafeKey::new(unbound))
}

/// 加密：返回 enc:v1:<hex>，空串原样返回（没填 Key 时不必加密）
pub(crate) fn encrypt_secret(conn: &Connection, plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if is_encrypted(plain) {
        return Ok(plain.to_string());
    }
    let key = aead_key(conn)?;
    let mut nonce_bytes = [0u8; ring::aead::NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成随机数失败".to_string())?;
    let nonce = ring::aead::Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plain.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, ring::aead::Aad::empty(), &mut in_out)
        .map_err(|_| "加密失败".to_string())?;
    let mut payload = nonce_bytes.to_vec();
    payload.extend_from_slice(&in_out);
    Ok(format!("{ENC_PREFIX}{}", to_hex(&payload)))
}

/// 解密：非密文（历史明文）原样返回，交由调用方迁移
pub(crate) fn decrypt_secret(conn: &Connection, stored: &str) -> Result<String, String> {
    if !is_encrypted(stored) {
        return Ok(stored.to_string());
    }
    let key = aead_key(conn)?;
    let raw = from_hex(&stored[ENC_PREFIX.len()..])?;
    if raw.len() <= ring::aead::NONCE_LEN {
        return Err("密文长度不正确".into());
    }
    let (nonce_bytes, cipher_text) = raw.split_at(ring::aead::NONCE_LEN);
    let nonce = ring::aead::Nonce::try_assume_unique_for_key(nonce_bytes)
        .map_err(|_| "密文 nonce 不正确".to_string())?;
    let mut buf = cipher_text.to_vec();
    let plain = key
        .open_in_place(nonce, ring::aead::Aad::empty(), &mut buf)
        .map_err(|_| "解密失败（密钥文件可能已更换或损坏）".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|_| "解密结果不是合法文本".to_string())
}

/* ---------------- 单实例 / 托盘 / 窗口管理 ----------------
 * 全部由 Rust 侧驱动，不依赖前端 JS（JS 只在设置变化时下发指令）：
 *   - 单实例：run() 里注册 tauri-plugin-single-instance（命名互斥量，跨进程有效），
 *     第二个实例启动时会回调这里 → 聚焦已有窗口并自行退出。
 *     开关在库里（app.config.general.singleInstance，默认开）：插件一旦注册就必然创建
 *     互斥量、且无法在注册后再撤销，所以只能在 Builder 之前先读一次设置再决定是否注册。
 *   - 托盘：setup() 里用 TrayIconBuilder 创建，生命周期归 Rust 所有；
 *     即使窗口隐藏、webview 不再执行 JS，托盘依然存在。
 *   - 关闭行为：on_window_event(CloseRequested) 读库里的设置，
 *     决定「隐藏到托盘」还是「退出应用」。
 */

/// 库文件名：解析数据目录后拼上它就是数据库路径
const DB_FILE_NAME: &str = "fastnote.db";

/// 兜底用的包标识：与 tauri.conf.json 的 identifier 一致（只在 dirs 兜底分支用到）
const APP_IDENTIFIER: &str = "com.smartist.fastnote";

/**
 * 不让内核把「不可见窗口」当成可回收的后台页。
 *
 * 主窗口的同一组参数写在 tauri.conf.json 的 additionalBrowserArgs 里；但内置浏览器、
 * 插件窗口各自用了**独立 user data folder**（WebView2 要求同目录环境参数完全一致，
 * 混用会建环境失败），拿不到配置里那份，只能在这里补一遍。
 *
 * 少了这三项，窗口最小化久了会被 Chromium 判定为后台/被遮挡：渲染进程被降频甚至暂停，
 * 恢复时合成面不重建，表现就是「整页空白」。这里刻意不带 msSmartScreenProtection，
 * 内置浏览器要保留下载安全检查。
 */
pub(crate) const BACKGROUND_SAFE_WEBVIEW_ARGS: &str =
    "--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";

/**
 * 数据目录：优先 exe 同级的 data（便携模式，拷走整个目录就带着数据走），
 * 否则退回系统应用数据目录（与 tauri 的 app_data_dir 同规则：dirs::data_dir()/identifier）。
 *
 * 两处都要用：run() 里读单例开关时还没有 AppHandle，setup() 里才拿得到 tauri 的路径。
 * 抽成一个函数是为了保证两边算出同一个库文件——算出不同路径等于换了个空库。
 *
 * @param app_data_dir tauri 解析出的应用数据目录；run() 阶段传 None，此时用 dirs 兜底
 */
pub(crate) fn resolve_data_dir(app_data_dir: Option<std::path::PathBuf>) -> std::path::PathBuf {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let install_data_dir = exe_dir.join("data");
            if std::fs::create_dir_all(&install_data_dir).is_ok() {
                return install_data_dir;
            }
        }
    }
    app_data_dir.unwrap_or_else(|| {
        dirs::data_dir()
            .map(|d| d.join(APP_IDENTIFIER))
            .unwrap_or_else(|| std::path::PathBuf::from("data"))
    })
}

/// 读取 app_settings 表里某个键的原始字符串值（值以 JSON 文本存储）
fn read_setting_raw(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    let conn = state.conn.lock().ok()?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// 读布尔设置；缺失或解析失败时回退 fallback
pub(crate) fn read_setting_bool(app: &AppHandle, key: &str, fallback: bool) -> bool {
    read_setting_raw(app, key)
        .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
        .unwrap_or(fallback)
}

/// 读字符串设置；缺失或解析失败时回退 fallback
fn read_setting_string(app: &AppHandle, key: &str, fallback: &str) -> String {
    read_setting_raw(app, key)
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
        .unwrap_or_else(|| fallback.to_string())
}

/// 读无符号数值设置；缺失、为负数或解析失败时回退 fallback
pub(crate) fn read_setting_u64(app: &AppHandle, key: &str, fallback: u64) -> u64 {
    read_setting_raw(app, key)
        .and_then(|raw| serde_json::from_str::<u64>(&raw).ok())
        .unwrap_or(fallback)
}

struct AppLocaleState(Mutex<String>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 单实例开关必须在 Builder 之前读：插件一旦注册就必然创建互斥量，事后无法撤销。
    // 关掉时干脆不注册——第二实例不会创建互斥量，也就不会被挡下，可以真正多开。
    let single_instance = read_single_instance_enabled(None);
    let mut builder = tauri::Builder::default();
    if single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 已有实例在运行：呼出它的窗口（窗口可能正处于隐藏/最小化状态）
            show_main_window(app);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // 自动更新：检查 / 下载 / 安装由 updater 负责，安装后重启由 process 负责
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 全局热键：注册表由前端整体下发（见 commands/shortcuts.rs），按下后回传动作 id
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 插件模块自定义协议：插件 entry 以真实 URL 动态 import，
        // 浏览器原生解析模块内的相对路径 import（插件可拆多文件）
        .register_uri_scheme_protocol(plugins::PLUGIN_SCHEME, |_ctx, request| {
            plugins::handle_plugin_scheme_request(&request)
        })
        // 笔记内图片协议：正文里写的是相对路径 attachments/xx/hash.ext，
        // 渲染时由前端转成 fastnote-asset:// 交给内核取字节（只服务附件根目录内的图片）
        .register_uri_scheme_protocol(attachments::ASSET_SCHEME, |ctx, request| {
            attachments::handle_asset_request(ctx.app_handle(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            create_category,
            get_categories,
            update_category,
            delete_category,
            create_note,
            get_notes,
            get_note,
            update_note,
            get_note_history,
            delete_note_history_entry,
            clear_note_history,
            create_note_history_version,
            snapshot_note_session,
            set_note_history_pinned,
            rollback_note_history,
            set_note_ai_access,
            set_category_ai_access,
            list_tags,
            list_note_tags,
            add_note_tags,
            remove_note_tags,
            set_note_tags,
            rename_tag,
            delete_tag,
            list_notes_by_tag,
            pin_note,
            move_to_trash,
            restore_note,
            get_trash_notes,
            delete_note_permanently,
            delete_multiple_notes_permanently,
            cleanup_old_trash,
            encryption::encryption_status,
            encryption::encryption_info,
            encryption::set_root_password,
            encryption::unlock_root,
            encryption::change_root_password,
            encryption::encrypt_note,
            encryption::unlock_note,
            encryption::lock_note,
            encryption::lock_all,
            encryption::decrypt_note,
            encryption::encrypt_category,
            encryption::unlock_category,
            encryption::lock_category,
            encryption::decrypt_category,
            encryption::crypto_scrub_flush,
            encryption::encryption_self_check,
            create_ai_provider,
            get_ai_providers,
            update_ai_provider,
            delete_ai_provider,
            fetch_ai_models,
            send_ai_chat,
            send_ai_chat_stream,
            cancel_ai_chat,
            create_chat_session,
            get_chat_sessions,
            get_chat_messages,
            save_chat_message,
            update_chat_session_title,
            delete_chat_session,
            get_app_settings,
            set_app_setting,
            delete_app_setting,
            export_backup,
            import_backup,
            preflight_backup,
            preflight_sqlite_backup,
            import_backup_selected,
            import_sqlite_selected,
            verify_backup_root_password,
            import_backup_root_key,
            migrate_backup_root_wrap,
            export_sqlite_backup,
            import_sqlite_backup,
            export_encrypted_backup,
            import_encrypted_backup,
            webdav::webdav_status,
            webdav::webdav_set_password,
            webdav::webdav_test,
            webdav::webdav_backup,
            webdav::webdav_list_remote,
            webdav::webdav_restore_remote,
            webdav::webdav_list_local,
            webdav::webdav_restore_local,
            webdav::webdav_backup_dir,
            webdav::webdav_local_state,
            webdav::webdav_snapshot_local,
            webdav::webdav_save_copy,
            export_category_zip,
            export_category_ebook,
            export_notes_zip,
            export_notes_ebook,
            read_text_file,
            write_text_file,
            get_system_locale,
            set_app_locale,
            set_tray_enabled,
            set_autostart_enabled,
            should_show_on_startup,
            semantic::semantic_status,
            semantic::semantic_download_model,
            semantic::semantic_delete_model,
            semantic::semantic_import_model,
            semantic::semantic_rebuild_index,
            semantic::semantic_cancel_index,
            semantic::semantic_search,
            #[cfg(debug_assertions)]
            semantic::semantic_debug_embed,
            download::toolbox_download,
            download::toolbox_download_cancel,
            download::toolbox_download_pause,
            download::toolbox_download_dir,
            fingerprint::fingerprint_info,
            browser::browser_open,
            browser::browser_random_fingerprint,
            browser::browser_toolbar_state,
            browser::browser_toolbar_action,
            browser::browser_toolbar_navigate,
            browser::browser_download_pause,
            browser::browser_download_cancel,
            browser::browser_download_forget,
            browser::browser_download_clear,
            browser::browser_toolbar_panel,
            opener::open_app_folder,
            opener::reveal_app_file,
            updater::probe_update_lines,
            updater::download_update,
            updater::install_downloaded_update,
            plugin_list_installed,
            plugin_install_zip,
            plugin_folder_path,
            plugin_uninstall,
            plugin_read_resource,
            plugin_install_demo,
            plugin_db_create_table,
            plugin_db_drop_table,
            plugin_db_tables,
            plugin_db_insert,
            plugin_db_query,
            plugin_db_update,
            plugin_db_delete,
            plugin_open_window,
            plugin_close_window,
            plugin_close_windows,
            plugin_reactivate,
            plugin_db_drop_all,
            plugin_db_count,
            plugin_db_add_column,
            plugin_db_create_index,
            plugin_db_list_all_tables,
            plugin_fs_root,
            plugin_fs_list,
            plugin_fs_read,
            plugin_fs_write,
            plugin_fs_remove,
            plugin_net_fetch,
            plugin_module_url,
            plugin_icon_url,
            plugin_read_config,
            plugin_write_config,
            plugin_create_note,
            plugin_update_note,
            plugin_delete_note,
            sync_global_shortcuts,
            // 笔记内图片
            save_attachment,
            get_attachment_meta,
            attachments_usage,
            gc_attachments,
        ])
        .setup(|app| {
            // 与 run() 里读开关时同一套解析规则，保证两边是同一个库文件
            let data_dir = resolve_data_dir(app.path().app_data_dir().ok());
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                panic!("failed to create app data dir: {e}");
            }

            let db_path = data_dir.join(DB_FILE_NAME);

            let conn = Connection::open(db_path).expect("failed to open database");
            /*
             * 连接级参数。全库只有一个可写连接（`AppState::conn` 里的 Mutex），
             * 但手动保存、AI 工具写入、历史快照、语义索引 worker 都要抢它，
             * 默认的 rollback journal 加上没有超时，会让"正在写"直接返回 SQLITE_BUSY。
             *
             * - WAL：读不挡写、写不挡读，自动保存期间列表查询不会被卡住；
             *   代价是多出 -wal / -shm 两个附属文件。备份不受影响：快照走 `VACUUM INTO`
             *   （见 build_sqlite_snapshot，与日志模式无关，且生成后会切回 DELETE 单文件），
             *   webdav 也是先快照再上传，不直接拷活库。
             * - synchronous=NORMAL：WAL 下的推荐值，断电最多丢最后一个事务、不会坏库；
             *   默认 FULL 会让每次 500ms 防抖的自动保存都 fsync 一次。
             * - busy_timeout：等锁最多 5 秒再报错，而不是立刻把 SQLITE_BUSY 抛给界面。
             * - secure_delete：删除/覆盖加密前的明文行时清零旧页。
             *   **WAL 下被覆盖的页会留在 -wal 里直到 checkpoint**，所以"落盘即净"的路径
             *   必须显式 checkpoint：加解密后统一走 encryption.rs 的 `scrub()` →
             *   `wal_checkpoint(TRUNCATE)`，空闲时 `crypto_scrub_flush` 再做一次
             *   checkpoint + VACUUM，把明文页真正抹掉。改加密流程时别绕开这两个入口。
             * - temp_store=MEMORY：VACUUM / 排序的临时结构留在内存，不落磁盘临时目录。
             */
            let _ = conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA secure_delete = ON;
                 PRAGMA temp_store = MEMORY;",
            );
            init_database(&conn).expect("failed to initialize database");

            let state = AppState {
                conn: Mutex::new(conn),
                semantic: semantic::SemanticState::default(),
                download: download::DownloadState::default(),
                webdav: webdav::WebdavState::default(),
                updater: updater::UpdateState::default(),
                encryption: encryption::EncryptionState::default(),
                ai: commands::ai::AiRuntime::default(),
            };

            app.manage(state);
            let language = read_setting_string(app.handle(), "app.config.general.language", "system");
            let system = i18n::system_locale();
            app.manage(AppLocaleState(Mutex::new(
                i18n::resolve_locale(&language, system.as_deref()).to_string(),
            )));
            webdav::spawn_auto_backup(app.handle().clone());
            // 旧版本模型放在应用数据目录，搬进便携数据目录后再启动索引
            semantic::model::migrate_legacy(app.handle());
            // 索引 worker 自己轮询开关与模型状态，未开启时每 2 秒空转一次，几乎无开销
            semantic::spawn_worker(app.handle().clone());
            // 内置插件首次运行种到 <exe>/plugin/（有标记则跳过），失败不阻断启动
            plugins::seed_builtin_plugins(app.handle());

            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            if let Ok(cursor_pos) = window.cursor_position() {
                if let Ok(monitors) = app.available_monitors() {
                    let mut target_monitor = None;

                    for monitor in monitors {
                        let pos = monitor.position();
                        let size = monitor.size();

                        let x1 = pos.x as f64;
                        let y1 = pos.y as f64;
                        let x2 = (pos.x + size.width as i32) as f64;
                        let y2 = (pos.y + size.height as i32) as f64;

                        if cursor_pos.x >= x1
                            && cursor_pos.x <= x2
                            && cursor_pos.y >= y1
                            && cursor_pos.y <= y2
                        {
                            target_monitor = Some(monitor);
                            break;
                        }
                    }

                    if let Some(monitor) = target_monitor {
                        let monitor_pos = monitor.position();
                        let monitor_size = monitor.size();

                        let window_width = 1200.0;
                        let window_height = 800.0;

                        let center_x = monitor_pos.x as f64 + (monitor_size.width as f64 / 2.0)
                            - (window_width / 2.0);
                        let center_y = monitor_pos.y as f64 + (monitor_size.height as f64 / 2.0)
                            - (window_height / 2.0);

                        let _ =
                            window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                                x: center_x,
                                y: center_y,
                            }));
                    }
                }
            }

            // 开机启动：只在快捷方式与库里的设置不一致时对齐一次，正常启动不会重写
            sync_autostart_shortcut(app.handle());

            // 托盘图标：按库里的设置决定是否创建（读不到键时默认开启）
            let tray_on = read_setting_bool(app.handle(), "app.config.general.trayEnabled", true);
            if tray_on {
                if let Err(e) = create_tray(app.handle()) {
                    eprintln!("创建托盘图标失败：{}", e);
                }
            }

            // 开机自启动拉起时：只有设置里选了「开机后最小化到托盘」且托盘图标已开启，才隐藏窗口。
            // 其余情况都正常显示（托盘没开时隐藏会让用户失去找回窗口的入口）。
            let minimize_to_tray =
                read_setting_bool(app.handle(), "app.config.general.minimizeToTray", false);
            if launched_from_autostart() && minimize_to_tray && tray_on {
                let _ = window.hide();
            } else {
                /*
                 * 不在这里直接 show：窗口一显示，系统会先画出 webview 的空白帧
                 * （深色主题是黑屏、浅色是白屏），之后才轮到 index.html 里的加载页。
                 * 正常路径由前端 main.tsx 在首帧画完后自己 show()，这里只做兜底：
                 * 前端脚本出错 / 加载失败时窗口不能永远不出现。
                 */
                let fallback = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !fallback.is_visible().unwrap_or(true) {
                        let _ = fallback.show();
                        let _ = fallback.set_focus();
                    }
                });
            }

            Ok(())
        })
        // 关闭窗口行为：读库里的设置，决定「隐藏到托盘」还是「退出应用」
        .on_window_event(|window, event| {
            // 内置浏览器窗口：尺寸变化时重排工具栏与网页两个子 WebView
            browser::handle_window_event(window, event);
            // 最小化久了再恢复，WebView2 的合成面可能停在 0×0（整页空白）：
            // 这里按尺寸事件记时并在恢复时补一次 bounds 变化，逼内核重绘
            if let tauri::WindowEvent::Resized(size) = event {
                repaint::on_resized(window, *size);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let behavior =
                    read_setting_string(app, "app.config.general.closeBehavior", "minimize");
                let tray_on = read_setting_bool(app, "app.config.general.trayEnabled", true);
                if behavior == "minimize" && tray_on {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
