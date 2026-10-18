/**
 * 渲染上下文：把配置、文案、交互回调传给任意深度的块/行内节点。
 *
 * 用 context 而非 props 透传，是因为块节点递归很深（引用里套列表里套表格），
 * 逐层传参会把渲染函数签名撑爆；同时实时预览要复用同一个 BlockView 渲染单块，
 * 共享上下文能保证两种模式下的行为完全一致。
 */
import { createContext, useContext } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { MarkdownEditorConfig, ParsedDocument } from "../types";

export interface PreviewContextValue {
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  doc: ParsedDocument;
  readOnly: boolean;
  onLinkClick?: (href: string, event: ReactMouseEvent) => boolean | void;
  onTaskToggle?: (taskOffset: number, checked: boolean) => void;
}

export const PreviewCtx = createContext<PreviewContextValue | null>(null);

export const usePreview = (): PreviewContextValue => {
  const value = useContext(PreviewCtx);
  if (!value) throw new Error("Markdown 预览组件必须在 PreviewCtx 内使用");
  return value;
};
