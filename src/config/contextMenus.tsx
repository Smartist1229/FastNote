/**
 * 侧边栏右键菜单的固定配置：按目标类型拼装菜单项，不写入数据库。
 * 文案、图标、顺序与条件可见性都集中在这里，Sidebar 只负责识别目标并传入回调。
 */

import type { Category, Note } from "@/interface/note";
import type { ContextMenuItem } from "@/interface/ui";
import { Icon } from "@/components/common/Icon";

/** 能弹出「分组菜单」的目标类型：真实分组、两个默认分组、搜索视图的四个虚拟分组 */
export type GroupMenuKind = "category" | "all" | "uncategorized" | "search-all" | "search-title" | "search-content" | "search-semantic";

/** 搜索视图的虚拟分组：只承载结果展示，不是真实分组，因此不能新建 / 改名 / 删除 */
export const SEARCH_GROUP_KINDS: GroupMenuKind[] = ["search-all", "search-title", "search-content", "search-semantic"];
export const isSearchGroupKind = (kind: GroupMenuKind) => SEARCH_GROUP_KINDS.includes(kind);

/** 菜单项里的分隔线（ContextMenuItem 要求 label/onClick 必填，故给空实现） */
const divider = (): ContextMenuItem => ({ divider: true, label: "", onClick: () => { } });

/** 分组菜单需要的回调：由调用方按当前分组拼好 */
export interface GroupMenuHandlers {
  /** 展开 / 折叠分组 */
  onToggleDrawer: () => void;
  /** 在此分组新建笔记 */
  onCreateNote: () => void;
  /** 导出分组 */
  onExport: () => void;
  /** 重命名分组（仅真实分组） */
  onRename: () => void;
  /** 新建分组 */
  onCreateCategory: () => void;
  /** 删除分组（仅真实分组） */
  onDelete: () => void;
  /** 查看分组属性 */
  onShowProperties: () => void;
}

/** 笔记菜单需要的回调：由调用方按当前笔记拼好 */
export interface NoteMenuHandlers {
  onOpenNote: () => void;
  onSaveNote: () => void;
  onMoveToCategory: (categoryId: number | null) => void;
  onTogglePin: () => void;
  onDeleteNote: () => void;
  onShowProperties: () => void;
}

/**
 * 分组菜单，按 kind 决定可见项：
 * - 真实分组：展开折叠 / 新建笔记 / 导出 / 重命名 / 新建分组 / 删除分组 / 属性
 * - 默认分组（全部笔记、未分类）：没有「重命名」「删除分组」——它们是固定视图，不存在可改的名字
 * - 搜索视图的虚拟分组：只有展开折叠 / 导出 / 属性，既不能新建笔记，也没有分组增删改
 * 分隔线只用来把"组操作 / 单项操作 / 属性"三类隔开，不按固定模板输出。
 */
export const buildGroupMenu = (
  kind: GroupMenuKind,
  isExpanded: boolean,
  handlers: GroupMenuHandlers
): ContextMenuItem[] => {
  const isCategory = kind === "category";
  const isSearchGroup = isSearchGroupKind(kind);
  const items: ContextMenuItem[] = [
    {
      label: isExpanded ? "折叠分组" : "展开分组",
      icon: <Icon name="sidebar-chevron-right" className="w-4 h-4" />,
      onClick: handlers.onToggleDrawer,
    },
  ];
  if (!isSearchGroup) {
    items.push({
      label: "在此分组新建笔记",
      icon: <Icon name="sidebar-plus" className="w-4 h-4" />,
      onClick: handlers.onCreateNote,
    });
  }
  items.push({
    label: "导出分组",
    icon: <Icon name="editor-export" className="w-4 h-4" />,
    onClick: handlers.onExport,
  });
  if (isCategory) {
    items.push(divider(), {
      label: "重命名",
      icon: <Icon name="sidebar-edit" className="w-4 h-4" />,
      onClick: handlers.onRename,
    });
  }
  if (!isSearchGroup) {
    items.push({
      label: "新建分组",
      icon: <Icon name="sidebar-folder-plus" className="w-4 h-4" />,
      onClick: handlers.onCreateCategory,
    });
  }
  if (isCategory) {
    items.push(divider(), {
      label: "删除分组",
      icon: <Icon name="sidebar-trash" className="w-4 h-4" />,
      onClick: handlers.onDelete,
      danger: true,
    });
  }
  items.push(divider(), {
    label: "分组属性",
    icon: <Icon name="toast-info" className="w-4 h-4" />,
    onClick: handlers.onShowProperties,
  });
  return items;
};

/**
 * 笔记菜单：打开 / 保存 / 移动分组 / 收藏 / 删除 / 属性。
 * 「移动分组」子菜单把笔记当前所在的分组（含"未分类"）置灰，避免点选后没有任何变化；
 * 收藏项按 is_pinned 切换文案与实心 / 空心图标。
 */
export const buildNoteMenu = (
  note: Note,
  categories: Category[],
  handlers: NoteMenuHandlers
): ContextMenuItem[] => [
  {
    label: "打开笔记",
    icon: <Icon name="sidebar-eye" className="w-4 h-4" />,
    onClick: handlers.onOpenNote,
  },
  {
    label: "保存笔记",
    icon: <Icon name="editor-export" className="w-4 h-4" />,
    onClick: handlers.onSaveNote,
  },
  {
    label: "移动分组",
    icon: <Icon name="sidebar-folder" className="w-4 h-4" />,
    onClick: () => { },
    submenu: [
      {
        label: "未分类",
        icon: <Icon name="sidebar-list" className="w-4 h-4" />,
        onClick: () => handlers.onMoveToCategory(null),
        disabled: note.category_id === null,
      },
      ...categories.map((cat) => ({
        label: cat.name,
        icon: <Icon name="sidebar-folder" className="w-4 h-4" />,
        onClick: () => handlers.onMoveToCategory(cat.id),
        disabled: note.category_id === cat.id,
      })),
    ],
  },
  divider(),
  {
    label: note.is_pinned ? "取消收藏" : "收藏笔记",
    icon: <Icon name={note.is_pinned ? "sidebar-star-filled" : "sidebar-star"} className="w-4 h-4" />,
    onClick: handlers.onTogglePin,
  },
  {
    label: "删除笔记",
    icon: <Icon name="sidebar-trash" className="w-4 h-4" />,
    onClick: handlers.onDeleteNote,
    danger: true,
  },
  divider(),
  {
    label: "笔记属性",
    icon: <Icon name="toast-info" className="w-4 h-4" />,
    onClick: handlers.onShowProperties,
  },
];
