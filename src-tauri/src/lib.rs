use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};
use chrono::{Local, Duration};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub category_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub is_deleted: bool,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub note_count: i32,
}

struct AppState {
    conn: Mutex<Connection>,
}

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            deleted_at TEXT,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )",
        [],
    )?;

    Ok(())
}

#[tauri::command]
fn create_category(name: String, state: State<AppState>) -> Result<Category, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "INSERT INTO categories (name, created_at) VALUES (?1, ?2)",
        params![name, now],
    ).map_err(|e| e.to_string())?;
    
    let id = conn.last_insert_rowid();
    
    Ok(Category {
        id,
        name,
        created_at: now,
        note_count: 0,
    })
}

#[tauri::command]
fn get_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    let conn = state.conn.lock().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.created_at, COUNT(n.id) as note_count
         FROM categories c
         LEFT JOIN notes n ON c.id = n.category_id AND n.is_deleted = 0
         GROUP BY c.id, c.name, c.created_at
         ORDER BY c.created_at DESC"
    ).map_err(|e| e.to_string())?;
    
    let categories = stmt.query_map([], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            note_count: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;
    
    let mut result = Vec::new();
    for category in categories {
        result.push(category.map_err(|e| e.to_string())?);
    }
    
    Ok(result)
}

#[tauri::command]
fn update_category(id: i64, name: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    conn.execute(
        "UPDATE categories SET name = ?1 WHERE id = ?2",
        params![name, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn delete_category(id: i64, delete_notes: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    if delete_notes {
        conn.execute(
            "DELETE FROM notes WHERE category_id = ?1",
            params![id],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE notes SET category_id = NULL WHERE category_id = ?1",
            params![id],
        ).map_err(|e| e.to_string())?;
    }
    
    conn.execute(
        "DELETE FROM categories WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn create_note(title: String, content: String, category_id: Option<i64>, state: State<AppState>) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "INSERT INTO notes (title, content, category_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![title, content, category_id, now, now],
    ).map_err(|e| e.to_string())?;
    
    let id = conn.last_insert_rowid();
    
    Ok(Note {
        id,
        title,
        content,
        category_id,
        created_at: now.clone(),
        updated_at: now,
        is_deleted: false,
        deleted_at: None,
    })
}

fn map_row_to_note(row: &rusqlite::Row) -> Result<Note, rusqlite::Error> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        category_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        is_deleted: row.get(6)?,
        deleted_at: row.get(7)?,
    })
}

#[tauri::command]
fn get_notes(category_id: Option<i64>, sort_by: String, sort_order: String, state: State<AppState>) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();
    
    let order_direction = if sort_order == "asc" { "ASC" } else { "DESC" };
    
    let order_clause = match sort_by.as_str() {
        "created_at" => format!("ORDER BY created_at {}", order_direction),
        "updated_at" => format!("ORDER BY updated_at {}", order_direction),
        "title" => format!("ORDER BY title {}", if sort_order == "asc" { "ASC" } else { "DESC" }),
        _ => format!("ORDER BY updated_at {}", order_direction),
    };
    
    let sql = if let Some(_cat_id) = category_id {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at 
             FROM notes 
             WHERE is_deleted = 0 AND category_id = ?1 
             {}",
            order_clause
        )
    } else {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at 
             FROM notes 
             WHERE is_deleted = 0 
             {}",
            order_clause
        )
    };
    
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    
    let notes_iter = if let Some(cat_id) = category_id {
        stmt.query_map(params![cat_id], map_row_to_note).map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], map_row_to_note).map_err(|e| e.to_string())?
    };
    
    let mut result = Vec::new();
    for note in notes_iter {
        result.push(note.map_err(|e| e.to_string())?);
    }
    
    Ok(result)
}

#[tauri::command]
fn update_note(id: i64, title: String, content: String, category_id: Option<i64>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, category_id = ?3, updated_at = ?4 WHERE id = ?5",
        params![title, content, category_id, now, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn move_to_trash(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn restore_note(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    conn.execute(
        "UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn get_trash_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at 
         FROM notes 
         WHERE is_deleted = 1 
         ORDER BY deleted_at DESC"
    ).map_err(|e| e.to_string())?;
    
    let notes = stmt.query_map([], map_row_to_note).map_err(|e| e.to_string())?;
    
    let mut result = Vec::new();
    for note in notes {
        result.push(note.map_err(|e| e.to_string())?);
    }
    
    Ok(result)
}

#[tauri::command]
fn delete_note_permanently(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    conn.execute(
        "DELETE FROM notes WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn delete_multiple_notes_permanently(ids: Vec<i64>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    for id in ids {
        conn.execute(
            "DELETE FROM notes WHERE id = ?1",
            params![id],
        ).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

#[tauri::command]
fn cleanup_old_trash(state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let thirty_days_ago = Local::now() - Duration::days(30);
    let threshold = thirty_days_ago.to_rfc3339();
    
    conn.execute(
        "DELETE FROM notes WHERE is_deleted = 1 AND deleted_at < ?1",
        params![threshold],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            create_category,
            get_categories,
            update_category,
            delete_category,
            create_note,
            get_notes,
            update_note,
            move_to_trash,
            restore_note,
            get_trash_notes,
            delete_note_permanently,
            delete_multiple_notes_permanently,
            cleanup_old_trash,
        ])
        .setup(|app| {
            let data_dir = match std::env::current_exe() {
                Ok(exe_path) => {
                    if let Some(exe_dir) = exe_path.parent() {
                        let install_data_dir = exe_dir.join("data");
                        if std::fs::create_dir_all(&install_data_dir).is_ok() {
                            install_data_dir
                        } else {
                            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
                            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
                            app_data_dir
                        }
                    } else {
                        let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
                        std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
                        app_data_dir
                    }
                }
                Err(_) => {
                    let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
                    std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
                    app_data_dir
                }
            };
            
            let db_path = data_dir.join("fastnote.db");
            
            let conn = Connection::open(db_path).expect("failed to open database");
            init_database(&conn).expect("failed to initialize database");
            
            let state = AppState {
                conn: Mutex::new(conn),
            };
            
            app.manage(state);
            
            let window = app.get_webview_window("main").expect("main window not found");
            
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
                        
                        if cursor_pos.x >= x1 && cursor_pos.x <= x2 && 
                           cursor_pos.y >= y1 && cursor_pos.y <= y2 {
                            target_monitor = Some(monitor);
                            break;
                        }
                    }
                    
                    if let Some(monitor) = target_monitor {
                        let monitor_pos = monitor.position();
                        let monitor_size = monitor.size();
                        
                        let window_width = 1200.0;
                        let window_height = 800.0;
                        
                        let center_x = monitor_pos.x as f64 + (monitor_size.width as f64 / 2.0) - (window_width / 2.0);
                        let center_y = monitor_pos.y as f64 + (monitor_size.height as f64 / 2.0) - (window_height / 2.0);
                        
                        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                            x: center_x,
                            y: center_y,
                        }));
                    }
                }
            }
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
