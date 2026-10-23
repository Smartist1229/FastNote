/**
 * 命令面板 / 快速跳转（Ctrl+P 跳转、Ctrl+Shift+P 命令）。
 *
 * 一个浮层、两个 tab：跳转查笔记，命令执行动作。设计上的几条硬约束：
 * - **键位不抢编辑器的**：Ctrl+K 在编辑器里是「插入链接」，所以命令面板走 Ctrl+Shift+P；
 * - 结果是纯派生：笔记来自内存里的全量列表，正文匹配由 `lib/noteJump` 分片扫描，面板本身不发请求
 *   （只有按标签筛选时才走一次 `listNotesByTag`）；
 * - 行是「可选中」与「分组标题」两种混排，键盘上下只跳过可选中项；
 * - 鼠标按下时阻止默认行为，焦点始终留在输入框里——否则点一下结果再按方向键就没反应了。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { Icon } from "@/components/common/Icon";
import { KeyChips } from "@/components/common/KeyChips";
import { fuzzyMatch, splitByRanges } from "@/lib/fuzzy";
import { recentNotes, useNoteJump, type JumpHit } from "@/lib/noteJump";
import type { Category, Note, Tag } from "@/interface/note";

export type PaletteMode = "jump" | "command";

/** 一条可执行的命令；`hint` 会作为副标题常显，方便不认识某条命令时看说明 */
export interface PaletteCommand {
  id: string;
  title: string;
  /** 一句话说明（显示在标题下方） */
  hint?: string;
  /** 分组标题，同一组的命令挨在一起 */
  group: string;
  icon?: string;
  /** 已绑定的快捷键（`mod+s` 这种写法），只做展示 */
  keys?: string;
  /** 额外搜索词：功能别名、英文名、拼音首字母等 */
  keywords?: string;
  /** 当前场景下不可用（如没打开笔记时的「导出」） */
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  initialMode: PaletteMode;
  notes: Note[];
  categories: Category[];
  tags: Tag[];
  commands: PaletteCommand[];
  currentNoteId?: number | null;
  /** 打开时预填的查询词（命令「按标签筛选…」用它直接进 # 模式） */
  seedQuery?: string;
  onClose: () => void;
  onOpenNote: (note: Note) => void;
  /** 按标签取笔记（选中标签后在本面板内列出来） */
  onLoadTagNotes: (tag: Tag) => Promise<Note[]>;
}

type Row =
  | { kind: "group"; id: string; label: string }
  | { kind: "note"; id: string; note: Note; hit?: JumpHit; isCurrent?: boolean }
  | { kind: "tag"; id: string; tag: Tag }
  | { kind: "command"; id: string; command: PaletteCommand };

/** 「3 分钟前」这种粗粒度相对时间：跳转列表只需要"新旧感"，不需要精确到秒 */
const relativeTime = (iso: string): string => {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
};

