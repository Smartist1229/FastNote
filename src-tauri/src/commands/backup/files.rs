use super::*;

#[derive(Debug)]
pub struct ZipEntry {
    name: String,
    /// 二进制：分组导出要把图片原样打进包，文本只是其中一种
    content: Vec<u8>,
}

/// 压缩包「其他文件格式」下，单篇笔记自选的后缀
#[derive(Debug, Deserialize)]
pub struct NoteFormatSpec {
    id: String,
    ext: String,
}

/// 按顺序写进 zip；EPUB 要求 mimetype 必须是第一个条目且不压缩，这里按名字特殊处理
pub(crate) fn write_zip_file(path: &str, entries: &[ZipEntry]) -> Result<(), String> {    use std::io::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let file = std::fs::File::create(path).map_err(|e| format!("创建压缩包失败：{e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    for entry in entries {
        let options = if entry.name == "mimetype" {
            stored
        } else {
            deflated
        };
        zip.start_file(entry.name.as_str(), options)
            .map_err(|e| format!("写入 {0} 失败：{1}", entry.name, e))?;
        zip.write_all(&entry.content)
            .map_err(|e| format!("写入 {0} 失败：{1}", entry.name, e))?;
    }

    zip.finish().map_err(|e| format!("生成压缩包失败：{e}"))?;
    Ok(())
}

/// 导出诊断包：环境信息 + 最近两份日志，打成 zip。
///
/// **不含数据库、不含笔记正文** —— 只取日志文本、文件大小、条数这类数字。
/// 有它，用户报「备份失败 / 白屏」时点一下把 zip 发过来就够排障；
/// 没有它，用户唯一的出口是「打开日志目录然后自己压缩」，等于没有出口。
#[tauri::command]
pub fn export_diagnostics(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<String, String> {
    let log_dir = crate::logger::dir();
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());

    let mut report = String::new();
    report.push_str("FastNote diagnostics\n");
    report.push_str(&format!("generated at: {}\n", Local::now().to_rfc3339()));
    report.push_str(&format!("version: {}\n", app.package_info().version));
    report.push_str(&format!(
        "platform: {} {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    report.push_str(&format!("data dir: {}\n", data_dir.display()));
    report.push_str(&format!("log dir: {}\n", log_dir.display()));

    if let Ok(meta) = std::fs::metadata(data_dir.join("fastnote.db")) {
        report.push_str(&format!(
            "database size: {:.1} MB\n",
            meta.len() as f64 / 1_048_576.0
        ));
    }

    /*
     * 规模 + 最近一次云备份的状态：这两项能直接区分
     * 「库里东西太多传不上去」和「网络 / 账号 / 权限问题」。
     */
    if let Ok(conn) = state.conn.lock() {
        let notes: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE is_deleted = 0", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        let categories: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap_or(0);
        report.push_str(&format!("notes: {notes} · groups: {categories}\n"));
        for key in [
            "webdav.lastAutoBackupAt",
            "webdav.lastAutoFile",
            "webdav.lastAutoError",
        ] {
            if let Ok(value) = conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            ) {
                report.push_str(&format!("{key}：{value}\n"));
            }
        }
    }

    let mut entries = vec![ZipEntry {
        name: "diagnostics.txt".to_string(),
        content: report.into_bytes(),
    }];

    // 最近两份日志：够覆盖「刚才出的事」，又不至于把包撑到几十兆
    let mut logs: Vec<std::path::PathBuf> = std::fs::read_dir(&log_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|file| file.extension().is_some_and(|ext| ext == "log"))
        .collect();
    logs.sort();
    for log_path in logs.iter().rev().take(2) {
        let Some(name) = log_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Ok(bytes) = std::fs::read(log_path) {
            entries.push(ZipEntry {
                name: format!("logs/{name}"),
                content: bytes,
            });
        }
    }

    write_zip_file(&path, &entries)?;
    crate::log_info!("exported diagnostics: {path} ({} log files)", logs.len().min(2));
    Ok(path)
}

/// Markdown → HTML 片段
pub(crate) fn md_to_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(text, options));
    out
}

