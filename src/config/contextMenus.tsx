/**
 * 侧边栏右键菜单的固定配置：按目标类型拼装菜单项，不写入数据库。
 * 文案、图标、顺序与条件可见性都集中在这里，Sidebar 只负责识别目标并传入回调。
 */

import type { Category, Note } from "@/interface/note";
import type { ContextMenuItem } from "@/interface/ui";
import { Icon } from "@/components/common/Icon";
import { translate } from "@/i18n";

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
  /** 真实分组是否整体加密；缺省视为未加密 */
  encrypted?: boolean;
  /** 加密分组当前是否锁着（锁着时不能新建笔记、不能导出） */
  locked?: boolean;
  onEncrypt?: () => void;
  onLock?: () => void;
  onDecrypt?: () => void;
}

/** 笔记菜单需要的回调：由调用方按当前笔记拼好 */
export interface NoteMenuHandlers {
  onOpenNote: () => void;
  onSaveNote: () => void;
  onMoveToCategory: (categoryId: number | null) => void;
  onTogglePin: () => void;
  onDeleteNote: () => void;
  onShowProperties: () => void;
  onEncrypt?: () => void;
  onLock?: () => void;
  onDecrypt?: () => void;
  /** 分组加密的笔记：解锁/锁定/永久解密都作用在所属分组上 */
  onLockGroup?: () => void;
  onDecryptGroup?: () => void;
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
  const encrypted = isCategory && handlers.encrypted === true;
  const locked = encrypted && handlers.locked === true;
  const items: ContextMenuItem[] = [
    {
      label: isExpanded ? translate("折叠分组") : translate("展开分组"),
      icon: <Icon name="sidebar-chevron-right" className="w-4 h-4" />,
      onClick: handlers.onToggleDrawer,
    },
  ];
  // 加密锁定的分组不能往里建笔记：密钥不在内存，后端会直接拒绝
  if (!isSearchGroup && !locked) {
    items.push({
      label: translate("在此分组新建笔记"),
      icon: <Icon name="sidebar-plus" className="w-4 h-4" />,
      onClick: handlers.onCreateNote,
    });
  }
  // 导出会把正文解密成文件，加密分组一律不导出
  if (!encrypted) {
    items.push({
      label: translate("导出分组"),
      icon: <Icon name="editor-export" className="w-4 h-4" />,
      onClick: handlers.onExport,
    });
  }
  if (isCategory) {
    items.push(divider(), {
      label: translate("重命名"),
      icon: <Icon name="sidebar-edit" className="w-4 h-4" />,
      onClick: handlers.onRename,
    });
  }
  if (isCategory) {
    if (!encrypted) {
      items.push({
        label: translate("加密分组…"),
        icon: <Icon name="security-lock" className="w-4 h-4" />,
        onClick: () => handlers.onEncrypt?.(),
      });
    } else {
      // 临时解锁走「点击展开」的弹窗，菜单里不再放解锁项；已解锁时给回锁定入口
      if (!locked) {
        items.push({
          label: translate("立即锁定分组"),
          icon: <Icon name="security-lock" className="w-4 h-4" />,
          onClick: () => handlers.onLock?.(),
        });
      }
      items.push({
        label: translate("解密分组…"),
        icon: <Icon name="security-unlock" className="w-4 h-4" />,
        onClick: () => handlers.onDecrypt?.(),
      });
    }
  }
  if (!isSearchGroup) {
    items.push({
      label: translate("新建分组"),
      icon: <Icon name="sidebar-folder-plus" className="w-4 h-4" />,
      onClick: handlers.onCreateCategory,
    });
  }
  if (isCategory && !encrypted) {
    items.push(divider(), {
      label: translate("删除分组"),
      icon: <Icon name="sidebar-trash" className="w-4 h-4" />,
      onClick: handlers.onDelete,
      danger: true,
    });
  }
  items.push(divider(), {
    label: translate("分组属性"),
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
): ContextMenuItem[] => {
  const encrypted = note.enc_mode !== 0;
  // 加密笔记不能换分组（密文是用原分组密钥 / 自己的 DEK 封的），加密分组也不能被移入
  const moveTargets = categories.filter((cat) => !cat.is_encrypted);
  const items: ContextMenuItem[] = [
    {
      label: translate("打开笔记"),
      icon: <Icon name="sidebar-eye" className="w-4 h-4" />,
      onClick: handlers.onOpenNote,
    },
  ];
  if (!encrypted) {
    items.push({
      label: translate("保存笔记"),
      icon: <Icon name="editor-export" className="w-4 h-4" />,
      onClick: handlers.onSaveNote,
    }, {
      label: translate("移动分组"),
      icon: <Icon name="sidebar-folder" className="w-4 h-4" />,
      onClick: () => { },
      submenu: [
        {
          label: translate("未分类"),
          icon: <Icon name="sidebar-list" className="w-4 h-4" />,
          onClick: () => handlers.onMoveToCategory(null),
          disabled: note.category_id === null,
        },
        ...moveTargets.map((cat) => ({
          label: cat.name,
          icon: <Icon name="sidebar-folder" className="w-4 h-4" />,
          onClick: () => handlers.onMoveToCategory(cat.id),
          disabled: note.category_id === cat.id,
        })),
      ],
    }, {
      label: translate("加密笔记…"),
      icon: <Icon name="security-lock" className="w-4 h-4" />,
      onClick: () => handlers.onEncrypt?.(),
    });
  } else if (note.enc_mode === 1) {
    // 临时解锁走「点击笔记」的弹窗，菜单里不再放解锁项；已解锁时给回锁定入口
    if (!note.is_locked) {
      items.push({
        label: translate("立即锁定笔记"),
        icon: <Icon name="security-lock" className="w-4 h-4" />,
        onClick: () => handlers.onLock?.(),
      });
    }
    items.push({
      label: translate("解密笔记…"),
      icon: <Icon name="security-unlock" className="w-4 h-4" />,
      onClick: () => handlers.onDecrypt?.(),
    });
  } else {
    // 分组加密的笔记本身没有独立密钥：锁定与解密都作用在所属分组上
    const group = note.category_id === null
      ? undefined
      : categories.find((cat) => cat.id === note.category_id);
    if (group) {
      if (!note.is_locked) {
        items.push({
          label: translate("立即锁定分组"),
          icon: <Icon name="security-lock" className="w-4 h-4" />,
          onClick: () => handlers.onLockGroup?.(),
        });
      }
      items.push({
        label: translate("解密分组…"),
        icon: <Icon name="security-unlock" className="w-4 h-4" />,
        onClick: () => handlers.onDecryptGroup?.(),
      });
    } else {
      items.push({
        label: translate("此笔记随所属分组加密，请在分组上操作"),
        icon: <Icon name="security-lock" className="w-4 h-4" />,
        onClick: () => { },
        disabled: true,
      });
    }
  }
  items.push(
    divider(),
    {
      label: note.is_pinned ? translate("取消收藏") : translate("收藏笔记"),
      icon: <Icon name={note.is_pinned ? "sidebar-star-filled" : "sidebar-star"} className="w-4 h-4" />,
      onClick: handlers.onTogglePin,
    },
  );
  // 加密笔记不能删除（临时解锁也不允许）：只放一条说明，删除必须先永久解密
  if (encrypted) {
    items.push({
      label: translate("加密笔记需先永久解密才能删除"),
      icon: <Icon name="security-lock" className="w-4 h-4" />,
      onClick: () => { },
      disabled: true,
    });
  } else {
    items.push({
      label: translate("删除笔记"),
      icon: <Icon name="sidebar-trash" className="w-4 h-4" />,
      onClick: handlers.onDeleteNote,
      danger: true,
    });
  }
  items.push(
    divider(),
    {
      label: translate("笔记属性"),
      icon: <Icon name="toast-info" className="w-4 h-4" />,
      onClick: handlers.onShowProperties,
    },
  );
  return items;
};
