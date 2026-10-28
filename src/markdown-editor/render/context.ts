/**
 * 渲染上下文：把配置、文案、交互回调传给任意深度的块/行内节点。
 *
 * 用 context 而非 props 透传，是因为块节点递归很深（引用里套列表里套表格），
 * 逐层传参会把渲染函数签名撑爆；同时实时预览要复用同一个 BlockView 渲染单块，
 * 共享上下文能保证两种模式下的行为完全一致。
 */
import { createContext, useContext } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { MarkdownEditorConfig, OutlineItem } from "../types";
import { LABELS } from "../locales";

export interface PreviewContextValue {
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  readOnly: boolean;
  onLinkClick?: (href: string, event: ReactMouseEvent) => boolean | void;
  onTaskToggle?: (taskOffset: number, checked: boolean) => void;
  /**
   * 点击预览里的图片（宿主接管用）。返回 `true` 表示已处理；
   * 不传时组件自己弹放大浮层（见 `showImage`）。
   */
  onImageClick?: (src: string, alt: string) => boolean | void;
  /** 组件内置的放大浮层入口：把图片交给预览自己渲染的 `ImageViewer` */
  showImage?: (src: string, alt: string) => void;
}

export const PreviewCtx = createContext<PreviewContextValue | null>(null);

/**
 * 大纲单独一个 context。
 *
 * 它每次解析都是新数组，如果和 config 之类躺在同一个 context 里，
 * 打字时整篇块的订阅者会被 context 变化全部唤醒，块级 memo 就白做了。
 * 只有 TOC 块与大纲面板真的需要它。
 */
export const OutlineCtx = createContext<OutlineItem[]>([]);

export const usePreview = (): PreviewContextValue => {
  const value = useContext(PreviewCtx);
  if (!value) throw new Error(LABELS["en-US"].previewContextMissing);
  return value;
};

export const useOutline = (): OutlineItem[] => useContext(OutlineCtx);
