/**
 * 编辑区标签的数据模型：笔记 / 电脑文件 / AI 预览 / 历史版本四类标签。
 *
 * 取代原先「真实笔记 + 三层叠放」的单一编辑位：原来互斥的四层各变成独立标签，
 * 各自持有内容与编辑器实例，切换只切可见性（滚动位置、撤销历史、视图模式都留在各自的实例里）。
 *
 * 伪 id 前缀沿用原约定（`temp:` / `external:` / `history-preview`）：NoteEditor 依据
 * `isTemporary` / `externalFilePath` 拦截落库，跟标签层无关。这里不复用它们做 key——
 * 标题重命名会让 key 漂移，key 必须只由身份（笔记 id / 文件路径 / 历史版本 id）决定。
 */
import type { ExternalTextFile, Note, NoteHistoryEntry } from "@/interface/note/note";

export type EditorTabKind = "note" | "external" | "temp" | "history";

/** 所有标签共有的字段：key 是身份也是 React key，title 是标签上显示的文字 */
interface TabMeta {
  key: string;
  title: string;
  /**
   * 预览标签（单击侧栏打开的那个临时标签）：全局最多一个，下一次单击会被原地替换。
   * 双击打开、编辑过、或本身就没有「身份可替换」的标签（电脑文件 / AI 预览 / 历史版本）一律为 false。
   */
  isPreview?: boolean;
}

/**
 * 打开笔记的意图：单击 = 预览（可被下一次单击顶掉），双击 = 常驻。
 * 名字用 pinned 而不是 permanent，避免和「置顶笔记」（is_pinned）混淆。
 */
export type NoteOpenMode = "preview" | "pinned";

export interface NoteTab extends TabMeta {
  kind: "note";
  note: Note;
}

export interface ExternalTab extends TabMeta {
  kind: "external";
  file: ExternalTextFile;
}

export interface TempTab extends TabMeta {
  kind: "temp";
  /** AI 回复的临时预览：只在界面上存在，绝不落库 */
  preview: { id: string; title: string; content: string };
  /**
   * 这条预览是从哪篇笔记「在编辑器中打开」来的。
   * 预览本身没有正文可写，但 AI 面板的权限档位要按来源笔记算——
   * 否则打开一篇「禁止 AI」笔记的预览，面板会从禁止退回完全可用。
   */
  sourceNoteId: string | null;
}

export interface HistoryTab extends TabMeta {
  kind: "history";
  /** 打开时的历史版本快照（只读展示，回滚入口在编辑器顶部提示条里） */
  entry: NoteHistoryEntry;
}

export type EditorTab = NoteTab | ExternalTab | TempTab | HistoryTab;

/** 标签状态整体：标签序 + 当前激活项，必须一起更新（关掉激活项时要同时换激活对象） */
export interface TabsState {
  tabs: EditorTab[];
  activeKey: string | null;
}

export const noteTabKey = (noteId: string) => `note:${noteId}`;
export const externalTabKey = (path: string) => `external:${path}`;
/** 同一篇笔记的不同历史版本各自一个标签：用版本 id 区分（saved_at 会撞秒） */
export const historyTabKey = (entry: NoteHistoryEntry) => `history:${entry.id}`;
export const tempTabKey = (seq: number) => `temp:${seq}`;

export const isNoteTab = (tab: EditorTab | null | undefined): tab is NoteTab =>
  tab?.kind === "note";

/** 按 key 取标签；activeKey 为 null 或已失效时返回 null */
export const tabByKey = (state: TabsState, key: string | null): EditorTab | null =>
  key === null ? null : state.tabs.find((tab) => tab.key === key) ?? null;

/**
 * 移除标签并决定下一个激活项：优先右边的邻居（关掉中间那个时视线不动），
 * 没有右边就退回左边，都没有则回欢迎页。关掉的不是激活项时激活项不变。
 */
export const removeTab = (state: TabsState, key: string): TabsState => {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey };
  const nextActive = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeKey: nextActive?.key ?? null };
};

/**
 * 拖拽重排：把 fromKey 挪到「第 insertAt 项之前」（0..len，len 表示末尾）。
 *
 * 参数是**插入缝**的下标，不是最终位置：往下拖时先摘掉自己会让目标下标前移一位，
 * 这里统一换算，避免「往下拖一格原地不动」这个经典 off-by-one。
 * 位置没变时返回原数组引用，调用方可以据此跳过 setState。
 */
