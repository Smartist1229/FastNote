/**
 * 笔记选
 * 择域：真实笔记 / AI 临时预览 / 历史版本预览 / 电脑文件四层叠放状态。
 *
 * 叠放层优先级：历史版本预览 / AI 临时预览 > 电脑文件 > 普通笔记；关闭上层回到下层，
 * 无下层回欢迎页。这里的伪笔记一律使用 `temp:` / `external:` / `history-preview` 前缀的
 * 伪 id，NoteEditor 据 isTemporary 拦截落库。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ExternalTextFile, Note, NoteHistoryEntry } from "@/interface/note/note";
import type { EncryptionScope } from "@/interface/system/encryption";
import * as notesApi from "@/api/note/notes";
import { onAppEvent } from "@/shared/bus";

export interface UseNoteSelectionParams {
  setSelectedCategoryId: (value: string | null) => void;
  setExpandedDrawer: (value: string | 'all' | 'uncategorized' | null) => void;
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
  lockOnceUnlockedRef: { current: (scope: EncryptionScope, id: string, clearSelected?: boolean) => void };
  /** 侧边栏高亮（notes 域提供，含计时器） */
  flashFocusRef: { current: (noteId: string) => void };
  /** 全量笔记镜像（notes 域维护），供 AI selectNote 事件读取最新列表 */
  notesRef: RefObject<Note[]>;
  /** 点开分组加密笔记时记住的 note id（加密域与解锁流程共用） */
  pendingUnlockNoteRef: RefObject<string | null>;
}

