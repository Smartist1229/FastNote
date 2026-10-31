/**
 * 快速跳转的笔记索引：标题即时匹配 + 正文**分片让步**扫描。
 *
 * 为什么不能一把梭：笔记列表带全量正文（百万字级别），每敲一个键就对所有笔记做一次
 * `toLowerCase()` + `indexOf()`，在主线程上就是几十上百毫秒的卡顿。这里的策略是：
 *
 * 1. **标题永远同步算**——几千条标题的模糊匹配只有几毫秒，输入即时出结果；
 * 2. **正文只在必要时扫**：查询词 ≥ 2 字、且标题命中不足 6 条时才开扫，
 *    每帧最多干 8ms，扫完一批就 `requestIdleCallback` 让出主线程，边扫边出结果；
 * 3. **小写副本按笔记缓存**（带总字数预算），同一个查询词反复回删不会重复付 O(n) 的代价；
 *    笔记 `updated_at` 变了或不在列表里了，缓存立即作废。
 *
 * 结果只取前若干条：跳转到第 30 条之外的笔记，用侧边栏搜索更合适。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { Note } from "@/interface/note";
import { fuzzyMatch, type MatchRange } from "@/lib/fuzzy";

/** 一条跳转候选 */
export interface JumpHit {
  note: Note;
  score: number;
  /** 标题里的命中区间（用于加粗） */
  titleRanges: MatchRange[];
  /** 正文命中时的一行上下文（已折叠空白）；标题命中时为 undefined */
  snippet?: string;
  snippetRanges?: MatchRange[];
}

/** 正文档位：命中位置前留 24 字、后留 48 字，大致一行 */
const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 48;

/** 标题命中达到这个数就不再扫正文（正文扫描是最贵的一步） */
const CONTENT_SCAN_THRESHOLD = 6;

/** 每帧给正文扫描的时间片（ms） */
const SCAN_SLICE_MS = 8;

/** 小写副本的缓存预算（字符数）：超出后不再缓存新的大笔记，仍可搜索，只是每次现算 */
const CACHE_CHARS_BUDGET = 8_000_000;

const contentCache = new Map<number, { updatedAt: string; lower: string }>();
let cachedChars = 0;

/** 取笔记正文的小写副本（带缓存与预算控制） */
const lowerContentOf = (note: Note): string => {
  const hit = contentCache.get(note.id);
  if (hit && hit.updatedAt === note.updated_at) return hit.lower;
  const lower = note.content.toLowerCase();
  // 小写后长度变化（İ / ß 之类）时区间坐标会错位，这种情况不缓存、也不做区间高亮
  const safe = lower.length === note.content.length;
  if (safe && lower.length <= CACHE_CHARS_BUDGET && cachedChars + lower.length <= CACHE_CHARS_BUDGET) {
    if (hit) cachedChars -= hit.lower.length;
    contentCache.set(note.id, { updatedAt: note.updated_at, lower });
    cachedChars += lower.length;
  }
  return lower;
};

/** 丢掉已经不在列表里的缓存（删笔记、换分组都走这里） */
export const pruneJumpCache = (notes: Note[]): void => {
  if (!contentCache.size) return;
  const alive = new Set(notes.map((n) => n.id));
  for (const id of [...contentCache.keys()]) {
    if (!alive.has(id)) {
      cachedChars -= contentCache.get(id)?.lower.length ?? 0;
      contentCache.delete(id);
    }
  }
};

/** 正文命中 → 一行上下文；没命中返回 null */
const matchContent = (note: Note, query: string): JumpHit | null => {
  const lower = lowerContentOf(note);
  const firstTerm = query.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
  if (!firstTerm) return null;
  const index = lower.indexOf(firstTerm);
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(note.content.length, index + firstTerm.length + SNIPPET_AFTER);
  // 折叠空白后再匹配一次：坐标属于片段自己，渲染层直接拿来高亮。
  // 两侧被截断时补省略号——中文没有空格，硬切会切在词中间，不标出来会让人以为原文就这么写。
  const snippet =
    (start > 0 ? "…" : "") +
    note.content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < note.content.length ? "…" : "");
  const hit = fuzzyMatch(snippet, query);
  return {
    note,
    score: 300 + (hit?.score ?? 0) / 10,
    titleRanges: [],
    snippet,
    snippetRanges: hit?.ranges ?? [],
  };
};

