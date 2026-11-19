/**
 * 就地改名的共享通道（Context）：侧栏里的笔记标题和分组名都走这一条。
 *
 * 为什么不层层传 props：笔记行 `DrawerNoteItem` 有四个渲染点（分组抽屉 / 未分类 /
 * 未归类 / 收藏视图），分组头也有三个（真实分组 / 全部笔记 / 未分类），
 * 改名状态却只有「当前这一条」。走 Context 后，抽屉组件签名一行不用改，
 * 各组件自己判断「我是不是正在被改名的那一条」。
 *
 * 状态归 App 持有：F2 快捷键、右键「重命名笔记 / 分组」、行内输入框三处入口
 * 都要落到同一个目标上，所以笔记和分组共用一个 `target`，而不是两个独立状态
 * （两个状态同时为真时会出现两个输入框）。
 *
 * **为什么 Context 单独一个文件（且带 HMR 保身份）**：
 * 只有 Provider 注入了值，读取方才拿得到 `target`。开发时这个模块如果和组件放在一起，
 * 一改组件就整模块热替换，Provider 与读取方各自拿到一份新的 `createContext()`，
 * `useContext` 于是回落到默认值 `null`——症状是「右键菜单里重命名直接消失、
 * 分组重命名点了没反应、新建笔记不出现输入框」，而且不报任何错。
 * 把 Context 挪进只含数据与 hook 的模块，并在热替换时把旧对象塞回 `hot.data`，
 * 身份就不会被换掉。
 */
import { createContext, useContext } from "react";
import type { Context } from "react";
import type { Category, Note } from "@/interface/note/note";

/** 正在就地改名的目标：笔记或分组，互斥 */
export type InlineRenameTarget =
  | { kind: "note"; note: Note }
  | { kind: "category"; category: Category };

/** 提交来源：区分「按了回车」与「点到别处导致失焦」——新建笔记的命名对两者反应不同 */
export type RenameCommitReason = "enter" | "blur";

export interface InlineRenameApi {
  /** 当前正在改名的目标；null 表示没有 */
  target: InlineRenameTarget | null;
  /** 开始改名（笔记会把所在分组展开，保证输入框可见） */
  start: (target: InlineRenameTarget) => void;
  /** 提交新名字；空值与「没改动」都不会写库 */
  commit: (target: InlineRenameTarget, value: string, reason?: RenameCommitReason) => void;
  /** 取消，回到只读状态 */
  cancel: () => void;
}

/** 热替换时沿用上一次的 Context 对象，避免 Provider / 读取方各持一份 */
const hotData = (import.meta.hot?.data ?? {}) as { renameContext?: Context<InlineRenameApi | null> };
export const InlineRenameContext: Context<InlineRenameApi | null> =
  hotData.renameContext ?? createContext<InlineRenameApi | null>(null);
if (import.meta.hot) import.meta.hot.data.renameContext = InlineRenameContext;

/** 没有 Provider（例如单独渲染某一行）时返回 null，组件退化成只读展示 */
let warnedMissingProvider = false;
export const useInlineRename = (): InlineRenameApi | null => {
  const api = useContext(InlineRenameContext);
  /*
   * 少了 Provider 的后果极其隐蔽：右键菜单里的「重命名」直接不见、分组改名点了没反应、
   * 新建条目也不弹输入框，而且一个字都不报。开发期至少喊一声。
   */
  if (!api && import.meta.env.DEV && !warnedMissingProvider) {
    warnedMissingProvider = true;
    console.warn("[inlineRename] 没有找到 InlineRenameProvider：改名入口会全部失效。");
  }
  return api;
};
