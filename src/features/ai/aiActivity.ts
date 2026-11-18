/**
 * 「AI 正在跑」的模块级标记。
 *
 * 标签域在用单击打开笔记时要判断「这条预览标签现在还能不能被顶掉」：AI 正在流式输出、
 * 还没把结果插进正文的那几秒里，把当前这篇顶掉就等于让这次插入失去了目标。
 *
 * 为什么不做成 React state 往上传：判断只发生在 openNote 的**点击那一刻**，读一次就够，
 * 模块变量既不用把 AI 状态穿过整条 props 链，也不会引起任何重渲染。
 * 用计数器而不是布尔值：确认框、工具轮之间可能短暂重叠。
 */
let active = 0;

export const beginAiActivity = (): void => {
  active += 1;
};

export const endAiActivity = (): void => {
  active = Math.max(0, active - 1);
};

/** 是否有 AI 请求正在进行（含工具轮与等待确认） */
export const isAiBusy = (): boolean => active > 0;
