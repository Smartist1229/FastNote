/* 欢迎页（未打开笔记时）的组件层 Props：统计数据 + 快捷入口回调。 */

import type { Note } from "./note";
import type { RecentFile } from "@/lib/recentFiles";

/** 欢迎页仪表盘：统计卡片 + 最近笔记 + 最近文件 + 新建/回收站/打开文件/AI 入口 */
export interface WelcomeDashboardProps {
  /** 未删除的笔记总数（不含回收站） */
  totalNotes: number;
  /** 分组数 */
  categoryCount: number;
  /** 回收站中的笔记数 */
  trashCount: number;
  /** 最近笔记，调用方已按 updated_at 倒序排列 */
  recentNotes: Note[];
  /**
   * 最近打开的**电脑文件**（只记路径，不落库为笔记）。
   * 按 openedAt 倒序；为空时不渲染这一节。
   */
  recentFiles?: RecentFile[];
  /** 点击最近文件：按路径重新加载（失败由调用方 toast，用户可手动移除） */
  onOpenRecentFile?: (path: string) => void;
  /** 划掉一条最近文件（多半是文件已被删除或改名） */
  onRemoveRecentFile?: (path: string) => void;
  onCreateNote: () => void;
  onOpenTrash: () => void;
  /** 打开电脑上的文本文件（拖入规则一致） */
  onOpenTextFile?: () => void;
  onSelectNote: (note: Note) => void;
  /** 未打开笔记时也能进入 AI 对话 */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
}
