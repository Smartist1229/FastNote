/**
 * 笔记就地改名的共享通道（Context）。
 *
 * 为什么不层层传 props：笔记行 `DrawerNoteItem` 有四个渲染点（分组抽屉 / 未分类 /
 * 未归类 / 收藏视图），改名状态却只有一个。走 Context 后，抽屉组件签名一行不用改，
 * 行组件自己判断「我是不是正在被改名的那一条」。
 *
 * 状态归 App 持有：F2 快捷键、右键「重命名笔记」、行内输入框三处入口都要落到同一个 id 上。
 */
import { createContext, useContext } from "react";
import type React from "react";
import type { Note } from "@/interface/note/note";

export interface NoteRenameApi {
  /** 正在就地改名的笔记 id；null 表示没有 */
  renamingNoteId: string | null;
  /** 开始改名（会把所在分组展开，保证输入框可见） */
  start: (note: Note) => void;
  /** 提交新标题；空标题按取消处理 */
  commit: (note: Note, title: string) => void;
  /** 取消，回到只读状态 */
  cancel: () => void;
}

const NoteRenameContext = createContext<NoteRenameApi | null>(null);

export const NoteRenameProvider: React.FC<{ value: NoteRenameApi; children: React.ReactNode }> = ({
  value,
  children,
}) => <NoteRenameContext.Provider value={value}>{children}</NoteRenameContext.Provider>;

/** 没有 Provider（例如单独渲染某一行）时返回 null，行组件退化成只读展示 */
export const useNoteRename = (): NoteRenameApi | null => useContext(NoteRenameContext);