pub(crate) fn esc_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 文件名清洗：去掉 Windows 不允许的字符，截断长度，空标题用兜底名
pub(crate) fn safe_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows 下结尾的点和空格会被截掉，这里主动去掉
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 清洗用户自选的后缀：只留字母数字，避免路径穿越与非法文件名；空值退回 txt。
/// 白名单在前端维护（src/config/textFileFormats.ts），这里只做文件名安全兜底。
pub(crate) fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .trim()
        .trim_start_matches('.')
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if cleaned.is_empty() {
        "txt".to_string()
    } else {
        cleaned
    }
}

/// 按指定 ID 列表加载未删除的笔记，保持传入顺序
pub(crate) fn load_notes_by_ids(conn: &Connection, note_ids: &[String]) -> Result<Vec<Note>, String> {
    if note_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                    is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0 AND id = ?1 AND COALESCE(enc_mode, 0) = 0",
        )
        .map_err(|e| e.to_string())?;
    let mut notes = Vec::with_capacity(note_ids.len());
    for id in note_ids {
        let mut rows = stmt
            .query_map(params![id], map_row_to_note)
            .map_err(|e| e.to_string())?;
        if let Some(row) = rows.next() {
            notes.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(notes)
}

/// 单篇笔记的完整 HTML 页面
pub(crate) fn note_html_page(title: &str, content: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n<style>\nbody{{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,\"Microsoft YaHei\",sans-serif;line-height:1.8;color:#1e293b}}\npre{{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}}\ncode{{background:#f1f5f9;padding:2px 4px;border-radius:4px}}\ntable{{border-collapse:collapse}}th,td{{border:1px solid #e2e8f0;padding:6px 10px}}\nblockquote{{border-left:3px solid #cbd5e1;margin:0;padding-left:14px;color:#64748b}}\nimg{{display:block;max-width:100%;max-height:80vh;width:auto;height:auto;margin:1.2em auto;border-radius:6px}}\nh1{{border-bottom:1px solid #e2e8f0;padding-bottom:8px}}\n</style>\n</head>\n<body>\n<h1>{}</h1>\n{}\n</body>\n</html>\n",
        esc_html(title),
        esc_html(title),
        md_to_html(content)
    )
}

/// 把笔记引用到的图片打进压缩包（放在 zip 根目录的 `attachments/` 下）。
///
/// 正文里写的就是相对路径 `attachments/xx/hash.ext`，落进压缩包后位置不变，
/// 所以 Markdown **一个字都不用改**，解压后 Typora / Obsidian / VS Code 直接能看。
/// 只打包本次导出范围内笔记引用到的图，不多带一张。
pub(crate) fn push_attachment_entries(app: &AppHandle, notes: &[Note], entries: &mut Vec<ZipEntry>) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for note in notes {
        for path in crate::attachments::collect_attachment_paths(&note.content) {
            if !seen.insert(path.clone()) {
                continue;
            }
            if let Some(bytes) = crate::attachments::read_attachment_bytes(app, &path) {
                entries.push(ZipEntry {
                    name: path,
                    content: bytes,
                });
            }
        }
    }
}

/// 导出指定笔记 ID 列表为压缩包：一篇笔记一个文件。
/// format 是预设格式；note_formats 非空时表示「其他文件格式」逐篇自选后缀，此时以逐篇后缀为准。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_notes_zip(
    app: AppHandle,
    state: State<AppState>,
    note_ids: Vec<String>,
    path: String,
    format: String,
    note_formats: Option<Vec<NoteFormatSpec>>,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let notes = load_notes_by_ids(&conn, &note_ids)?;
    if notes.is_empty() {
        return Err("没有选定笔记，没什么可导出的".to_string());
    }

    let global_ext = match format.as_str() {
        "txt" => "txt",
        "html" => "html",
        "json" => "json",
        _ => "md",
    }
    .to_string();
    let per_note: std::collections::HashMap<String, String> = note_formats
        .unwrap_or_default()
        .into_iter()
        .map(|spec| (spec.id, sanitize_ext(&spec.ext)))
        .collect();

    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut entries = Vec::with_capacity(notes.len());
    for (i, note) in notes.iter().enumerate() {
        // 逐篇自选的后缀优先，没有就用预设格式
        let ext = per_note
            .get(&note.id)
            .cloned()
            .unwrap_or_else(|| global_ext.clone());
        let base = safe_filename(&note.title, &format!("未命名笔记-{}", i + 1));
        let count = used.entry(base.to_lowercase()).or_insert(0);
        *count += 1;
        let name = if *count > 1 {
            format!("{base}-{count}.{ext}")
        } else {
            format!("{base}.{ext}")
        };

        // 后缀决定落盘内容：html / json 有专门形态，其余（含逐篇自选的后缀）都是原文直出
        let content = match ext.as_str() {
            "html" => note_html_page(&note.title, &note.content),
            "json" => serde_json::to_string_pretty(&json!({
                "title": note.title,
                "content": note.content,
                "created_at": note.created_at,
                "updated_at": note.updated_at,
            }))
            .unwrap_or_default(),
            _ => note.content.clone(),
        };

        entries.push(ZipEntry { name, content: content.into_bytes() });
    }

    // 把引用到的图片一并打进包（正文里的相对路径与 zip 根目录下的 attachments/ 对齐）
    push_attachment_entries(&app, &notes, &mut entries);
    let total = notes.len();
    write_zip_file(&path, &entries)?;
    Ok(total)
}

