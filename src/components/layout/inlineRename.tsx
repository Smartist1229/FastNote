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
 */
import { createContext, useContext, useRef, useState } from "react";
import type React from "react";
import type { Category, Note } from "@/interface/note/note";

/** 正在就地改名的目标：笔记或分组，互斥 */
export type InlineRenameTarget =
  | { kind: "note"; note: Note }
  | { kind: "category"; category: Category };

export interface InlineRenameApi {
  /** 当前正在改名的目标；null 表示没有 */
  target: InlineRenameTarget | null;
  /** 开始改名（笔记会把所在分组展开，保证输入框可见） */
  start: (target: InlineRenameTarget) => void;
  /** 提交新名字；空值与「没改动」都不会写库 */
  commit: (target: InlineRenameTarget, value: string) => void;
  /** 取消，回到只读状态 */
  cancel: () => void;
}

const InlineRenameContext = createContext<InlineRenameApi | null>(null);

export const InlineRenameProvider: React.FC<{ value: InlineRenameApi; children: React.ReactNode }> = ({
  value,
  children,
}) => <InlineRenameContext.Provider value={value}>{children}</InlineRenameContext.Provider>;

/** 没有 Provider（例如单独渲染某一行）时返回 null，组件退化成只读展示 */
export const useInlineRename = (): InlineRenameApi | null => useContext(InlineRenameContext);

/**
 * 就地改名的输入框：看起来就是「原来那行文字变成可编辑」。
 *
 * 刻意不加边框、不加底色、不加内边距——加任何一样都会让它像「弹出来的表单」，
 * 而这里要的是「标题本身就在编辑」。高度由调用方通过 className 锁死成与只读态一致，
 * 这样进入改名时列表高度不会跳。
 */
export const InlineRenameInput: React.FC<{
  initial: string;
  /** 尺寸覆盖：笔记标题行与分组头字号不同，高度必须各自锁准 */
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}> = ({ initial, className, onCommit, onCancel }) => {
  const [value, setValue] = useState(initial);
  /**
   * Enter 提交后输入框会卸载、连带触发 blur，blur 里又会提交一次——
   * 那会多打一次 update 请求。用 ref 记「已经结算过」，两条路径只走一条。
   */
  const doneRef = useRef(false);
  const settle = (submit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (submit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      // 点输入框不该被当成「点这一行」而把笔记重新打开 / 把分组收起
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          settle(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      onBlur={() => settle(true)}
      className={
        className ??
        "h-[17px] w-full min-w-0 appearance-none border-0 bg-transparent p-0 text-[12.5px] font-medium leading-[17px] text-body outline-none"
      }
    />
  );
};