/** 命中区间高亮 */
const Highlighted: React.FC<{ text: string; ranges?: JumpHit["titleRanges"] }> = ({ text, ranges }) => {
  if (!ranges || !ranges.length) return <>{text}</>;
  return (
    <>
      {splitByRanges(text, ranges).map((part, index) =>
        part.hit ? (
          <mark key={index} className="bg-transparent text-primary-500 font-semibold">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  initialMode,
  notes,
  categories,
  tags,
  commands,
  currentNoteId,
  seedQuery,
  onClose,
  onOpenNote,
  onLoadTagNotes,
}) => {
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tagFilter, setTagFilter] = useState<Tag | null>(null);
  const [tagNotes, setTagNotes] = useState<Note[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---------- 打开 / 复位 ---------- */
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setQuery(seedQuery ?? "");
    setActive(0);
    setTagFilter(null);
    setTagNotes([]);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, initialMode, seedQuery]);

  /** 换查询、换 tab、换标签都回到第一项 */
  useEffect(() => {
    setActive(0);
  }, [query, mode, tagFilter]);

  const q = query.trim();
  /** `#` 前缀：查标签（只打一个 `#` 时列出全部标签，按使用篇数排） */
  const isTagMode = q.startsWith("#");
  const tagQuery = isTagMode ? q.slice(1).trim() : "";
  const jumpActive = open && mode === "jump" && !tagFilter && !isTagMode;
  const jump = useNoteJump(notes, isTagMode ? "" : q, jumpActive);

  const categoryName = useCallback(
    (id: number | null) => categories.find((c) => c.id === id)?.name ?? "未分类",
    [categories],
  );

  /* ---------- 结果模型 ---------- */
  const { rows, selectable } = useMemo(() => {
    const out: Row[] = [];
    const keys: string[] = [];

    const push = (row: Row, selectableId?: string) => {
      out.push(row);
      if (selectableId) keys.push(selectableId);
    };
    const group = (id: string, label: string) => out.push({ kind: "group", id, label });

    if (mode === "jump") {
      if (tagFilter) {
        // 标签结果里只在**标题**上筛：正文可能是百万字，逐键扫全文会把跳转面板拖垮
        const filtered = q ? tagNotes.filter((n) => fuzzyMatch(n.title || "无标题", q)) : tagNotes;
        group("g-tag", `标签「${tagFilter.name}」· ${tagNotes.length} 篇`);
        for (const note of filtered) {
          push({ kind: "note", id: `n${note.id}`, note, isCurrent: note.id === currentNoteId }, `n${note.id}`);
        }
      } else if (isTagMode) {
        const matched = tags
          .map((tag) => ({
            tag,
            // 只打了个 `#`：不过滤，按使用篇数排出全部标签
            hit: tagQuery ? fuzzyMatch(tag.name, tagQuery) : { score: 0, ranges: [] },
          }))
          .filter((item): item is { tag: Tag; hit: NonNullable<ReturnType<typeof fuzzyMatch>> } => item.hit !== null)
          .sort((a, b) =>
            tagQuery ? b.hit.score - a.hit.score || b.tag.note_count - a.tag.note_count : b.tag.note_count - a.tag.note_count,
          )
          .slice(0, 20);
        if (matched.length) group("g-tags", tagQuery ? "标签" : "全部标签");
        for (const { tag } of matched) push({ kind: "tag", id: `t${tag.id}`, tag }, `t${tag.id}`);
      } else if (!q) {
        const recent = recentNotes(notes, 8);
        if (recent.length) group("g-recent", "最近修改");
        for (const note of recent) {
          push({ kind: "note", id: `n${note.id}`, note, isCurrent: note.id === currentNoteId }, `n${note.id}`);
        }
      } else {
        if (jump.hits.length) group("g-notes", "笔记");
        for (const hit of jump.hits) {
          push({ kind: "note", id: `n${hit.note.id}`, note: hit.note, hit, isCurrent: hit.note.id === currentNoteId }, `n${hit.note.id}`);
        }
      }
    } else {
      const scored = commands
        .map((command) => ({
          command,
          hit: q ? fuzzyMatch(`${command.title} ${command.hint ?? ""} ${command.keywords ?? ""}`, q) : { score: 0, ranges: [] },
        }))
        .filter((item): item is { command: PaletteCommand; hit: NonNullable<ReturnType<typeof fuzzyMatch>> } => item.hit !== null)
        .sort((a, b) => (q ? b.hit.score - a.hit.score : 0));
      let lastGroup = "";
      for (const { command } of scored) {
        if (command.group !== lastGroup) {
          group(`g-cmd-${command.group}`, command.group);
          lastGroup = command.group;
        }
        push({ kind: "command", id: command.id, command }, command.id);
      }
    }
    return { rows: out, selectable: keys };
  }, [mode, q, tagFilter, tagNotes, isTagMode, tagQuery, tags, notes, jump.hits, commands, currentNoteId]);

  /** 结果变少（异步扫描、标签加载完）时把选中项拉回范围内，否则 Enter 会落到空处 */
  useEffect(() => {
    if (active > 0 && active >= selectable.length) setActive(0);
  }, [active, selectable.length]);

  /* ---------- 执行 ---------- */
  const runRow = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "note") {
        onOpenNote(row.note);
        onClose();
        return;
      }
      if (row.kind === "command") {
        if (row.command.disabled) return;
        // 先关面板再执行：命令多半会开另一个窗口（设置 / 文件对话框），
        // 面板留在下面会挡住刚打开的东西
        onClose();
        row.command.run();
        return;
      }
      if (row.kind === "tag") {
        setTagFilter(row.tag);
        setQuery("");
        setTagNotes([]);
        setTagLoading(true);
        void onLoadTagNotes(row.tag)
          .then((list) => setTagNotes(list))
          .catch(() => setTagNotes([]))
          .finally(() => setTagLoading(false));
      }
    },
    [onClose, onLoadTagNotes, onOpenNote],
  );

  const rowOf = (selectableIndex: number): Row | undefined => {
    const id = selectable[selectableIndex];
    return id ? rows.find((r) => "id" in r && r.id === id) : undefined;
  };

  const move = (delta: number) => {
    if (!selectable.length) return;
    setActive((prev) => {
      const next = prev + delta;
      if (next < 0) return selectable.length - 1;
      if (next >= selectable.length) return 0;
      return next;
    });
  };

  /** 高亮项滚进可视区（不打断输入） */
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // 标签筛选态先退回列表，再按一次才关面板
      if (tagFilter) {
        setTagFilter(null);
        setTagNotes([]);
        return;
      }
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      setTagFilter(null);
      setTagNotes([]);
      setMode((prev) => (prev === "jump" ? "command" : "jump"));
      setQuery("");
      return;
    }
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n")) {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p")) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runRow(rowOf(active));
    }
  };

  if (!open) return null;

  const jumpCount = selectable.length;
  const emptyHint =
    mode === "jump"
      ? tagFilter
        ? tagLoading
          ? "正在读取标签下的笔记…"
          : "这个标签下没有笔记"
        : isTagMode
          ? tagQuery
            ? `没有匹配「${tagQuery}」的标签`
            : "还没有标签：在笔记属性里加一个试试"
          : `没有找到匹配「${q}」的笔记`
      : `没有匹配「${q}」的命令`;

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm flex items-start justify-center p-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[660px] flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        style={{ maxHeight: "70vh" }}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label={mode === "jump" ? "快速跳转" : "命令面板"}
      >
        {/* 输入区：整行是一个搜索框，焦点态由外层描边表达；
            input 自己必须显式清掉全局 focus-visible 光晕，否则边框里会再套一圈蓝框 */}
        <div className="px-3 pt-3 pb-2 flex-shrink-0 space-y-2">
          <div className="flex items-center gap-2.5 h-10 px-3 rounded-xl border border-line bg-app/60 transition-colors focus-within:border-primary-500/60 focus-within:bg-surface">
            <Icon
              name={mode === "jump" ? "sidebar-search" : "ai-bolt"}
              className={`w-4 h-4 flex-shrink-0 ${mode === "jump" ? "text-faint" : "text-primary-500"}`}
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                mode === "jump"
                  ? tagFilter
                    ? `在「${tagFilter.name}」里筛选…`
                    : "搜索笔记标题与正文，输入 # 查标签…"
                  : "输入命令，或直接浏览下面的说明…"
              }
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-body placeholder:text-faint-soft focus:outline-none focus-visible:shadow-none"
              spellCheck={false}
            />
            {q && (
              <button
                className="p-1 rounded-md text-faint-soft hover:text-body hover:bg-surface-alt transition-colors flex-shrink-0"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setQuery("")}
                title="清空"
              >
                <Icon name="ai-close" className="w-3 h-3" />
              </button>
            )}
            <span className="text-[10px] text-faint-soft flex-shrink-0 tabular-nums">{jumpCount} 项</span>
          </div>

          {/* 模式页签做成 segmented，和下面的结果列表区分开 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-app/60 border border-line-soft">
              {(
                [
                  { key: "jump" as const, label: "跳转", hint: "Ctrl+P" },
                  { key: "command" as const, label: "命令", hint: "Ctrl+Shift+P" },
                ]
              ).map((tab) => (
                <button
                  key={tab.key}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMode(tab.key);
                    setTagFilter(null);
                    setTagNotes([]);
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    mode === tab.key
                      ? "bg-surface text-primary-600 shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
                      : "text-faint hover:text-body"
                  }`}
                  title={`${tab.label}（${tab.hint}）`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="ml-auto text-[10px] text-faint-soft pr-1">
              {mode === "command" ? "共 " + commands.length + " 条命令" : "按 Tab 切换"}
            </span>
          </div>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto chat-scrollbar px-2 py-2">
          {selectable.length === 0 ? (
            <div className="py-10 text-center text-xs text-faint">
              {mode === "jump" && jump.scanning ? "正在搜索正文…" : emptyHint}
            </div>
          ) : (
            rows.map((row) => {
              if (row.kind === "group") {
                return (
                  <p key={row.id} className="px-2 pt-2 pb-1 text-[10px] font-semibold text-faint-soft tracking-wide">
                    {row.label}
                  </p>
                );
              }
              const index = selectable.indexOf(row.id);
              const isActive = index === active;
              const common = {
                "data-active": isActive ? "true" : undefined,
                onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
                onMouseEnter: () => setActive(index),
                onClick: () => runRow(row),
                className: `flex items-center gap-2.5 px-2.5 py-2 rounded-xl cursor-pointer transition-colors ${
                  isActive ? "bg-primary-50" : "hover:bg-surface-alt"
                }`,
              };
              if (row.kind === "note") {
                return (
                  <div key={row.id} {...common}>
                    <Icon
                      name="sidebar-note"
                      className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-primary-500" : "text-faint"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className={`truncate text-xs font-medium ${isActive ? "text-ink" : "text-body"}`}>
                          <Highlighted text={row.note.title || "无标题"} ranges={row.hit?.titleRanges} />
                        </p>
                        {row.isCurrent && (
                          <span className="flex-shrink-0 px-1 rounded text-[9px] text-primary-500 bg-primary-50 border border-primary-500/20">
                            当前
                          </span>
                        )}
                        {row.note.is_pinned && <Icon name="sidebar-star-filled" className="w-2.5 h-2.5 text-warning" />}
                      </div>
                      {row.hit?.snippet ? (
                        <p className="mt-0.5 text-[11px] text-faint truncate">
                          <Highlighted text={row.hit.snippet} ranges={row.hit.snippetRanges} />
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[11px] text-faint-soft truncate">
                          {categoryName(row.note.category_id)} · {relativeTime(row.note.updated_at)}
                        </p>
                      )}
                    </div>
                    <Icon name="welcome-chevron-right" className="w-3 h-3 text-faint-soft flex-shrink-0" />
                  </div>
                );
              }
              if (row.kind === "tag") {
                return (
                  <div key={row.id} {...common}>
                    <Icon
                      name="shared-tag"
                      className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-primary-500" : "text-faint"}`}
                    />
                    <p className="min-w-0 flex-1 truncate text-xs font-medium text-body">
                      <Highlighted text={`#${row.tag.name}`} />
                    </p>
                    <span className="text-[10px] text-faint-soft flex-shrink-0">{row.tag.note_count} 篇</span>
                  </div>
                );
              }
              return (
                <div
                  key={row.id}
                  {...common}
                  className={`${common.className} ${row.command.disabled ? "opacity-45 cursor-not-allowed" : ""}`}
                >
                  <Icon
                    name={row.command.icon ?? "ai-bolt"}
                    className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-primary-500" : "text-faint"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-xs font-medium ${isActive ? "text-ink" : "text-body"}`}>
                      {row.command.title}
                    </p>
                    {(row.command.hint || row.command.disabled) && (
                      <p className="mt-0.5 text-[11px] text-faint-soft truncate">
                        {row.command.disabled ? row.command.disabledReason ?? row.command.hint : row.command.hint}
                      </p>
                    )}
                  </div>
                  {row.command.keys && <KeyChips accelerator={row.command.keys} />}
                </div>
              );
            })
          )}
        </div>

        {/* 底部操作提示 */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-line-soft text-[10px] text-faint-soft flex-shrink-0">
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded border border-line bg-app leading-4">↑</kbd>
            <kbd className="px-1 rounded border border-line bg-app leading-4">↓</kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded border border-line bg-app leading-4">Enter</kbd>
            执行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded border border-line bg-app leading-4">Tab</kbd>
            切换跳转 / 命令
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded border border-line bg-app leading-4">Esc</kbd>
            {tagFilter ? "返回列表" : "关闭"}
          </span>
          {mode === "jump" && !tagFilter && !isTagMode && (
            <span className="ml-auto">提示：输入 # 可按标签筛选</span>
          )}
        </div>
      </div>
    </div>
  );
};