export const planTabMove = (tabs: EditorTab[], fromKey: string, insertAt: number): EditorTab[] => {
  const from = tabs.findIndex((tab) => tab.key === fromKey);
  if (from < 0) return tabs;
  const to = Math.max(0, Math.min(insertAt > from ? insertAt - 1 : insertAt, tabs.length - 1));
  if (to === from) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/** 关掉某个标签后应该激活谁：与 removeTab 的规则保持一致 */
export const neighborOf = (tabs: EditorTab[], key: string): EditorTab | null => {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
};

/**
 * 批量关闭的「留下谁、看谁」：关闭其他 / 左侧 / 右侧 / 全部共用。
 *
 * 规则只有两条：当前激活项没被关掉就继续看它；被关掉了就按调用方给的
 * `preferredActive`（右键命中的那个标签）接上，再不行退到最后一个。
 */
export const planBatchClose = (
  state: TabsState,
  keys: Iterable<string>,
  preferredActive?: string,
): { survivors: EditorTab[]; nextActiveKey: string | null } => {
  const closing = new Set(keys);
  const survivors = state.tabs.filter((tab) => !closing.has(tab.key));
  const keep = (key: string | null): key is string =>
    key !== null && survivors.some((tab) => tab.key === key);
  const nextActiveKey = keep(state.activeKey)
    ? state.activeKey
    : keep(preferredActive ?? null)
      ? (preferredActive as string)
      : survivors[survivors.length - 1]?.key ?? null;
  return { survivors, nextActiveKey };
};

/** 标签里挂着的真实笔记；其它类型一律 null（AI 面板、属性窗只认它） */
export const tabNote = (tab: EditorTab | null | undefined): Note | null =>
  tab?.kind === "note" ? tab.note : null;

/** 栏里当前的预览标签（只可能是笔记标签）：全局最多一个，单击新笔记时被它顶掉 */
export const findPreviewTab = (tabs: EditorTab[]): NoteTab | null =>
  tabs.find((tab): tab is NoteTab => tab.kind === "note" && tab.isPreview === true) ?? null;

/**
 * 新开一篇笔记时标签栏的走向。
 *
 * - 预览（单击）：顶掉已有的预览标签，**原位替换**——标签栏不会整体左移，
 *   否则连点几篇笔记，鼠标下面的标签会一直跳；
 * - 常驻（双击）：追加到末尾，和浏览器新开标签的习惯一致。
 *
 * `replacedKey` 交给调用方回收被顶掉那个标签的编辑器句柄（不回收等于泄漏一个挂载的编辑器）。
 */
export const planOpenNote = (
  tabs: EditorTab[],
  tab: NoteTab,
): { tabs: EditorTab[]; replacedKey: string | null } => {
  const stale = tab.isPreview ? findPreviewTab(tabs) : null;
  if (!stale || stale.key === tab.key) return { tabs: [...tabs, tab], replacedKey: null };
  const index = tabs.findIndex((item) => item.key === stale.key);
  const next = [...tabs];
  next[index] = tab;
  return { tabs: next, replacedKey: stale.key };
};

/**
 * 把标签从预览转成常驻（双击笔记 / 双击标签 / 编辑正文后自动转正）。
 * 已经不是预览就返回原数组引用，调用方据此跳过 setState。
 */
export const pinTab = (tabs: EditorTab[], key: string): EditorTab[] => {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index < 0 || !tabs[index].isPreview) return tabs;
  const next = [...tabs];
  next[index] = { ...next[index], isPreview: false };
  return next;
};

/** 伪笔记模板：与旧叠放层完全一致的字段，保证 NoteEditor 拿到的形状不变 */
const pseudoNote = (
  id: string,
  title: string,
  content: string,
  categoryId: string | null,
  updatedAt: string,
  isPinned: boolean,
): Note => ({
  id,
  title,
  content,
  category_id: categoryId,
  created_at: "",
  updated_at: updatedAt,
  is_deleted: false,
  deleted_at: null,
  is_pinned: isPinned,
  ai_access: 2,
  enc_mode: 0,
  is_locked: false,
  enc_hint: null,
});

/** 标签 → 编辑器要的 Note：笔记标签给真实笔记，其余三种按老约定造一条不落库的伪笔记 */
export const tabToNote = (tab: EditorTab | null | undefined): Note | null => {
  if (!tab) return null;
  switch (tab.kind) {
    case "note":
      return tab.note;
    case "external":
      return pseudoNote(tab.file.id, tab.file.name, tab.file.content, null, "", false);
    case "temp":
      return pseudoNote(
        tab.preview.id,
        tab.preview.title,
        tab.preview.content,
        null,
        "",
        false,
      );
    case "history":
      return pseudoNote(
        "history-preview",
        tab.entry.title,
        tab.entry.content,
        tab.entry.category_id,
        tab.entry.saved_at,
        tab.entry.is_pinned,
      );
  }
};

/**
 * 标签标题的兜底：分三种来源，都在这里收敛，标签栏和右键菜单不必各判一次。
 * 笔记/预览/历史用各自的标题字段，电脑文件用去掉扩展名的文件名（file.name）。
 */
export const tabTitleOf = (tab: EditorTab): string => {
  switch (tab.kind) {
    case "note":
      return tab.note.title;
    case "external":
      return tab.file.name;
    case "temp":
      return tab.preview.title;
    case "history":
      return tab.entry.title;
  }
};
