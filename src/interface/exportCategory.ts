/* 分组导出弹窗的 Props 与格式选项。 */

import type { Category } from "./note";

export interface ExportCategoryModalProps {
  /** 要导出的分组：为 null 时窗口关闭 */
  category: Category | null;
  onClose: () => void;
  /** 导出结束后通知外部刷新（笔记数可能变化） */
  onDone?: () => void;
}

/** 格式选项：value 由各自的 Format 类型约束，这里统一成 string 便于两类共用一份渲染 */
export type FormatOption = { value: string; label: string; ext: string; desc: string };