/// 导出指定笔记 ID 列表为电子书
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_notes_ebook(
    app: AppHandle,
    state: State<AppState>,
    note_ids: Vec<String>,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let notes = load_notes_by_ids(&conn, &note_ids)?;
    if notes.is_empty() {
        return Err("没有选定笔记，没什么可导出的".to_string());
    }

    // EPUB 的书名走文件元数据：直接用用户填的文件名，不再出现程序生成的标题
    let title = std::path::Path::new(&path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("笔记")
        .to_string();

    match format.as_str() {
        "html" => {
            let text = ebook_single_html(&app, &notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
        "epub" => {
            let entries = ebook_epub_entries(&app, &title, &notes);
            write_zip_file(&path, &entries)?;
            Ok(notes.len())
        }
        _ => {
            // txt：章节之间用分隔线断开，正文是 Markdown 原文
            let text = ebook_plain_text(&notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
    }
}

/// 单文件 HTML 电子书：目录 + 各章锚点，可直接用浏览器看
pub(crate) fn ebook_single_html(app: &AppHandle, notes: &[Note]) -> String {
    let mut toc = String::new();
    let mut body = String::new();
    for (i, note) in notes.iter().enumerate() {
        let anchor = format!("chapter-{}", i + 1);
        toc.push_str(&format!(
            "<li><a href=\"#{anchor}\">{}</a></li>\n",
            esc_html(&note.title)
        ));
        /*
         * 单文件 HTML 要能「发给谁都能打开」，图片直接内联成 data URI：
         * 不依赖附件目录、不联网。先改写 Markdown 再渲染，正文其余部分保持原样。
         */
        let inlined = crate::attachments::map_attachment_paths(&note.content, &|path| {
            let bytes = crate::attachments::read_attachment_bytes(app, path)?;
            Some(format!(
                "data:{};base64,{}",
                crate::attachments::mime_of_attachment(path),
                crate::attachments::base64_encode(&bytes)
            ))
        });
        body.push_str(&format!(
            "<section id=\"{anchor}\">\n<h2>{}</h2>\n{}\n</section>\n",
            esc_html(&note.title),
            md_to_html(&inlined)
        ));
    }
    // 沉浸式正文：不出现书名大标题，页面标题取第一章标题
    let page_title = notes
        .first()
        .map(|note| note.title.trim())
        .filter(|title| !title.is_empty())
        .unwrap_or("笔记");
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n<style>\nbody{{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,\"Microsoft YaHei\",sans-serif;line-height:1.8;color:#1e293b}}\npre{{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}}\ncode{{background:#f1f5f9;padding:2px 4px;border-radius:4px}}\ntable{{border-collapse:collapse}}th,td{{border:1px solid #e2e8f0;padding:6px 10px}}\nblockquote{{border-left:3px solid #cbd5e1;margin:0;padding-left:14px;color:#64748b}}\nimg{{display:block;max-width:100%;max-height:80vh;width:auto;height:auto;margin:1.2em auto;border-radius:6px}}\nsection{{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0}}\n.toc{{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 24px}}\n</style>\n</head>\n<body>\n<nav class=\"toc\">\n<h3>目录</h3>\n<ol>\n{}</ol>\n</nav>\n{}\n</body>\n</html>\n",
        esc_html(page_title),
        toc,
        body
    )
}

/// 纯文本电子书：只按章节拼接，不出现书名与章节数，正文是 Markdown 原文
pub(crate) fn ebook_plain_text(notes: &[Note]) -> String {
    let mut text = String::new();
    for (i, note) in notes.iter().enumerate() {
        if i > 0 {
            text.push('\n');
        }
        text.push_str(&format!(
            "{}\n{}\n\n{}\n",
            note.title,
            "-".repeat(40),
            note.content
        ));
    }
    text
}

/// EPUB（EPUB 3）：本质是特定结构的 zip
///
/// 图片作为包内资源放 `OEBPS/images/<hash>.<ext>`，章节里把
/// `attachments/xx/hash.ext` 改写成 `images/<hash>.<ext>`，
/// 并在 `content.opf` 的 manifest 里补上对应 `<item>`——否则阅读器不认这些资源。
pub(crate) fn ebook_epub_entries(app: &AppHandle, title: &str, notes: &[Note]) -> Vec<ZipEntry> {
    use std::collections::HashMap;

    let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let book_id = format!("urn:fastnote:{}", chrono::Utc::now().timestamp());

    let mut manifest = String::new();
    let mut spine = String::new();
    let mut nav = String::new();

    let mut entries = Vec::with_capacity(notes.len() + 4);

    // mimetype 必须是第一个条目且不压缩（write_zip_file 按名字处理）
    entries.push(ZipEntry {
        name: "mimetype".to_string(),
        content: b"application/epub+zip".to_vec(),
    });
    entries.push(ZipEntry {
        name: "META-INF/container.xml".to_string(),
        content: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n  <rootfiles>\n    <rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n  </rootfiles>\n</container>\n".as_bytes().to_vec(),
    });

    // 先把整本书引用到的图片收进来：同一张图在多个章节里只打一份
    let mut image_map: HashMap<String, String> = HashMap::new();
    let mut image_index = 0usize;
    for note in notes {
        for path in crate::attachments::collect_attachment_paths(&note.content) {
            if image_map.contains_key(&path) {
                continue;
            }
            let Some(bytes) = crate::attachments::read_attachment_bytes(app, &path) else {
                continue;
            };
            let file_name = path.rsplit('/').next().unwrap_or("image.png").to_string();
            image_index += 1;
            let media_type = crate::attachments::mime_of_attachment(&path);
            manifest.push_str(&format!(
                "    <item id=\"img{image_index}\" href=\"images/{file_name}\" media-type=\"{media_type}\"/>\n"
            ));
            entries.push(ZipEntry {
                name: format!("OEBPS/images/{file_name}"),
                content: bytes,
            });
            image_map.insert(path, format!("images/{file_name}"));
        }
    }

    for (i, note) in notes.iter().enumerate() {
        let index = i + 1;
        let href = format!("chapter-{index}.xhtml");
        manifest.push_str(&format!(
            "    <item id=\"chap{index}\" href=\"{href}\" media-type=\"application/xhtml+xml\"/>\n"
        ));
        spine.push_str(&format!("    <itemref idref=\"chap{index}\"/>\n"));
        nav.push_str(&format!(
            "      <li><a href=\"{href}\">{}</a></li>\n",
            esc_html(&note.title)
        ));

        // 图片路径改写成包内相对路径；找不到文件的引号原样留下（阅读器显示破图，但正文不丢）
        let content = crate::attachments::map_attachment_paths(&note.content, &|path| {
            image_map.get(path).cloned()
        });

        entries.push(ZipEntry {
            name: format!("OEBPS/{href}"),
            content: format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\" lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>{}</title>\n<style>img{{max-width:100%;height:auto}}</style>\n</head>\n<body>\n<h1>{}</h1>\n{}\n</body>\n</html>\n",
                esc_html(&note.title),
                esc_html(&note.title),
                md_to_html(&content)
            )
            .into_bytes(),
        });
    }

    let nav_doc = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"zh-CN\" lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>目录</title>\n</head>\n<body>\n<nav epub:type=\"toc\" id=\"toc\">\n<h1>目录</h1>\n<ol>\n{nav}</ol>\n</nav>\n</body>\n</html>\n"
    );

    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\">\n  <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n    <dc:identifier id=\"bookid\">{book_id}</dc:identifier>\n    <dc:title>{title}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <meta property=\"dcterms:modified\">{modified}</meta>\n  </metadata>\n  <manifest>\n    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n{manifest}  </manifest>\n  <spine>\n{spine}  </spine>\n</package>\n",
        title = esc_html(title)
    );

    entries.push(ZipEntry {
        name: "OEBPS/nav.xhtml".to_string(),
        content: nav_doc.into_bytes(),
    });
    entries.push(ZipEntry {
        name: "OEBPS/content.opf".to_string(),
        content: opf.into_bytes(),
    });

    entries
}

/* ---------------- 电脑文本文件读写 ----------------
 * 「拖入/打开电脑文件」功能用：读取时做文本检测（NUL 字节 / UTF-8），
 * 写入时用同目录临时文件原子替换，避免写一半把原文件写坏。
 */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TextFileInfo {
    pub path: String,
    pub name: String,
    pub content: String,
}

/// 单文件大小上限：超过就不允许打开，避免把超大文件塞进编辑器
pub(crate) const TEXT_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 非文本检测的取样长度：只看开头这一段的 NUL 字节
pub(crate) const TEXT_FILE_SNIFF_BYTES: usize = 8 * 1024;

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<TextFileInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("不是可打开的文件".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读取文件失败：{}", e))?;
    if meta.len() > TEXT_FILE_MAX_BYTES {
        return Err("文件过大，暂不支持打开".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败：{}", e))?;
    let sniff_len = bytes.len().min(TEXT_FILE_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0u8) {
        return Err("这不是文本文件".to_string());
    }
    // 去掉 UTF-8 BOM，避免编辑器里出现多余字符
    let text_bytes: &[u8] = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes
    };
    let content =
        String::from_utf8(text_bytes.to_vec()).map_err(|_| "不是 UTF-8 文本文件".to_string())?;
    // 展示用文件名去掉扩展名（如 note.md → note），避免分组/编辑页标题带后缀
    let name = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(TextFileInfo {
        path,
        name,
        content,
    })
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = p.parent().ok_or_else(|| "无效的文件路径".to_string())?;
    let file_name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无效的文件路径".to_string())?;
    let tmp = dir.join(format!(".{}.fastnote.tmp", file_name));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败：{}", e))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败：{}", e)
    })?;
    Ok(())
}



