/* 分组导出弹窗的组件层类型：导出目标、格式选项与 Props。 */

import type { CategoryZipFormat } from "./backup";
import type { Note } from "./note";

/** 压缩包内的后缀选择：预设格式，或 other = 逐篇自选（限纯文本白名单） */
export type ZipFormatChoice = CategoryZipFormat | "other";

/** 导出目标：真实分组 / 默认分组 / 搜索视图分组都归一成「名称 + 默认文件名 + 笔记列表」 */
export interface ExportTarget {
  /** 展示用的分组名（如「未分类」「"关键词" 的搜索结果」） */
  name: string;
  /** 文件名输入框的默认值（不含扩展名；搜索分组会带上关键词） */
  defaultFileName: string;
  /** 该分组下的笔记（弹窗内会按创建时间正序排列章节） */
  notes: Note[];
}

/** 分组导出弹窗：target 为 null 时不渲染内容，用于关闭弹窗 */
export interface ExportCategoryModalProps {
  /** 要导出的分组：为 null 时窗口关闭 */
  target: ExportTarget | null;
  onClose: () => void;
  /** 导出成功后通知外部刷新（笔记数可能变化）；随后由外部关闭弹窗 */
  onDone?: () => void;
}

/**
 * 格式选项：value 由各自的 Format 类型约束，这里统一成 string 便于两类共用一份渲染。
 * label 为按钮文案，ext 为文件后缀（不含点；"其他文件格式"这类逐篇自选的选项为空串），
 * desc 为按钮下方的说明文案。
 */
export type FormatOption = { value: string; label: string; ext: string; desc: string };
