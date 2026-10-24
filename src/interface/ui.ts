/* 通用 UI 组件的组件层类型：Toast、Modal、确认弹窗、右键菜单与错误边界。 */

import type * as React from "react";

import type { Category, Note } from "./note";

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
