/* 欢迎页仪表盘的 Props。 */

import type { Note } from "./note";

export interface WelcomeDashboardProps {
  totalNotes: number;
  categoryCount: number;
  trashCount: number;
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
