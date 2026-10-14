/* AI 对话面板的 Props，以及工具执行上下文与结果记录类型。 */

import type { AiPromptEntry, AiSettings } from "./ai";

export interface AIChatPanelProps {
  isOpen: boolean;
  noteTitle: string;
  noteContent: string;
  /** 当前打开笔记的 ID：AI 用它精确定位"这篇笔记"，避免同名笔记歧义 */
  currentNoteId?: number | null;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
  /** 把 AI 回复当作临时内容在编辑器里打开（只预览，不写入笔记） */
  onOpenInEditor: (title: string, content: string) => void;
  onOpenProviderSettings: () => void;
  /** 打开「AI 记忆 / 前置提示词」设置 */
  onOpenAiMemory: () => void;
  /** 用户自定义的前置提示词与长期记忆（启用中的会追加到系统提示词） */
  aiPrompts: AiPromptEntry[];
  /** 统一设置窗口里的 AI 设置 */
  aiSettings: AiSettings;
  /** 设置里可改的项通过这个回调回写（例如拖动输入区高度） */
  onAiSettingsChange?: (patch: Partial<AiSettings>) => void;
  /** 关闭面板 */
  onClose?: () => void;
}

/**
 * 工具执行上下文：把"当前打开的笔记"等易变状态显式传进来，
 * 而不是让执行器去读模块级可变变量——后者是全局状态，没法隔离也没法测。
 */
export interface ToolContext {
  /** 用户此刻正在看的笔记 ID（"这篇笔记"的指代对象） */
  currentNoteId: number | null;
}

/** 工具执行结果的一条记录 */
export interface ToolResult {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
}
