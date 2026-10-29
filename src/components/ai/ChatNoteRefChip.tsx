/**
 * 消息气泡里的笔记引用块（展示态）。
 *
 * 与输入框里的块共用 .chat-note-ref 样式，区别只是没有删除按钮：
 * 发出去之后 content 里留的是 <note-ref>JSON</note-ref>，渲染时按块还原。
 */
import type { ChatNoteRef } from "@/interface/aiChat";
import { refLabel, refRangeLabel, refTitle } from "@/lib/aiParse/noteRef";

export const ChatNoteRefChip = ({ noteRef }: { noteRef: ChatNoteRef }) => (
  <span className="chat-note-ref" title={refTitle(noteRef)}>
    <span className="chat-note-ref-label">{refLabel(noteRef)}</span>
    <span className="chat-note-ref-range">{refRangeLabel(noteRef)}</span>
  </span>
);
