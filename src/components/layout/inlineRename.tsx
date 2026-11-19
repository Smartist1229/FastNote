/**
 * 就地改名的输入框与 Provider。
 *
 * 状态与 Context 本身在 `renameContext.ts`（那里有「为什么必须单独一个文件」的说明）：
 * 这个文件只放组件，改样式 / 改输入框行为时不会把 Context 换成一个新对象。
 * 为了让调用方只 import 一处，这里把类型与 hook 原样转发出去。
 */
import { useRef, useState } from "react";
import type React from "react";
import { InlineRenameContext } from "./renameContext";
import type { InlineRenameApi, RenameCommitReason } from "./renameContext";

export { InlineRenameContext, useInlineRename } from "./renameContext";
export type { InlineRenameApi, InlineRenameTarget, RenameCommitReason } from "./renameContext";

export const InlineRenameProvider: React.FC<{ value: InlineRenameApi; children: React.ReactNode }> = ({
  value,
  children,
}) => <InlineRenameContext.Provider value={value}>{children}</InlineRenameContext.Provider>;

/**
 * 就地改名的输入框：看起来就是「原来那行文字变成可编辑」。
 *
 * 刻意不加边框、不加底色、不加内边距——加任何一样都会让它像「弹出来的表单」，
 * 而这里要的是「标题本身就在编辑」。高度由调用方通过 className 锁死成与只读态一致，
 * 这样进入改名时列表高度不会跳。
 *
 * `inline-rename-input` 必须带上：App.css 里全局的 `input:focus-visible` 会给所有输入框
 * 画一圈 3px 主色光晕 + 描边。笔记标题那行被外层 truncate 的 overflow:hidden 裁掉了，
 * 分组头没有裁，于是分组改名看起来像个带底色的表单框、和笔记那个不一样。
 * 这个 class 把焦点环统一关掉，两处都只留「原文变可编辑 + 选中高亮」。
 */
export const InlineRenameInput: React.FC<{
  initial: string;
  /** 尺寸覆盖：笔记标题行与分组头字号不同，高度必须各自锁准 */
  className?: string;
  onCommit: (value: string, reason: RenameCommitReason) => void;
  onCancel: () => void;
}> = ({ initial, className, onCommit, onCancel }) => {
  const [value, setValue] = useState(initial);
  /**
   * Enter 提交后输入框会卸载、连带触发 blur，blur 里又会提交一次——
   * 那会多打一次 update 请求。用 ref 记「已经结算过」，两条路径只走一条。
   */
  const doneRef = useRef(false);
  const settle = (submit: boolean, reason: RenameCommitReason = "enter") => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (submit) onCommit(value, reason);
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
      onBlur={() => settle(true, "blur")}
      className={`inline-rename-input ${
        className ??
        "h-[17px] w-full min-w-0 appearance-none border-0 bg-transparent p-0 text-[12.5px] font-medium leading-[17px] text-body outline-none"
      }`}
    />
  );
};
