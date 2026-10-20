/**
 * AI 对话面板的组件层类型（React props + 工具执行内部结构）。
 * 这些类型不落库、也不与 Rust 结构体对应：工具在渲染进程执行，只把结果回灌给模型。
 */

import type { AiAccessLevel, AiAccessRules } from "./aiAccess";
import type { AiPromptEntry, AiSettings } from "./ai";
import type { Category } from "./note";

/**
 * 对话面板 Props。会话列表、消息与流式状态都由面板内部持有，
 * 外部只需提供当前笔记上下文、设置与若干回调。
 */
export interface AIChatPanelProps {
  isOpen: boolean;
  /** 随请求发给 Rust 作为上下文（send_ai_chat 的 noteTitle / noteContent 参数） */
  noteTitle: string;
  noteContent: string;
  /** 当前打开笔记的 ID：AI 用它精确定位"这篇笔记"，避免同名笔记歧义 */
  currentNoteId?: number | null;
  /** 全部分组：用于合成 AI 访问规则（哪些分组被关闭） */
  categories?: Category[];
  /**
   * 当前打开笔记的生效档位 = min(笔记, 所属分组)。
   * 0 = 禁止（不发送正文并提示未授权）、1 = 只读（可读不可改）、2 = 完全。
   */
  currentNoteAiLevel?: AiAccessLevel;
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
  onClose?: () => void;
  /** 是否开启 AI 能力：关闭时不显示 AI 功能相关的提示 */
  enableAI?: boolean;
  /** 是否为外部文件模式（正在编辑电脑文件）：启用 AI 时显示提示 */
  isExternalFile?: boolean;
}

/**
 * 工具执行上下文：把"当前打开的笔记"等易变状态显式传进来，
 * 而不是让执行器去读模块级可变变量——后者是全局状态，没法隔离也没法测。
 */
export interface ToolContext {
  /** 用户此刻正在看的笔记 ID（"这篇笔记"的指代对象） */
  currentNoteId: number | null;
  /** 本轮 AI 访问规则快照：读写工具一律先过 canAiAccessNote / canAiAccessCategory */
  access: AiAccessRules;
  /**
   * 新建笔记 / 分组时套用的初始档位（设置里的「新建笔记 / 新建分组默认权限」）。
   * 由面板在每轮发送时从 AI 设置快照进来，执行器不直接读设置。
   */
  defaultNoteAiAccess: AiAccessLevel;
  defaultCategoryAiAccess: AiAccessLevel;
}

/**
 * 工具执行结果的一条记录（执行器返回值）。
 * 注意与 aiOutput.ts 的 ToolTrace 区分：ToolTrace 是界面轨迹，ok 可为 null（执行中）。
 */
export interface ToolResult {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
}
