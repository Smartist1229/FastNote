/* 笔记编辑器的组件层类型：Props。 */

import type { Category, Note } from "./note";
import type { EditorSettings } from "./settings";
import type { MarkdownEditorMode } from "@/markdown-editor";

/**
 * 编辑器对外暴露的命令式动作（命令面板用）。
 * 只是把编辑器实例的几个方法包一层：调用方不必知道 `MarkdownEditorInstance` 的存在，
 * 编辑器没挂载（没打开笔记）时注册进来的是 null，命令据此置灰。
 */
export interface NoteEditorActions {
  setMode: (mode: Exclude<MarkdownEditorMode, "render">) => void;
  toggleFullscreen: () => void;
  /** withReplace=true 时同时展开替换行（阅读视图下无效） */
  openSearch: (withReplace?: boolean) => void;
  focus: () => void;
}

/**
 * 笔记编辑器 Props。
 * 除常规的笔记读改写外，还承载两种特殊模式：
 * - isTemporary：AI 回复的临时预览，只渲染不落库；
 * - externalFilePath 非空：直接编辑电脑上的文本文件，保存时写回原文件。
 */
export interface NoteEditorProps {
  /** 当前笔记；null = 没有打开任何笔记（显示欢迎页） */
  note: Note | null;
  onSave: (id: number, title: string, content: string, categoryId: number | null) => Promise<void>;
  onDelete: () => void;
  /** 上报正文末尾偏移（AI 插入文本时的定位基准） */
  onCursorOffsetChange?: (offset: number) => void;
  /**
   * 编辑器设置（来自软件设置的「编辑器」分区）。
   * 字号、滚轮缩放、默认视图、工具栏与行号等开关都从这里读，改动即时生效。
   */
  editorSettings?: EditorSettings;
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
  /** 把编辑器的命令式动作暴露给上层（命令面板的切换视图 / 全屏 / 查找） */
  onRegisterActions?: (actions: NoteEditorActions | null) => void;
}
