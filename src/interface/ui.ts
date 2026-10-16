/* 通用 UI 组件相关类型：Toast、Modal、确认弹窗、右键菜单与错误边界。 */

import type * as React from "react";

import type { Category, Note } from "./note";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

export interface ToastContextType {
  showToast: (message: string, type?: ToastType) => void;
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** 宽度档位：默认 lg；设置窗口这类带侧栏的内容用 2xl 才放得下 */
  size?: "lg" | "xl" | "2xl";
}

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

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
  submenu?: ContextMenuItem[];
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number } | null;
  onClose: () => void;
}

/** 顶层错误边界（React 类组件的 props / state） */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export interface ErrorBoundaryState {
  error: Error | null;
}

/** 右键菜单「属性」查看的对象：笔记、真实分组，或默认分组 / 搜索视图分组这类虚拟分组 */
export type PropertiesTarget =
  | { kind: "note"; note: Note }
  | { kind: "category"; category: Category }
  | { kind: "group"; name: string; noteCount: number };
