/**
 * 每个标签各自的编辑器句柄（命令式动作 / 立即写回电脑文件 / 保存到文件）。
 *
 * 为什么不用单个 ref：多标签下每篇笔记都挂着一个 NoteEditor 实例，注册回调是
 * 在挂载时执行的——多个实例往同一个 ref 写，最后挂载的那个会顶掉正在看的那个，
 * 表现就是「按 Ctrl+S 保存了另一个标签」。
 *
 * 所以按标签 key 分桶存放，读取时一律经 activeKey 取；卸载只清自己的桶，
 * 不会误伤别的标签。activeKey 由 App 在渲染期同步（与 App 里其它 ref 镜像同一套做法）。
 */
import type { NoteEditorActions } from "@/interface/note/editor";

export interface TabEditorHandles {
  /** 命令面板用：切换视图 / 全屏 / 查找 / 丢弃草稿 */
  actions: NoteEditorActions | null;
  /** 外部文件模式：立即写回磁盘（切标签 / 关标签前调用） */
  flush: (() => void) | null;
  /** 保存到文件（Ctrl+S / 侧栏右键「保存笔记」） */
  exportNote: (() => void) | null;
}

const EMPTY: TabEditorHandles = { actions: null, flush: null, exportNote: null };

const handles = new Map<string, TabEditorHandles>();
let activeKey: string | null = null;

/** App 每帧同步：标签切换后所有「当前编辑器」读取都跟着指向新标签 */
export const setActiveEditorKey = (key: string | null): void => {
  activeKey = key;
};

export const getActiveEditorKey = (): string | null => activeKey;

export const registerTabEditor = <K extends keyof TabEditorHandles>(
  key: string,
  field: K,
  value: TabEditorHandles[K],
): void => {
  const entry = handles.get(key) ?? { ...EMPTY };
  entry[field] = value;
  handles.set(key, entry);
};

export const dropTabEditor = (key: string): void => {
  handles.delete(key);
};

/**
 * 只保留还活着的标签的记录。
 * 关标签走的是 `setSelectedNote(null)` 等兼容路径时拿不到卸载时机，
 * 由 App 侧每次标签集合变化后统一收尾，避免地图里留下已经没人认领的句柄。
 */
export const pruneTabEditors = (aliveKeys: Iterable<string>): void => {
  const alive = new Set(aliveKeys);
  for (const key of [...handles.keys()]) {
    if (!alive.has(key)) handles.delete(key);
  }
};

/** 当前激活标签的句柄；标签里的编辑器还没就绪时返回 null */
export const activeTabEditor = (): TabEditorHandles | null =>
  activeKey === null ? null : handles.get(activeKey) ?? null;

/** 指定标签的「立即写回」：切走 / 关闭外部文件标签前用它，不依赖当前激活项 */
export const tabFlush = (key: string): (() => void) | null => handles.get(key)?.flush ?? null;

/** 当前激活标签的「保存到文件」 */
export const activeTabExport = (): (() => void) | null => activeTabEditor()?.exportNote ?? null;
