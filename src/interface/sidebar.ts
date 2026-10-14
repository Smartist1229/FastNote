/* 侧边栏与分组抽屉的 Props。 */

import type * as React from "react";

import type { Category, Note } from "./note";

export interface CategoryDrawerProps {
  category: Category | null;
  notes: Note[];
  isExpanded: boolean;
  isAllNotes: boolean;
  selectedNoteId: number | null;
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onCreateNote: () => void;
  onContextMenu: (e: React.MouseEvent, category: Category | null) => void;
  onNoteContextMenu: (e: React.MouseEvent, note: Note) => void;
}

export interface SidebarProps {
  categories: Category[];
  notes: Note[];
  allNotesCount: number;
  selectedCategoryId: number | null;
  selectedNoteId: number | null;
  /** 抽屉展开状态：'all' | 分组ID | 'uncategorized' | null（全部收起） */
  expandedDrawer: number | "all" | "uncategorized" | null;
  /** 需要聚焦高亮的笔记（AI 打开笔记时触发） */
  focusNoteId: number | null;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  sortBy: string;
  onSortByChange: (value: string) => void;
  sortOrder: string;
  onToggleSortOrder: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onToggleDrawer: (key: number | "all" | "uncategorized") => void;
  /** 折叠侧边栏（折叠后依靠左边缘把手唤出） */
  onToggleCollapse?: () => void;
  isCollapsed?: boolean;
  /** 打开/关闭 AI 对话面板（全局入口，未打开笔记时也可用） */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
  /** 打开统一的「设置」窗口（含 AI 设置与备份恢复） */
  onOpenSettings?: () => void;
  /** 右键菜单「导出分组」：把整个分组导出为压缩包或电子书 */
  onExportCategory: (category: Category) => void;
  /** 右键菜单「保存笔记」：等价于编辑器里的 Ctrl+S（导出到文件） */
  onSaveNote: (note: Note) => void;
  onCreateCategory: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onCreateNote: (categoryId: number | null) => void;
  onMoveToCategory: (note: Note, categoryId: number | null) => void;
  onOpenTrash: () => void;
  onNotesUpdated: () => void;
  /** 系统文件拖拽经过时命中的分组 id（由主进程拖拽事件驱动的高亮） */
  hoverDropCategoryId?: number | null;
  /** 是否有系统文件正拖拽在窗口上方 */
  isFileDragActive?: boolean;
}
