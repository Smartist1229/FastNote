//! 语义索引的分块：把 Markdown 正文切成适合 BGE 的短块。
//!
//! 纯函数、无 IO，便于单测。两条硬约束：
//! - **按字符切，不按字节切**：中文在 UTF-8 里占 3 字节，字节下标会 panic。
//! - 落块与嵌入文本分开：`text` 存原文（给搜索结果做片段），
//!   `embedding_text` 才在块前拼标题（提升短笔记与标题词的召回）。

/// 目标块长：拼到这么长就落块
pub const TARGET_CHARS: usize = 280;
/// 单块硬上限
pub const MAX_CHARS: usize = 400;
/// 超长单段的滑动重叠
pub const OVERLAP_CHARS: usize = 60;
/// 低于此长度的块丢弃（目录、分隔线之类）。
/// 中文 8 个字已经能表达一个完整意思，阈值不宜按英文单词数来设。
pub const MIN_CHARS: usize = 8;
/// 单篇笔记最多索引多少块，防异常大文件把索引撑爆
pub const MAX_CHUNKS: usize = 200;

pub struct ChunkedNote {
    pub chunks: Vec<String>,
    /// 是否因超过 MAX_CHUNKS 被截断（调用方决定要不要记一条警告）
    pub truncated: bool,
}

/// 切块入口。
///
/// 正文为空但标题非空时仍然产出一个块：否则"只有标题的笔记"永远搜不到，
/// 而用户对这类笔记的检索意图通常就是标题本身。
pub fn split_note(title: &str, content: &str) -> ChunkedNote {
    let normalized = normalize(content);
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();

    for para in normalized.split("\n\n") {
        let para = para.trim();
        if para.is_empty() || meaningful_len(para) < 3 {
            continue;
        }
        if char_len(para) > MAX_CHARS {
            flush(&mut current, &mut chunks);
            for piece in hard_split(para) {
                push_chunk(piece, &mut chunks);
            }
            continue;
        }

        let separator = if current.is_empty() { 0 } else { 2 };
        if !current.is_empty() && char_len(&current) + separator + char_len(para) > MAX_CHARS {
            flush(&mut current, &mut chunks);
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(para);
        if char_len(&current) >= TARGET_CHARS {
            flush(&mut current, &mut chunks);
        }
    }
    flush(&mut current, &mut chunks);

    if chunks.is_empty() {
        let title = title.trim();
        if !title.is_empty() {
            chunks.push(title.to_string());
        }
    }

    let truncated = chunks.len() > MAX_CHUNKS;
    chunks.truncate(MAX_CHUNKS);
    ChunkedNote { chunks, truncated }
}

/// 送进模型的文本：标题 + 块正文。标题重复出现在每个块里是刻意的，
/// 它是最强的主题信号，而且长笔记的单块往往脱离标题后语义模糊。
pub fn embedding_text(title: &str, chunk: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        chunk.to_string()
    } else {
        format!("{title}\n{chunk}")
    }
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

fn flush(current: &mut String, out: &mut Vec<String>) {
    if current.is_empty() {
        return;
    }
    let text = current.trim().to_string();
    current.clear();
    push_chunk(text, out);
}

fn push_chunk(text: String, out: &mut Vec<String>) {
    if char_len(&text) < MIN_CHARS {
        return;
    }
    if meaningful_len(&text) < 3 {
        return;
    }
    out.push(text);
}

/// 去掉 Markdown 链接/图片的目标部分后，还剩多少有效字符。
/// 图片链接里的文件名（`![图](a.png)`）不算内容，否则纯图片段落会被当成正文塞进块里。
fn meaningful_len(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut count = 0;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            i += 1;
            while i < chars.len() && chars[i] != ']' {
                if chars[i].is_alphanumeric() {
                    count += 1;
                }
                i += 1;
            }
            i += 1; // 跳过 `]`
            if i < chars.len() && chars[i] == '(' {
                while i < chars.len() && chars[i] != ')' {
                    i += 1;
                }
                i += 1; // 跳过 `)`
            }
            continue;
        }
        if chars[i].is_alphanumeric() {
            count += 1;
        }
        i += 1;
    }
    count
}

