/* 笔记编辑器的 Props 与按需加载的 Markdown 编辑器模块类型。 */

import type { Category, Note } from "./note";

export interface NoteEditorProps {
  note: Note | null;
  onSave: (id: number, title: string, content: string, categoryId: number | null) => Promise<void>;
  onDelete: () => void;
  onCursorOffsetChange?: (offset: number) => void;
  /** 编辑器默认正文字号（来自软件设置）：滚轮缩放后点击工具栏字号可还原到该值 */
  fontSize?: number;
  /** 是否允许 Ctrl/⌘ + 滚轮缩放字号（来自软件设置） */
  ctrlScrollZoom?: boolean;
  /** 打开/关闭 AI 对话面板 */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
  /** 临时预览模式（AI 回复）：只在界面上展示，绝不写入数据库 */
  isTemporary?: boolean;
  /** 关闭临时预览（回到欢迎页） */
  onCloseTemporary?: () => void;
  /** 全部分组：临时预览下「保存到分组」菜单用 */
  categories?: Category[];
  /** 把临时预览另存为真实笔记（保存到指定分组） */
  onSaveToCategory?: (categoryId: number | null, title: string, content: string) => Promise<void>;
  /** 把「保存笔记到文件」的能力暴露给外部（侧边栏右键菜单用，等价于 Ctrl+S） */
  onRegisterExport?: (exportNote: (() => void) | null) => void;
  /** 正在编辑的电脑文件路径：非空即进入「外部文件」模式（标题=文件名、内容实时写回原文件） */
  externalFilePath?: string | null;
  /** 外部文件模式：把编辑器当前内容写回电脑上的原文件 */
  onSaveExternal?: (content: string) => Promise<void>;
  /** 外部文件模式：把当前内容另存为一条真实笔记 */
  onSaveExternalToNote?: (categoryId: number | null, title: string, content: string) => Promise<void>;
  /** 外部文件模式：关闭（回到原笔记） */
  onCloseExternal?: () => void;
  /** 把「立即写回电脑文件」的能力暴露给外部（切换/关闭文件前先 flush） */
  onRegisterFlushExternal?: (flush: (() => void) | null) => void;
  /** 是否开启 AI 能力：关闭时，外部文件模式下显示提示 */
  enableAI?: boolean;
}

/** 按需加载的 md-editor-rt 模块类型 */
export type MarkdownEditorModule = typeof import("md-editor-rt");