/** 标题匹配（同步、廉价） */
export const searchByTitle = (notes: Note[], query: string, limit = 20): JumpHit[] => {
  const out: JumpHit[] = [];
  for (const note of notes) {
    if (note.is_deleted) continue;
    const title = note.title || "无标题";
    const hit = fuzzyMatch(title, query);
    if (!hit) continue;
    out.push({ note, score: hit.score + 200, titleRanges: hit.ranges });
    if (out.length >= limit * 4) break;
  }
  // 同级按最近修改排序：搜同一批笔记时，刚改过的那篇排前面
  out.sort((a, b) => b.score - a.score || b.note.updated_at.localeCompare(a.note.updated_at));
  return out.slice(0, limit);
};

/** 空查询时的默认列表：最近修改的若干篇 */
export const recentNotes = (notes: Note[], limit = 8): Note[] =>
  notes
    .filter((n) => !n.is_deleted)
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit);

/** requestIdleCallback 的兜底：老 WebView2 上不一定有这个 API */
const idle = (fn: () => void): number => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) return ric(fn, { timeout: 200 });
  return window.setTimeout(fn, 16);
};

const cancelIdle = (handle: number): void => {
  const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  if (cic) cic(handle);
  else window.clearTimeout(handle);
};

export interface NoteJumpState {
  hits: JumpHit[];
  /** 正文还在扫 */
  scanning: boolean;
}

/**
 * 跳转搜索。
 *
 * @param notes   全量笔记（内存里的那份，不需要额外请求）
 * @param query   用户输入
 * @param active  面板没打开时传 false，避免在后台空转
 */
export const useNoteJump = (notes: Note[], query: string, active: boolean): NoteJumpState => {
  const q = query.trim();
  const titleHits = useMemo(() => (q ? searchByTitle(notes, q, 20) : []), [notes, q]);
  const [contentHits, setContentHits] = useState<JumpHit[]>([]);
  const [scanning, setScanning] = useState(false);
  const scanToken = useRef(0);

  /** 列表换了就把缓存里多余的条目清掉（AI 删笔记 / 回收站也会走到） */
  useEffect(() => {
    pruneJumpCache(notes);
  }, [notes]);

  useEffect(() => {
    setContentHits([]);
    scanToken.current += 1;
    const token = scanToken.current;
    if (!active || q.length < 2 || titleHits.length >= CONTENT_SCAN_THRESHOLD) {
      setScanning(false);
      return;
    }
    const skip = new Set(titleHits.map((h) => h.note.id));
    const queue = notes.filter((n) => !n.is_deleted && !skip.has(n.id));
    if (!queue.length) {
      setScanning(false);
      return;
    }

    setScanning(true);
    let cursor = 0;
    const found: JumpHit[] = [];
    let handle = 0;

    const step = () => {
      if (scanToken.current !== token) return;
      const deadline = performance.now() + SCAN_SLICE_MS;
      while (cursor < queue.length && performance.now() < deadline) {
        const hit = matchContent(queue[cursor], q);
        cursor += 1;
        if (hit) found.push(hit);
      }
      if (found.length) {
        const sorted = [...found].sort((a, b) => b.score - a.score).slice(0, 20);
        setContentHits(sorted);
      }
      if (cursor < queue.length) handle = idle(step);
      else setScanning(false);
    };
    handle = idle(step);

    return () => {
      scanToken.current += 1;
      cancelIdle(handle);
    };
  }, [active, notes, q, titleHits]);

  const hits = useMemo(() => {
    const seen = new Set<number>();
    const merged: JumpHit[] = [];
    for (const hit of [...titleHits, ...contentHits]) {
      if (seen.has(hit.note.id)) continue;
      seen.add(hit.note.id);
      merged.push(hit);
    }
    return merged.sort((a, b) => b.score - a.score).slice(0, 30);
  }, [titleHits, contentHits]);

  return { hits, scanning };
};
