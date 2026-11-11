/**
 * AI 域的笔记写入出口：「插入」「替换」「改写正文」。
 *
 * 唯一出口是 applyAiContentChange：先本地乐观更新（编辑器立即刷新），再排队写库。
 * 依赖由 App 装配传入，避免与本域状态 hook 形成循环依赖。
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Note } from "@/interface/note/note";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";

export interface UseAiNoteActionsParams {
  selectedNoteRef: RefObject<Note | null>;
  setSelectedNote: Dispatch<SetStateAction<Note | null>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  handleSaveNote: (id: string, title: string, content: string, categoryId: string | null) => Promise<void>;
  editorCursorOffsetRef: RefObject<number>;
}

export function useAiNoteActions({
  selectedNoteRef,
  setSelectedNote,
  setNotes,
  handleSaveNote,
  editorCursorOffsetRef,
}: UseAiNoteActionsParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /**
   * AI 改写正文的唯一出口：先本地乐观更新（编辑器立即刷新），再排队写库。
   * 没有选中笔记时只提示，不产生任何写入。
   */
  const applyAiContentChange = async (nextContent: string) => {
    const current = selectedNoteRef.current;
    if (!current) {
      showToast(t("请先选择一条笔记"), "error");
      return;
    }

    const updatedNote = { ...current, content: nextContent, updated_at: new Date().toISOString() };
    setSelectedNote(updatedNote);
    selectedNoteRef.current = updatedNote;
    setNotes((prev) => prev.map((note) => (note.id === current.id ? updatedNote : note)));
    await handleSaveNote(current.id, current.title, nextContent, current.category_id);
  };

  /** AI「插入」：在编辑器光标处插字并按需补换行，偏移先 clamp 到正文长度防越界 */
  const handleAiInsertText = async (text: string) => {
    const current = selectedNoteRef.current;
    if (!current) {
      showToast(t("请先选择一条笔记"), "error");
      return;
    }
    const offset = Math.max(0, Math.min(editorCursorOffsetRef.current, current.content.length));
    const prefix = current.content.slice(0, offset);
    const suffix = current.content.slice(offset);
    const separatorBefore = prefix && !prefix.endsWith("\n") ? "\n" : "";
    const separatorAfter = suffix && !text.endsWith("\n") ? "\n" : "";
    const nextContent = `${prefix}${separatorBefore}${text}${separatorAfter}${suffix}`;
    await applyAiContentChange(nextContent);
    editorCursorOffsetRef.current = offset + separatorBefore.length + text.length + separatorAfter.length;
    showToast(t("已插入到笔记"), "success");
  };

  /** AI「替换」：整篇覆盖，并把光标移到文末 */
  const handleAiReplaceContent = async (text: string) => {
    await applyAiContentChange(text);
    editorCursorOffsetRef.current = text.length;
    showToast(t("已替换笔记内容"), "success");
  };

  return { handleAiInsertText, handleAiReplaceContent };
}
