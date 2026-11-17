/**
 * 编辑区标签域：笔记 / 电脑文件 / AI 预览 / 历史版本各自一个标签，可并行打开与切换。
 *
 * 与原 `useNoteSelection` 的关系：原来的「四层互斥叠放」整体换成标签列表，
 * 同一时刻只有一个激活标签，`selectedNote`（当前激活的**真实笔记**）仍是全应用唯一真源，
 * 侧栏高亮、属性窗、AI 面板、命令面板都继续读它，语义不变。
 *
 * 三条容易踩的硬线：
 * 1. `setSelectedNote` 必须保留 `Dispatch<SetStateAction<Note|null>>` 的形状——加密域、
 *    AI 域、笔记域都在用它，语义映射成「激活/更新这篇笔记的标签」与「关闭当前笔记标签」。
 * 2. 加密笔记切走即锁、且**连标签一起关掉**：标签留在栏里就等于明文一直躺在内存和 DOM 里，
 *    「仅本次解锁」的意义就没了。分组加密只在切到别的分组时才锁。
 * 3. 标签的 note 是快照，靠 `syncNotes` 跟 `notes` 列表对齐；不这么做的话，后台标签里
 *    保存过的内容会在切回来时被旧快照顶回去。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ExternalTextFile, Note, NoteHistoryEntry } from "@/interface/note/note";
import type { EncryptionScope } from "@/interface/system/encryption";
import * as notesApi from "@/api/note/notes";
import { onAppEvent } from "@/shared/bus";
import { pluginContributions } from "@/plugins/contributions";
import { dropTabEditor, pruneTabEditors, tabFlush } from "./activeEditor";
import {
  externalTabKey,
  historyTabKey,
  neighborOf,
  noteTabKey,
  planBatchClose,
  removeTab,
  tabByKey,
  tabNote,
  tabToNote,
  tempTabKey,
  type EditorTab,
  type ExternalTab,
  type HistoryTab,
  type NoteTab,
  type TabsState,
} from "./types";

/** 标签落盘用：只记身份，不记内容（内容重启后重新从库/磁盘读） */
const STORAGE_KEY = "fastnote.open-tabs";
/** 能落盘的标签类型：AI 预览是临时的，历史版本需要重新拉列表，都不记 */
type PersistedKind = "note" | "external";
interface PersistedTabs {
  activeKind: PersistedKind | "temp" | "history" | null;
  activeValue: string | null;
  tabs: { kind: PersistedKind; value: string }[];
}

export interface UseEditorTabsParams {
  setSelectedCategoryId: (value: string | null) => void;
  setExpandedDrawer: (value: string | "all" | "uncategorized" | null) => void;
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
  lockOnceUnlockedRef: {
    current: (scope: EncryptionScope, id: string, clearSelected?: boolean) => void;
  };
  /** 侧边栏高亮（notes 域提供，含计时器） */
  flashFocusRef: { current: (noteId: string) => void };
  /** 全量笔记镜像（notes 域维护），用于取最新正文与加密态 */
  notesRef: RefObject<Note[]>;
  /** 点开分组加密笔记时记住的 note id（加密域与解锁流程共用） */
  pendingUnlockNoteRef: RefObject<string | null>;
  /** 设置「重启后恢复标签」：关着时既不读也不写本地记录 */
  restoreEnabled: boolean;
}

/** 标签身份 → 落盘值；不可落盘的类型返回 null */
const persistValue = (tab: EditorTab): { kind: PersistedKind; value: string } | null => {
  if (tab.kind === "note") return { kind: "note", value: tab.note.id };
  if (tab.kind === "external") return { kind: "external", value: tab.file.path };
  return null;
};

const readPersisted = (): PersistedTabs | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTabs;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    // 记录损坏只影响“恢复上次标签”，静默丢弃即可
    return null;
  }
};


