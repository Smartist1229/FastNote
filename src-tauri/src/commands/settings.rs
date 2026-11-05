use chrono::Local;
use rusqlite::params;
use tauri::State;
use crate::AppState;

/* ---------------- 应用设置（键值对） ----------------
 * 所有设置都存在 app_settings 表里：读不到某个键时由前端回退到默认值，
 * 因此升级/新增设置项都不需要迁移脚本。
 */

#[tauri::command]
pub fn get_app_settings(
    state: State<AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        // 根密码的盐/校验块属于加密内部元数据，不暴露给前端业务层。
        .prepare("SELECT key, value FROM app_settings WHERE key NOT LIKE 'app.security.%'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        map.insert(key, value);
    }
    Ok(map)
}

#[tauri::command]
pub fn set_app_setting(key: String, value: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_app_setting(key: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}