/// 单段超长：以 MAX 为窗口、步长 MAX-OVERLAP 滑动。
fn hard_split(para: &str) -> Vec<String> {
    let chars: Vec<char> = para.chars().collect();
    let mut out = Vec::new();
    let step = MAX_CHARS - OVERLAP_CHARS;
    let mut start = 0;
    while start < chars.len() {
        let end = (start + MAX_CHARS).min(chars.len());
        out.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start += step;
    }
    out
}

/// 统一换行、去掉 YAML frontmatter、把 3 个以上连续空行压成 2 个。
fn normalize(content: &str) -> String {
    let unified = content.replace("\r\n", "\n").replace('\r', "\n");
    let body = strip_frontmatter(&unified);

    let mut out = String::with_capacity(body.len());
    let mut newlines = 0usize;
    for ch in body.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push(ch);
            }
        } else {
            newlines = 0;
            out.push(ch);
        }
    }
    out
}

fn strip_frontmatter(text: &str) -> &str {
    let text = text.trim_start_matches('\u{feff}');
    if !text.starts_with("---\n") {
        return text;
    }
    // 只有闭合标记独占一行才算 frontmatter，避免把正文里的分隔线误伤
    if let Some(pos) = text[4..].find("\n---\n") {
        return &text[4 + pos + 5..];
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_note_is_one_chunk() {
        let out = split_note("标题", "很短的一段正文。");
        assert_eq!(out.chunks, vec!["很短的一段正文。"]);
        assert!(!out.truncated);
    }

    #[test]
    fn title_only_note_keeps_title_chunk() {
        let out = split_note("只有标题的笔记", "");
        assert_eq!(out.chunks, vec!["只有标题的笔记"]);
    }

    #[test]
    fn long_paragraphs_are_split() {
        let para = "这是一段用于测试分块逻辑的中文正文，".repeat(20);
        let out = split_note("标题", &format!("{para}\n\n{para}\n\n{para}"));
        assert!(out.chunks.len() > 1);
        for chunk in &out.chunks {
            assert!(char_len(chunk) <= MAX_CHARS);
        }
    }

    #[test]
    fn huge_single_paragraph_has_overlap_and_valid_utf8() {
        let para: String = (0..900)
            .map(|i| char::from_u32(0x4e00 + i).unwrap())
            .collect();
        let out = split_note("标题", &para);
        assert!(out.chunks.len() >= 3);
        for chunk in &out.chunks {
            assert!(char_len(chunk) <= MAX_CHARS);
        }
        // 相邻两块确实有重叠：后一块的开头能在前一块末尾找到
        let first_tail: String = out.chunks[0]
            .chars()
            .rev()
            .take(OVERLAP_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        assert!(out.chunks[1].starts_with(&first_tail));
    }

    #[test]
    fn frontmatter_is_stripped() {
        let out = split_note("标题", "---\ntags: [a, b]\n---\n\n真正的正文内容在这里。");
        assert_eq!(out.chunks, vec!["真正的正文内容在这里。"]);
    }

    #[test]
    fn symbol_only_paragraph_is_dropped() {
        let out = split_note(
            "标题",
            "![图片](a.png)\n\n------\n\n正常内容至少要有一些文字。",
        );
        assert_eq!(out.chunks, vec!["正常内容至少要有一些文字。"]);
    }

    #[test]
    fn chunk_count_is_capped() {
        let para = "很长的一段内容。".repeat(30);
        let content = (0..MAX_CHUNKS + 10)
            .map(|_| para.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let out = split_note("标题", &content);
        assert_eq!(out.chunks.len(), MAX_CHUNKS);
        assert!(out.truncated);
    }

    #[test]
    fn embedding_text_prefixes_title() {
        assert_eq!(embedding_text("标题", "正文"), "标题\n正文");
        assert_eq!(embedding_text("  ", "正文"), "正文");
    }
}