export function useEditorTabs({
  setSelectedCategoryId,
  setExpandedDrawer,
  requestUnlockRef,
  lockOnceUnlockedRef,
  flashFocusRef,
  notesRef,
  pendingUnlockNoteRef,
  restoreEnabled,
}: UseEditorTabsParams) {
  const [state, setState] = useState<TabsState>({ tabs: [], activeKey: null });
  /** 零依赖回调里读当前标签态：与 App 里其它 ref 镜像同一套做法 */
  const stateRef = useRef<TabsState>(state);
  stateRef.current = state;

  /** 伪 id 计数器：临时预览与电脑文件各一套前缀，跨会话内唯一即可 */
  const tempSeqRef = useRef(0);
  const externalSeqRef = useRef(0);
  /** 恢复只在首次拿到笔记列表后跑一次 */
  const restoredRef = useRef(false);

  const activeTab = tabByKey(state, state.activeKey);
  const selectedNote = tabNote(activeTab);
  const editorNote = tabToNote(activeTab);
  /** 当前标签不是真实笔记（电脑文件/AI 预览/历史版本）：AI 面板不引用底层笔记，只读类命令置灰 */
  const overlayActive = activeTab !== null && activeTab.kind !== "note";

  /** 最新激活笔记的镜像：加密域、笔记域、AI 域都用它做零依赖判断 */
  const selectedNoteRef = useRef<Note | null>(selectedNote);
  useEffect(() => {
    selectedNoteRef.current = selectedNote;
  }, [selectedNote]);

  /* ---------------- 标签构造 ---------------- */

  const makeNoteTab = (note: Note): NoteTab => ({
    kind: "note",
    key: noteTabKey(note.id),
    title: note.title,
    note,
  });

  const makeExternalTab = (file: ExternalTextFile): ExternalTab => ({
    kind: "external",
    key: externalTabKey(file.path),
    title: file.name,
    file,
  });

  /* ---------------- 副作用：切走 / 关闭时的 flush 与锁回 ---------------- */

  /** 外部文件标签在被切走/关闭前先写回，否则丢最后一次防抖编辑 */
  const flushTab = (tab: EditorTab | null): void => {
    if (tab?.kind === "external") tabFlush(tab.key)?.();
  };

  /**
   * 离开一篇加密笔记（切标签或关标签）：按原语义锁回，并把它（或它所在分组）的标签一并关闭。
   * `next` 是即将进入的标签，用来判断分组加密是否还需要保持解锁。
   */
  const lockOnLeave = (leaving: NoteTab, next: EditorTab | null): string[] => {
    const note = leaving.note;
    if (note.enc_mode === 1) {
      void lockOnceUnlockedRef.current("note", note.id);
      return [leaving.key];
    }
    if (note.enc_mode === 2 && note.category_id !== null) {
      const nextNote = tabNote(next);
      const stayInCategory = nextNote?.enc_mode === 2 && nextNote.category_id === note.category_id;
      if (stayInCategory) return [];
      void lockOnceUnlockedRef.current("category", note.category_id);
      // 同一分组里其它还开着的标签也一起关：它们的明文副本同样不该留着
      return stateRef.current.tabs
        .filter((tab) => tab.kind === "note" && tab.note.category_id === note.category_id)
        .map((tab) => tab.key);
    }
    return [];
  };

  const closeKeys = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setState((prev) => keys.reduce((acc, key) => removeTab(acc, key), prev));
    keys.forEach(dropTabEditor);
  }, []);

  /**
   * 切换前的准备：返回 false 表示这次切换被拦下了（目标笔记要先解锁）。
   * 顺序按「先保住旧内容、再判断新目标」：旧的外部文件先 flush，旧的加密笔记后锁回。
   */
  const prepareSwitch = (next: EditorTab): boolean => {
    const prev = stateRef.current;
    const leaving = tabByKey(prev, prev.activeKey);
    if (leaving?.key === next.key) return false;

    flushTab(leaving);

    if (next.kind === "note") {
      // 用列表里的最新快照：标签里的 note 是打开时的，加密态可能已经变了
      const fresh = notesRef.current.find((n) => n.id === next.note.id) ?? next.note;
      if (fresh.enc_mode !== 0 && fresh.is_locked) {
        const groupScope = fresh.enc_mode === 2 && fresh.category_id !== null;
        pendingUnlockNoteRef.current = groupScope ? fresh.id : null;
        void requestUnlockRef.current(
          groupScope ? "category" : "note",
          groupScope ? fresh.category_id! : fresh.id,
        );
        return false;
      }
    }

    if (leaving?.kind === "note") {
      closeKeys(lockOnLeave(leaving, next));
    }
    return true;
  };

  /* ---------------- 打开 / 激活 / 关闭 ---------------- */

  /** 记住这篇笔记是「这次会话打开的」：与最新历史相同时后端会跳过，反复点不会堆版本 */
  const snapshotSession = (noteId: string) => {
    void notesApi.snapshotNoteSession(noteId).catch(() => {});
  };

  /**
   * 打开笔记（侧栏点击、命令面板、AI selectNote 都走这里）：
   * 已开过就激活那个标签，没开过就新建；同时把侧栏滚到它所在分组并高亮。
   */
  const openNote = useCallback((note: Note) => {
    // 锁着的加密内容没有正文：先解锁，成功后由 handleUnlockSubmit 再调回来
    if (note.enc_mode !== 0 && note.is_locked) {
      const groupScope = note.enc_mode === 2 && note.category_id !== null;
      pendingUnlockNoteRef.current = groupScope ? note.id : null;
      void requestUnlockRef.current(
        groupScope ? "category" : "note",
        groupScope ? note.category_id! : note.id,
      );
      return;
    }
    const key = noteTabKey(note.id);
    // 已经在看这一篇：不必再跑一遍锁回/解锁守卫，直接留在原地
    if (stateRef.current.activeKey !== key && !prepareSwitch({ kind: "note", key, title: note.title, note })) {
      // 目标笔记需要先解锁：解锁流程结束后会重新调回这里
      return;
    }
    setState((prev) => {
      const index = prev.tabs.findIndex((tab) => tab.key === key);
      if (index >= 0) {
        // 已开过：只切激活项，不拿侧栏那份快照覆盖标签里的内容。
        // 快照的新鲜度由 syncNotes 统一负责——它只在笔记列表真的变了的时候才换，
        // 不会把用户正在编辑、还没落盘的内容顶回旧值。
        if (prev.activeKey === key) return prev;
        return { ...prev, activeKey: key };
      }
      return { tabs: [...prev.tabs, makeNoteTab(note)], activeKey: key };
    });
    setSelectedCategoryId(note.category_id);
    setExpandedDrawer(note.category_id === null ? "uncategorized" : note.category_id);
    flashFocusRef.current(note.id);
    snapshotSession(note.id);
  }, [closeKeys, setSelectedCategoryId, setExpandedDrawer]);

  /** 点标签栏切换：与打开同样的加密守卫，但不改动分组抽屉与侧栏高亮 */
  const activateTab = useCallback((key: string) => {
    const target = tabByKey(stateRef.current, key);
    if (!target || stateRef.current.activeKey === key) return;
    if (!prepareSwitch(target)) return;
    setState((prev) => (prev.tabs.some((tab) => tab.key === key) ? { ...prev, activeKey: key } : prev));
    const note = tabNote(target);
    if (note) snapshotSession(note.id);
  }, [closeKeys]);

  /** 关闭标签：外部文件先写回；加密笔记按离开时的规则锁回 */
  const closeTab = useCallback((key: string) => {
    const prev = stateRef.current;
    const tab = prev.tabs.find((item) => item.key === key);
    if (!tab) return;
    flushTab(tab);
    if (tab.kind === "note") {
      /*
       * 判断「还是否需要保持分组解锁」要看关掉之后用户实际会在哪个标签上：
       * 关的是激活标签 → 邻居；关的是后台标签 → 当前激活的那个（视线根本没动）。
       * 用错的话，关一个后台标签会把正在看的同组笔记一起锁掉。
       */
      const closingActive = prev.activeKey === key;
      const next = closingActive
        ? neighborOf(prev.tabs, key)
        : tabByKey(prev, prev.activeKey);
      closeKeys(lockOnLeave(tab, next));
    }
    setState((current) => removeTab(current, key));
    dropTabEditor(key);
  }, [closeKeys]);

  /**
   * 批量关闭（关闭其他 / 左侧 / 右侧 / 全部）的公共实现。
   *
   * 与单个关闭的差别只有「接下来看哪个」这一件事，但加密锁回必须按**最终**的激活项判断：
   * 一次关掉同组的多篇笔记时，只要还留着一篇同组的，就不该锁分组。
   */
  const closeMany = useCallback((keys: string[], preferredActive?: string) => {
    const prev = stateRef.current;
    const closing = new Set(keys.filter((key) => prev.tabs.some((tab) => tab.key === key)));
    if (closing.size === 0) return;

    // 外部文件先写回，别丢最后一次防抖编辑
    for (const tab of prev.tabs) {
      if (closing.has(tab.key)) flushTab(tab);
    }

    const { survivors, nextActiveKey } = planBatchClose(prev, closing, preferredActive);
    const nextTab = tabByKey({ tabs: survivors, activeKey: nextActiveKey }, nextActiveKey);
    const nextNote = tabNote(nextTab);

    // 锁回：逐篇「仅本次解锁」的笔记都锁；分组加密只在没有同组标签留下时才锁
    const lockedCategories = new Set<string>();
    for (const tab of prev.tabs) {
      if (!closing.has(tab.key) || tab.kind !== "note") continue;
      const note = tab.note;
      if (note.enc_mode === 1) {
        void lockOnceUnlockedRef.current("note", note.id);
      } else if (note.enc_mode === 2 && note.category_id !== null) {
        const keepCategory = nextNote?.enc_mode === 2 && nextNote.category_id === note.category_id;
        if (keepCategory || lockedCategories.has(note.category_id)) continue;
        lockedCategories.add(note.category_id);
        void lockOnceUnlockedRef.current("category", note.category_id);
      }
    }

    setState({ tabs: survivors, activeKey: nextActiveKey });
    closing.forEach(dropTabEditor);
  }, [closeKeys]);

  /**
   * 拖拽排序：把 fromKey 挪到 toKey 的位置。
   * 只改顺序，不动激活项——所以不需要跑锁回 / 写回那些副作用。
   */
  const moveTab = useCallback((fromKey: string, toKey: string) => {
    setState((prev) => {
      const from = prev.tabs.findIndex((tab) => tab.key === fromKey);
      const to = prev.tabs.findIndex((tab) => tab.key === toKey);
      if (from < 0 || to < 0 || from === to) return prev;
      const tabs = [...prev.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { tabs, activeKey: prev.activeKey };
    });
  }, []);

  /** 关闭除指定标签以外的全部 */
  const closeOtherTabs = useCallback((key: string) => {
    const prev = stateRef.current;
    closeMany(
      prev.tabs.filter((tab) => tab.key !== key).map((tab) => tab.key),
      key,
    );
  }, [closeMany]);

  /** 关闭指定标签左侧的全部 */
  const closeTabsToLeft = useCallback((key: string) => {
    const prev = stateRef.current;
    const index = prev.tabs.findIndex((tab) => tab.key === key);
    if (index <= 0) return;
    closeMany(prev.tabs.slice(0, index).map((tab) => tab.key), key);
  }, [closeMany]);

  /** 关闭指定标签右侧的全部 */
  const closeTabsToRight = useCallback((key: string) => {
    const prev = stateRef.current;
    const index = prev.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    closeMany(prev.tabs.slice(index + 1).map((tab) => tab.key), key);
  }, [closeMany]);

  /** 关闭全部标签（回欢迎页） */
  const closeAllTabs = useCallback(() => {
    closeMany(stateRef.current.tabs.map((tab) => tab.key));
  }, [closeMany]);

  /** 打开电脑文件（拖入 / 最近列表 / 对话框）：同一路径只留一个标签，重复打开即激活 */
  const openExternalTab = useCallback((input: Omit<ExternalTextFile, "id">, activate = true) => {
    externalSeqRef.current += 1;
    const file: ExternalTextFile = { ...input, id: `external:${externalSeqRef.current}` };
    const tab = makeExternalTab(file);
    if (activate && !prepareSwitch(tab)) return;
    setState((prev) => {
      // 恢复场景（activate=false）下如果还没有激活项，仍然要激活它，
      // 否则只剩电脑文件标签时会一条都不显示，编辑区空白
      const nextActive = activate || prev.activeKey === null ? tab.key : prev.activeKey;
      const index = prev.tabs.findIndex((item) => item.key === tab.key);
      if (index >= 0) {
        const tabs = prev.tabs.map((item, i) => (i === index ? tab : item));
        return { tabs, activeKey: nextActive };
      }
      return { tabs: [...prev.tabs, tab], activeKey: nextActive };
    });
  }, [closeKeys]);

  /**
   * 打开 AI 回复预览：每次都新开一个标签（内容各不相同，没有可去重的身份）。
   * `sourceNoteId` 只用于让 AI 面板沿用来源笔记的权限档位。
   */
  const openTempTab = useCallback((title: string, content: string, sourceNoteId: string | null = null) => {
    tempSeqRef.current += 1;
    const id = `temp:${tempSeqRef.current}`;
    const tab: EditorTab = {
      kind: "temp",
      key: tempTabKey(tempSeqRef.current),
      title,
      preview: { id, title, content },
      sourceNoteId,
    };
    prepareSwitch(tab);
    setState((prev) => ({ tabs: [...prev.tabs, tab], activeKey: tab.key }));
  }, [closeKeys]);

  /** 打开历史版本预览（属性窗「预览」）：同一版本只开一个标签 */
  const openHistoryTab = useCallback((entry: NoteHistoryEntry) => {
    const tab: HistoryTab = {
      kind: "history",
      key: historyTabKey(entry),
      title: entry.title,
      entry,
    };
    if (!prepareSwitch(tab)) return;
    setState((prev) => {
      const index = prev.tabs.findIndex((item) => item.key === tab.key);
      if (index >= 0) {
        const tabs = prev.tabs.map((item, i) => (i === index ? tab : item));
        return { tabs, activeKey: tab.key };
      }
      return { tabs: [...prev.tabs, tab], activeKey: tab.key };
    });
  }, [closeKeys]);

  /** 关闭当前标签（编辑器标题栏的关闭按钮用；语义与点标签上的 × 相同） */
  const closeActiveTab = useCallback(() => {
    const key = stateRef.current.activeKey;
    if (key !== null) closeTab(key);
  }, [closeTab]);

  /** AI 回复「在编辑器中打开」：开一个预览标签（带上来源笔记，权限档位会跟着它） */
  const handleOpenInEditor = useCallback(
    (title: string, content: string, sourceNoteId: string | null = null) =>
      openTempTab(title, content, sourceNoteId),
    [openTempTab],
  );

  /** 关闭当前 AI 预览标签（预览内部的「关闭」按钮） */
  const handleCloseTemporary = useCallback(() => {
    const active = tabByKey(stateRef.current, stateRef.current.activeKey);
    if (active?.kind === "temp") closeTab(active.key);
  }, [closeTab]);

  /**
   * `setSelectedNote` 兼容层：让加密域 / 笔记域 / AI 域不改一行就继续工作。
   *
   * - 传 Note：激活这篇笔记的标签（没有就新建）
   * - 传 updater：原地更新当前笔记标签的正文/标题（保存、改名、AI 档位变更都走这条）
   * - 传 null：关闭当前笔记标签，露出邻居（删除、锁定、加密后调用）
   *
   * 这里只做纯状态变换，不触发锁回/写回等副作用——调用方本身已经处理过加密态。
   */
  const setSelectedNote = useCallback<Dispatch<SetStateAction<Note | null>>>((action) => {
    setState((prev) => {
      const active = tabByKey(prev, prev.activeKey);
      const current = tabNote(active);
      const next = typeof action === "function" ? action(current) : action;
      if (next === current) return prev;
      if (next === null) {
        if (!active || active.kind !== "note") return prev;
        return removeTab(prev, active.key);
      }
      if (!active || active.kind !== "note") {
        const key = noteTabKey(next.id);
        const index = prev.tabs.findIndex((tab) => tab.key === key);
        if (index >= 0) {
          const tabs = prev.tabs.map((tab, i) => (i === index ? makeNoteTab(next) : tab));
          return { tabs, activeKey: key };
        }
        return { tabs: [...prev.tabs, makeNoteTab(next)], activeKey: key };
      }
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.key === active.key ? { ...tab, note: next, title: next.title } : tab,
        ),
      };
    });
  }, []);

  /**
   * 用最新的笔记列表校正标签快照，并丢掉已经不存在（被删/被清空）的笔记标签。
   *
   * 必须做：后台标签保存后列表变了，切回来如果还用旧快照，编辑器会把刚存的内容顶回去。
   * 只比较编辑器读得到的字段，避免 updated_at 之类无关差异引发整片重渲染。
   */
  const syncNotes = useCallback((notes: Note[]) => {
    setState((prev) => {
      let changed = false;
      const next: EditorTab[] = [];
      for (const tab of prev.tabs) {
        if (tab.kind !== "note") {
          next.push(tab);
          continue;
        }
        const fresh = notes.find((note) => note.id === tab.note.id);
        if (!fresh) {
          // 笔记已被删除：标签跟着消失
          changed = true;
          continue;
        }
        if (fresh.enc_mode !== 0 && fresh.is_locked && !tab.note.is_locked) {
          // 刚刚被锁定（一键锁定 / 加密 / 切走锁回）：标签一并关掉，
          // 否则明文副本还留在隐藏的编辑器实例里，解锁语义就名存实亡了
          changed = true;
          continue;
        }
        const stale =
          fresh.title !== tab.note.title ||
          fresh.content !== tab.note.content ||
          fresh.category_id !== tab.note.category_id ||
          fresh.updated_at !== tab.note.updated_at ||
          fresh.is_locked !== tab.note.is_locked ||
          fresh.enc_mode !== tab.note.enc_mode ||
          fresh.ai_access !== tab.note.ai_access ||
          fresh.is_pinned !== tab.note.is_pinned;
        if (!stale) {
          next.push(tab);
          continue;
        }
        changed = true;
        next.push({ ...tab, note: fresh, title: fresh.title });
      }
      if (!changed) return prev;
      const activeKey = next.some((tab) => tab.key === prev.activeKey)
        ? prev.activeKey
        : next[next.length - 1]?.key ?? null;
      return { tabs: next, activeKey };
    });
  }, []);

  /** 标签集合变化后回收句柄：关标签有时走的是兼容路径，拿不到组件卸载时机 */
  useEffect(() => {
    pruneTabEditors(state.tabs.map((tab) => tab.key));
  }, [state.tabs]);

  /* ---------------- 落盘与恢复 ---------------- */

  /**
   * 标签变化即写本地记录：只存身份，重启后再去库/磁盘取内容。
   *
   * 关闭时不删记录：设置是异步读回来的，启动瞬间默认值就是 false，
   * 照着它清一次会把上次的记录抹掉。真正的清理放在下面的「开关翻转」effect 里。
   */
  useEffect(() => {
    if (!restoreEnabled) return;
    try {
      const tabs: PersistedTabs["tabs"] = [];
      for (const tab of state.tabs) {
        const value = persistValue(tab);
        if (value) tabs.push(value);
      }
      const active = tabByKey(state, state.activeKey);
      const activeValue = active ? persistValue(active) : null;
      const payload: PersistedTabs = {
        activeKind: activeValue?.kind ?? null,
        activeValue: activeValue?.value ?? null,
        tabs,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // 本地存储不可用（隐私模式等）只是不恢复，不影响当前会话
    }
  }, [state, restoreEnabled]);

  /** 用户把「启动时恢复标签」关掉：顺手删掉已存的记录，下次启动不会被误恢复 */
  const prevRestoreRef = useRef(restoreEnabled);
  useEffect(() => {
    if (prevRestoreRef.current && !restoreEnabled) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // 本地存储不可用时不处理
      }
    }
    prevRestoreRef.current = restoreEnabled;
  }, [restoreEnabled]);

  /**
   * 首次拿到笔记列表后恢复上次的标签。顺序：先笔记（同步），后电脑文件（要读盘，异步补上）。
   * 锁着的加密笔记直接跳过——启动就弹一串解锁框没有意义。
   */
  const restoreTabs = useCallback((notes: Note[]) => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!restoreEnabled) return;
    const saved = readPersisted();
    if (!saved || saved.tabs.length === 0) return;

    const restored: EditorTab[] = [];
    const externalPaths: string[] = [];
    for (const item of saved.tabs) {
      if (item.kind === "note") {
        const note = notes.find((n) => n.id === item.value);
        if (!note) continue;
        if (note.enc_mode !== 0 && note.is_locked) continue;
        restored.push(makeNoteTab(note));
      } else {
        externalPaths.push(item.value);
      }
    }
    if (restored.length > 0) {
      const activeKey =
        saved.activeKind === "note"
          ? restored.find((tab) => tab.kind === "note" && tab.note.id === saved.activeValue)?.key ?? null
          : null;
      setState({ tabs: restored, activeKey: activeKey ?? restored[0].key });
    }
    // 电脑文件要重新读盘：读到哪个补哪个，不做激活，避免抢走当前焦点
    for (const path of externalPaths) {
      void notesApi
        .readTextFile(path)
        .then((file) => openExternalTab(file, false))
        .catch(() => undefined);
    }
  }, [openExternalTab, restoreEnabled]);

  /* ---------------- 外部事件 ---------------- */

  // AI 的 selectNote 工具：与侧栏点击同一条路径
  useEffect(() => {
    return onAppEvent("fastnote-select-note", ({ noteId }) => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (note) openNote(note);
    });
  }, [openNote, notesRef]);

  /**
   * note-switch 钩子由这里统一发射：多标签下每个编辑器实例只固定展示一篇笔记，
   * 它自己感知不到「用户切到了哪个标签」。
   */
  const lastActiveNoteIdRef = useRef<string | null>(null);
  const activeNoteId = selectedNote?.id ?? null;
  useEffect(() => {
    const previous = lastActiveNoteIdRef.current;
    if (previous === activeNoteId) return;
    lastActiveNoteIdRef.current = activeNoteId;
    void pluginContributions.emitHook("note-switch", {
      oldNoteId: previous,
      newNoteId: activeNoteId,
    });
  }, [activeNoteId]);

  return useMemo(
    () => ({
      tabs: state.tabs,
      activeKey: state.activeKey,
      activeTab,
      selectedNote,
      selectedNoteRef,
      setSelectedNote,
      editorNote,
      overlayActive,
      openNote,
      activateTab,
      closeTab,
      closeActiveTab,
      closeOtherTabs,
      closeTabsToLeft,
      closeTabsToRight,
      closeAllTabs,
      moveTab,
      openExternalTab,
      openTempTab,
      openHistoryTab,
      handleOpenInEditor,
      handleCloseTemporary,
      syncNotes,
      restoreTabs,
    }),
    [
      state.tabs,
      state.activeKey,
      activeTab,
      selectedNote,
      setSelectedNote,
      editorNote,
      overlayActive,
      openNote,
      activateTab,
      closeTab,
      closeActiveTab,
      closeOtherTabs,
      closeTabsToLeft,
      closeTabsToRight,
      closeAllTabs,
      moveTab,
      openExternalTab,
      openTempTab,
      openHistoryTab,
      handleOpenInEditor,
      handleCloseTemporary,
      syncNotes,
      restoreTabs,
    ],
  );
}

export type EditorTabsController = ReturnType<typeof useEditorTabs>;
