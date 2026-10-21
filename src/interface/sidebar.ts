/* 侧边栏与分组抽屉的组件层 Props：只描述界面数据与回调，状态由 App 持有。 */

import type * as React from "react";

import type { Category, Note } from "./note";
import type { ExportTarget } from "./exportCategory";
import type { NoteSearchHit } from "@/lib/noteSearch";

/**
 * 单个可展开抽屉（一个分组 / 全部笔记 / 未分类）的 Props。
 * 搜索视图会复用本组件渲染「标题命中 / 正文命中」两个虚拟分组。
 */
export interface CategoryDrawerProps {
  /** 抽屉对应的真实分组；「全部笔记」「未分类」等虚拟抽屉为 null */
  category: Category | null;
  notes: Note[];
  isExpanded: boolean;
  /** 是否为「全部笔记」抽屉（标题、图标与计数都不同） */
  isAllNotes: boolean;
  selectedNoteId: number | null;
  /** 需要高亮并滚动到可视区的笔记（由 AI 打开笔记等操作触发） */
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  /** 切换收藏（置顶）状态 */
  onTogglePin: (note: Note) => void;
  onCreateNote: () => void;
  onContextMenu: (e: React.MouseEvent, category: Category | null) => void;
  onNoteContextMenu: (e: React.MouseEvent, note: Note) => void;
  /** 覆盖抽屉标题（搜索视图的「标题命中 / 正文命中」等虚拟分组使用） */
  headerTitle?: string;
  /** 覆盖抽屉图标名 */
  headerIcon?: string;
  /**
   * 搜索视图的命中信息：note.id → 命中区间与上下文片段。
   * 只有搜索视图传；没传时列表按普通笔记渲染（省掉逐条分段的开销）。
   */
  hits?: Map<number, NoteSearchHit>;
}

/** 侧边栏 Props：分组列表 + 收藏视图 + 搜索/排序状态 + 各类右键菜单回调 */
export interface SidebarProps {
  categories: Category[];
  notes: Note[];
  /** 全部笔记（含未分类）的篇数，显示在「全部笔记」入口 */
  allNotesCount: number;
  selectedCategoryId: number | null;
  selectedNoteId: number | null;
  /** 抽屉展开状态：'all' | 分组ID | 'uncategorized' | null（全部收起） */
  expandedDrawer: number | "all" | "uncategorized" | null;
  /** 需要聚焦高亮的笔记（AI 打开笔记时触发） */
  focusNoteId: number | null;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /**
   * 搜索框是否按正则匹配（软件设置「笔记搜索支持正则」）。
   * 传给 lib/noteSearch 决定解释方式；正则非法时按零结果处理并在界面上提示。
   */
  useRegex?: boolean;
  /**
   * 一次搜索被"执行"（回车 / 选中历史）时的回调，用于把查询词记进搜索历史。
   * 逐字符输入不触发：历史里塞满同一个词的各种前缀就没什么用了。
   */
  onCommitSearch?: (query: string) => void;
  /** 搜索历史（最近用过的查询词），为空时不显示下拉 */
  searchHistory?: string[];
  /** 划掉某一条搜索历史 */
  onRemoveSearchHistory?: (query: string) => void;
  /** 清空搜索历史 */
  onClearSearchHistory?: () => void;
  /** 排序字段（透传 ViewSettings.sortBy：updated_at / created_at / title） */
  sortBy: string;
  onSortByChange: (value: string) => void;
  /** 排序方向（asc / desc，类型在此放宽为 string） */
  sortOrder: string;
  onToggleSortOrder: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  /** 切换收藏（置顶）状态：收藏的笔记在分组内置顶，并出现在收藏视图 */
  onTogglePin: (note: Note) => void;
  /** 侧边栏视图：'groups' 分组视图 / 'favorites' 收藏聚合视图 */
  view: "groups" | "favorites";
  onViewChange: (view: "groups" | "favorites") => void;
  onToggleDrawer: (key: number | "all" | "uncategorized") => void;
  /** 折叠侧边栏（折叠后依靠左边缘把手唤出） */
  onToggleCollapse?: () => void;
  isCollapsed?: boolean;
  /** 打开/关闭 AI 对话面板（全局入口，未打开笔记时也可用） */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
  /** 打开统一的「设置」窗口（含 AI 设置与备份恢复） */
  onOpenSettings?: () => void;
  /** 右键菜单「导出分组」：真实分组、默认分组、搜索分组统一走这里 */
  onExportGroup: (target: ExportTarget) => void;
  /** 右键菜单「保存笔记」：等价于编辑器里的 Ctrl+S（导出到文件） */
  onSaveNote: (note: Note) => void;
  onCreateCategory: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onCreateNote: (categoryId: number | null) => void;
  onMoveToCategory: (note: Note, categoryId: number | null) => void;
  onOpenTrash: () => void;
  /** 右键菜单「笔记属性」：打开只读属性弹窗 */
  onShowNoteProperties: (note: Note) => void;
  /** 右键菜单「分组属性」：打开只读属性弹窗 */
  onShowCategoryProperties: (category: Category) => void;
  /** 右键菜单「分组属性」：默认分组 / 搜索视图分组（虚拟分组）走这里 */
  onShowGroupProperties: (name: string, noteCount: number) => void;
  onNotesUpdated: () => void;
  /** 系统文件拖拽经过时命中的分组 id（由主进程拖拽事件驱动的高亮） */
  hoverDropCategoryId?: number | null;
  /** 是否有系统文件正拖拽在窗口上方 */
  isFileDragActive?: boolean;
}
