/* 欢迎页（未打开笔记时）的组件层 Props：统计数据 + 快捷入口回调。 */

import type { Note } from "./note";

/** 欢迎页仪表盘：统计卡片 + 最近笔记 + 新建/回收站/打开文件/AI 入口 */
export interface WelcomeDashboardProps {
  /** 未删除的笔记总数（不含回收站） */
  totalNotes: number;
  /** 分组数 */
  categoryCount: number;
  /** 回收站中的笔记数 */
  trashCount: number;
  /** 最近笔记，调用方已按 updated_at 倒序排列 */
  recentNotes: Note[];
  onCreateNote: () => void;
  onOpenTrash: () => void;
  /** 打开电脑上的文本文件（拖入规则一致） */
  onOpenTextFile?: () => void;
  onSelectNote: (note: Note) => void;
  /** 未打开笔记时也能进入 AI 对话 */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
}
