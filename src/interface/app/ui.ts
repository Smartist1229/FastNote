/* 通用 UI 组件的组件层类型：Toast、Modal、确认弹窗、右键菜单与错误边界。 */

import type * as React from "react";

import type { Category, Note } from "../note/note";

/**
 * 插件端调用 ui.modal 时的入参。
 * content 是 string 时渲染纯文本；是函数时调用并把 PluginModalApi 传进去，
 * 插件可以自己拼 DOM，也可以通过 api.close/ok/cancel 主动控制关闭。
 */
export interface PluginModalButton {
  /** 按钮文案（纯文本，会走宿主 i18n 映射） */
  label: string;
  /** 危险操作：红色样式 */
  danger?: boolean;
  /** 点击回调。返回 false 表示"阻止关闭"，弹窗继续留着；否则按 ok=true 结算 */
  onClick?: () => boolean | void;
}

/** 插件 content 函数会拿到的宿主控制 API */
export interface PluginModalApi {
  /** 关闭弹窗，resolve({ok: true/false, value})。ok 由 result 类型推断：false → 取消，其余 → 确认 */
  close(result?: unknown): void;
  /** 等同于 close({ ok: true, value })——带 value 地确认 */
  ok(value?: unknown): void;
  /** 等同于 close({ ok: false })——取消 */
  cancel(): void;
}

/**
 * 插件侧「Markdown 渲染句柄」：由 ctx.editor.render(markdown) 生成，
 * 只承载字符串，宿主渲染时才走编辑器的纯渲染组件（MarkdownPreview）。
 */
export interface PluginMarkdownHandle {
  __pluginRender: "markdown";
  markdown: string;
}

export interface PluginModalOptions {
  title?: string;
  /**
   * 一段 HTML（沙箱插件只能用这种）：宿主消毒后插入内容区。
   * 沙箱里拿不到宿主 DOM，content 函数 / render 句柄都传不过去，所以单开这个字段。
   */
  html?: string;
  /**
   * 纯文本消息（简单确认框），或接收 PluginModalApi 的自定义渲染回调。
   * 回调可以返回 React 节点，也可以返回原生 DOM 节点（插件自己 createElement 拼的弹窗）——
   * 宿主会把 DOM 节点挂进内容区容器（React 不认把原生节点当 child）。
   */
  content?: string | ((api: PluginModalApi) => React.ReactNode | Node);
  /**
   * 用编辑器纯渲染模式显示 Markdown：
   * 传 ctx.editor.render(md) 的句柄，或直接传 Markdown 字符串。
   * 传了 render 时优先于 content。
   */
  render?: PluginMarkdownHandle | string;
  /** 模态（阻塞，默认）| 非模态（浮层，可点外部关闭） */
  mode?: "modal" | "non-modal";
  /** 确认按钮文案，默认取宿主 i18n 的「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认取宿主 i18n 的「取消」 */
  cancelText?: string;
  /** 危险操作：确认按钮 / 自定义按钮红色样式 */
  danger?: boolean;
  /** 是否显示遮罩。modal 默认 true，non-modal 默认 false */
  showOverlay?: boolean;
  /** 非模态时点击遮罩 / 弹窗外部是否自动关闭（以 ok=false 结算）；默认 true */
  closeOnExternalClick?: boolean;
  /** 自定义按钮数组；传了就替代 confirm/cancel 双按钮 */
  buttons?: PluginModalButton[];
  /** 宽度档位（透传给宿主 Modal）；render 模式默认 "2xl"，其余默认 "lg" */
  size?: "lg" | "xl" | "2xl";
  /** 固定高度（px 或任意 CSS 长度）；render 模式默认 "min(78vh, 760px)"，内容区变为滚动容器 */
  height?: number | string;
}

/** ui.modal 的返回值：ok=true 表示点了确认（或插件主动 close(value)），ok=false 表示取消 */
export interface PluginModalResult {
  ok: boolean;
  value?: unknown;
}

/** 宿主内部持有的、待渲染的 modal 条目 */
export interface PluginModalState {
  id: number;
  options: PluginModalOptions;
}

/** Toast 语义：success / error 决定配色与图标，info 为中性提示 */
export type ToastType = "success" | "error" | "info";

/** 一条待展示的 toast；id 用时间戳，3 秒后按 id 从队列中移除 */
export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

/** useToast 的返回值；type 缺省为 info */
export interface ToastContextType {
  showToast: (message: string, type?: ToastType) => void;
}

/** 通用弹窗容器 Props */
export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** 宽度档位：默认 lg；设置窗口这类带侧栏的内容用 2xl 才放得下 */
  size?: "lg" | "xl" | "2xl";
  /** 固定宽度（px 或任意 CSS 长度）；传了就不再套 size 的 max-width */
  width?: number | string;
  /** 固定高度；传了内容区会变成滚动容器，弹窗不再随内容伸缩 */
  height?: number | string;
  /**
   * 非模态：不铺遮罩、不拦点击（底下的界面照常可交互），标题栏可拖动移动位置。
   * 点窗外不会关闭（本来就不关），Esc 也不关，只能走关闭按钮。
   */
  floating?: boolean;
  /** 浮层层级；默认 50。需要盖住同层级的浮窗时传更大值（如更新弹窗 70） */
  zIndex?: number;
}

/** useConfirm 的参数；confirmText / cancelText 缺省为「确定」/「取消」 */
export interface ConfirmOptions {
  /** 弹窗标题 */
  title: string;
  /** 正文说明 */
  message: React.ReactNode;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作（删除/清空等不可恢复）：确认按钮用红色 */
  danger?: boolean;
}

/** 右键菜单的一项；子菜单递归复用同一形状 */
export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** 渲染为分隔线（此时 label 传空字符串，onClick 不会被调用） */
  divider?: boolean;
  disabled?: boolean;
  submenu?: ContextMenuItem[];
}

/** 浮层右键菜单；items 为扁平列表，子菜单嵌套在 submenu 里 */
export interface ContextMenuProps {
  items: ContextMenuItem[];
  /** 菜单左上角坐标；null = 不渲染 */
  position: { x: number; y: number } | null;
  onClose: () => void;
}

/** 顶层错误边界（React 类组件的 props / state） */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
}

/** 错误边界 state：捕获到异常后整棵子树替换为兜底界面 */
export interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 右键菜单「属性」查看的对象，kind 决定弹窗内容：
 * note = 笔记属性，category = 真实分组，group = 默认分组 / 搜索视图分组等虚拟分组。
 */
export type PropertiesTarget =
  | { kind: "note"; note: Note }
  | { kind: "category"; category: Category }
  | { kind: "group"; name: string; noteCount: number };
