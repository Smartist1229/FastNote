/**
 * 弹窗层的全局探测。
 *
 * 裸键动作（Delete 删笔记、F2 改名）不能只看焦点在不在输入框：设置窗、属性窗、
 * 命令面板里焦点可能落在按钮上，此时按 Delete 不该把背后的笔记删掉。
 *
 * `Modal` 挂载时会在自己的根节点写 `data-modal-layer`，这里只做一次查询——
 * 比在 App 里串起七八个「某某弹窗是否打开」的布尔更省事，也不会漏掉后加的弹窗。
 */
export const hasOpenModalLayer = (): boolean =>
  typeof document !== "undefined" && document.querySelector("[data-modal-layer]") !== null;