export function useNoteSelection({
  setSelectedCategoryId,
  setExpandedDrawer,
  requestUnlockRef,
  lockOnceUnlockedRef,
  flashFocusRef,
  notesRef,
  pendingUnlockNoteRef,
}: UseNoteSelectionParams) {
  /** 真实笔记的选中项；null 时编辑器回落到叠放层，仍为空则显示欢迎页 */
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  /** AI 回复的临时预览：只在编辑器展示、绝不写库；null 时露出下一层或欢迎页 */
  const [tempNote, setTempNote] = useState<{ id: string; title: string; content: string } | null>(null);
  /** 历史版本预览：叠在真实笔记之上只读展示，退出后回到原笔记 */
  const [historyPreview, setHistoryPreview] = useState<NoteHistoryEntry | null>(null);
  /** 临时预览的伪 id 计数器：每次打开都换一个新 id，确保编辑器一定会刷新成新内容 */
  const tempNoteIdRef = useRef(0);
  /**
   * 正在直接编辑的电脑文本文件：null 表示普通笔记模式。
   * 内容只存在于界面，编辑器防抖后写回原文件，不落库。
   */
  const [externalFile, setExternalFile] = useState<ExternalTextFile | null>(null);
  /** 电脑文件的伪 id 计数器：与临时预览分前缀，避免两边 id 撞车 */
  const externalFileIdRef = useRef(0);
  /** 外部文件模式的镜像 ref：供 openNote 之类零依赖回调做判断 */
  const externalFileRef = useRef<ExternalTextFile | null>(null);
  /** NoteEditor 注册进来的「立即写回电脑文件」，切换/关闭前先 flush，避免丢掉最后一次编辑 */
  const flushExternalRef = useRef<(() => void) | null>(null);
  /** 最新选中项的镜像：供零依赖回调与事件处理器读取，避免闭包过期 */
  const selectedNoteRef = useRef<Note | null>(selectedNote);

  /** 临时预览的伪笔记：伪 id 哨兵，NoteEditor 据 isTemporary 拦截所有落库操作 */
  const tempPreviewNote: Note | null = tempNote
    ? { id: tempNote.id, title: tempNote.title, content: tempNote.content, category_id: null, created_at: "", updated_at: "", is_deleted: false, deleted_at: null, is_pinned: false, ai_access: 2, enc_mode: 0, is_locked: false, enc_hint: null }
    : null;
  /** 电脑文件对应的伪笔记：标题=文件名、内容=文件内容，同样不落库 */
  const externalFileNote: Note | null = externalFile
    ? { id: externalFile.id, title: externalFile.name, content: externalFile.content, category_id: null, created_at: "", updated_at: "", is_deleted: false, deleted_at: null, is_pinned: false, ai_access: 2, enc_mode: 0, is_locked: false, enc_hint: null }
    : null;
  /** 历史版本预览的伪笔记：固定伪 id 哨兵，内容全部来自历史表，编辑只读 */
  const historyPreviewNote: Note | null = historyPreview
    ? { id: "history-preview", title: historyPreview.title, content: historyPreview.content, category_id: historyPreview.category_id, created_at: "", updated_at: historyPreview.saved_at, is_deleted: false, deleted_at: null, is_pinned: historyPreview.is_pinned, ai_access: 2, enc_mode: 0, is_locked: false, enc_hint: null }
    : null;
  /** 编辑器当前展示的内容：最上层是历史版本预览 / AI 预览，其次是电脑文件，最后是真实笔记 */
  const editorNote = historyPreviewNote ?? tempPreviewNote ?? externalFileNote ?? selectedNote;
  /** 是否有叠放层（历史预览 / AI 预览 / 电脑文件）盖在真实笔记之上：此时 AI 面板不引用底层笔记 */
  const overlayActive = historyPreview != null || tempNote != null || externalFile != null;

  /**
   * AI 回复「在编辑器中打开」：把预览叠到最上层。
   * 底下的电脑文件 / 笔记保留不动，关闭预览后自然回到上一层。
   */
  const handleOpenInEditor = (title: string, content: string) => {
    // 预览会盖住当前层：先把电脑文件的待写入 flush 掉，避免丢最后一次编辑
    flushExternalRef.current?.();
    setHistoryPreview(null);
    tempNoteIdRef.current += 1;
    setTempNote({ id: `temp:${tempNoteIdRef.current}`, title, content });
  };

  /** 关闭 AI 临时预览：露出下面一层（电脑文件或原笔记；都没有则回欢迎页） */
  const handleCloseTemporary = () => {
    setTempNote(null);
  };

  /** NoteEditor 注册「立即写回」能力：切换 / 关闭文件前调用，避免丢掉最后一次编辑 */
  const registerFlushExternal = useCallback((fn: (() => void) | null) => {
    flushExternalRef.current = fn;
  }, []);

  /**
   * 打开真实笔记：撤掉上层叠放（先触发外部文件写回），切到它所属分组并展开抽屉，
   * 再用一次短延时把 focusNoteId 送进侧边栏做高亮。
   *
   * 正文随列表一起在内存里，直接切换即可；不要在这里插一层"正在读取"遮罩——
   * 遮罩哪怕只存在一两帧，整块编辑面板也会闪一下。
   */
  const openNote = useCallback((note: Note) => {
    // 锁着的加密内容没有正文可展示：先请用户解锁，解锁成功后再由 handleUnlockSubmit 打开
    if (note.enc_mode !== 0 && note.is_locked) {
      const groupScope = note.enc_mode === 2 && note.category_id !== null;
      pendingUnlockNoteRef.current = groupScope ? note.id : null;
      void requestUnlockRef.current(groupScope ? "category" : "note", groupScope ? note.category_id! : note.id);
      return;
    }
    // 离开上一条「仅本次解锁」的条目即锁；分组加密按分组记密钥，只有切到别的分组才尝试锁回
    const previous = selectedNoteRef.current;
    if (previous && previous.id !== note.id) {
      if (previous.enc_mode === 1) {
        void lockOnceUnlockedRef.current("note", previous.id);
      } else if (previous.enc_mode === 2 && previous.category_id !== null && previous.category_id !== note.category_id) {
        void lockOnceUnlockedRef.current("category", previous.category_id);
      }
    }
    // 打开真实笔记：撤掉上层叠着的电脑文件 / AI 预览（先触发一次文件写回）
    if (externalFileRef.current) {
      flushExternalRef.current?.();
      externalFileRef.current = null;
    }
    setTempNote(null);
    setHistoryPreview(null);
    setExternalFile(null);
    setSelectedCategoryId(note.category_id);
    setExpandedDrawer(note.category_id === null ? 'uncategorized' : note.category_id);
    flashFocusRef.current(note.id);

    setSelectedNote(note);
    // 会话基线：打开时先记一条，长时间编辑也不会丢掉“这次打开时的样子”。
    // 与最新历史相同时后端直接跳过，所以反复点同一条笔记不会堆积版本。
    void notesApi.snapshotNoteSession(note.id).catch(() => {});
  }, [setSelectedCategoryId, setExpandedDrawer, pendingUnlockNoteRef]);

  useEffect(() => {
    selectedNoteRef.current = selectedNote;
  }, [selectedNote]);

  // 让零依赖回调始终能拿到最新值
  useEffect(() => { externalFileRef.current = externalFile; }, [externalFile]);

  // AI selectNote 工具：切换当前打开的笔记，并展开对应分组、聚焦高亮
  useEffect(() => {
    return onAppEvent("fastnote-select-note", ({ noteId }) => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (note) openNote(note);
    });
  }, [openNote, notesRef]);

  return {
    selectedNote,
    setSelectedNote,
    selectedNoteRef,
    tempNote,
    setTempNote,
    tempNoteIdRef,
    historyPreview,
    setHistoryPreview,
    externalFile,
    setExternalFile,
    externalFileRef,
    externalFileIdRef,
    flushExternalRef,
    registerFlushExternal,
    tempPreviewNote,
    externalFileNote,
    historyPreviewNote,
    editorNote,
    overlayActive,
    handleOpenInEditor,
    handleCloseTemporary,
    openNote,
  };
}
