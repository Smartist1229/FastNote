import { useEffect, useState } from "react";
import type { Category, Note } from "@/interface/note";
import type { PropertiesTarget } from "@/interface/ui";
import { Modal } from "@/components/common/Modal";
import { Icon } from "@/components/common/Icon";

/** 把库里的时间串格式化为「YYYY-MM-DD HH:mm」，异常时原样返回 */
const formatDateTime = (value: string | null) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 属性行：左侧字段名，中间内容，右侧操作按钮 */
const Row: React.FC<{ label: string; content: React.ReactNode; action?: React.ReactNode }> = ({ label, content, action }) => (
  <div className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0 min-h-[38px]">
    <span className="w-[68px] flex-shrink-0 text-xs text-slate-400">{label}</span>
    <div className="flex-1 min-w-0 flex items-center gap-1.5">
      <div className="flex-1 min-w-0 text-[13px] text-slate-700 leading-5 break-all">{content}</div>
      {action}
    </div>
  </div>
);

/** 行内操作按钮：小图标按钮，悬停显色 */
const RowButton: React.FC<{ icon: string; title: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean }> = ({
  icon,
  title,
  onClick,
  active = false,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={`flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
      active ? "text-primary-500 hover:bg-primary-50" : "text-slate-300 hover:bg-slate-100 hover:text-slate-600"
    }`}
  >
    <Icon name={icon} className="w-3.5 h-3.5" />
  </button>
);

/** 行内输入框：回车提交，Esc 取消 */
const RowInput: React.FC<{ value: string; onChange: (value: string) => void; onCommit: () => void; onCancel: () => void }> = ({
  value,
  onChange,
  onCommit,
  onCancel,
}) => (
  <input
    autoFocus
    value={value}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter") onCommit();
      if (e.key === "Escape") onCancel();
    }}
    className="w-full min-w-0 px-2 py-0.5 text-[13px] text-slate-700 rounded-md border border-primary-200 bg-white outline-none focus:border-primary-400"
  />
);

/** 属性弹窗：右键菜单「笔记属性 / 分组属性」进入，可修改的字段带行内编辑按钮 */
export const PropertiesModal: React.FC<{
  target: PropertiesTarget | null;
  categories: Category[];
  onClose: () => void;
  /** 重命名笔记标题 */
  onRenameNote: (note: Note, title: string) => void | Promise<void>;
  /** 移动笔记到指定分组（null = 未分类） */
  onMoveNote: (note: Note, categoryId: number | null) => void | Promise<void>;
  /** 切换收藏状态 */
  onTogglePin: (note: Note) => void | Promise<void>;
  /** 重命名分组 */
  onRenameCategory: (category: Category, name: string) => void | Promise<void>;
}> = ({ target, categories, onClose, onRenameNote, onMoveNote, onTogglePin, onRenameCategory }) => {
  const note: Note | null = target?.kind === "note" ? target.note : null;
  const category: Category | null = target?.kind === "category" ? target.category : null;
  const virtualGroup = target?.kind === "group" ? target : null;
  /** 正在编辑的字段与草稿；null 表示没有字段处于编辑态 */
  const [editing, setEditing] = useState<{ field: "noteTitle" | "categoryName"; draft: string } | null>(null);
  /** 所属分组候选浮层：fixed 定位，避免被弹窗的 overflow-hidden 裁掉 */
  const [groupMenu, setGroupMenu] = useState<{ open: boolean; top: number; left: number }>({ open: false, top: 0, left: 0 });
  const targetKey = note
    ? `note-${note.id}`
    : category
      ? `category-${category.id}`
      : virtualGroup
        ? `group-${virtualGroup.name}`
        : "";
  // 换查看对象时收起编辑态，避免把上一条的草稿带过来
  useEffect(() => {
    setEditing(null);
    setGroupMenu((m) => ({ ...m, open: false }));
  }, [targetKey]);

  const categoryName = note
    ? note.category_id === null
      ? "未分类"
      : categories.find((c) => c.id === note.category_id)?.name ?? "未知分组"
    : "";

  const startEdit = (field: "noteTitle" | "categoryName", draft: string) => setEditing({ field, draft });
  const commitEdit = () => {
    if (!editing) return;
    const draft = editing.draft.trim();
    const current = editing.field === "noteTitle" ? note?.title : category?.name;
    setEditing(null);
    if (!draft || draft === current) return;
    if (editing.field === "noteTitle" && note) void onRenameNote(note, draft);
    if (editing.field === "categoryName" && category) void onRenameCategory(category, draft);
  };
  const openGroupMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setGroupMenu({ open: true, top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 176) });
  };
  const closeGroupMenu = () => setGroupMenu((m) => ({ ...m, open: false }));

  return (
    <Modal isOpen={target !== null} onClose={onClose} title={note ? "笔记属性" : "分组属性"}>
      <div className="rounded-xl border border-slate-100 px-3.5 py-1">
        {note && (
          <>
            <Row
              label="标题"
              content={
                editing?.field === "noteTitle" ? (
                  <RowInput
                    value={editing.draft}
                    onChange={(v) => setEditing({ field: "noteTitle", draft: v })}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  note.title || "无标题"
                )
              }
              action={
                <RowButton
                  icon={editing?.field === "noteTitle" ? "sidebar-check" : "sidebar-edit"}
                  title={editing?.field === "noteTitle" ? "保存标题" : "编辑标题"}
                  active={editing?.field === "noteTitle"}
                  onClick={() => (editing?.field === "noteTitle" ? commitEdit() : startEdit("noteTitle", note.title))}
                />
              }
            />
            <Row
              label="所属分组"
              content={categoryName}
              action={<RowButton icon="sidebar-edit" title="移动到其他分组" onClick={openGroupMenu} />}
            />
            <Row
              label="收藏状态"
              content={<span className={note.is_pinned ? "text-primary-500" : "text-slate-500"}>{note.is_pinned ? "已收藏" : "未收藏"}</span>}
              action={
                <RowButton
                  icon={note.is_pinned ? "sidebar-star-filled" : "sidebar-star"}
                  title={note.is_pinned ? "取消收藏" : "收藏"}
                  active={note.is_pinned}
                  onClick={() => void onTogglePin(note)}
                />
              }
            />
            <Row label="字数" content={`${note.content.length.toLocaleString()} 字`} />
            <Row label="创建时间" content={formatDateTime(note.created_at)} />
            <Row label="更新时间" content={formatDateTime(note.updated_at)} />
            <Row label="编号" content={note.id} />
          </>
        )}
        {category && (
          <>
            <Row
              label="名称"
              content={
                editing?.field === "categoryName" ? (
                  <RowInput
                    value={editing.draft}
                    onChange={(v) => setEditing({ field: "categoryName", draft: v })}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  category.name || "未命名分组"
                )
              }
              action={
                <RowButton
                  icon={editing?.field === "categoryName" ? "sidebar-check" : "sidebar-edit"}
                  title={editing?.field === "categoryName" ? "保存名称" : "编辑名称"}
                  active={editing?.field === "categoryName"}
                  onClick={() => (editing?.field === "categoryName" ? commitEdit() : startEdit("categoryName", category.name))}
                />
              }
            />
            <Row label="笔记数量" content={`${category.note_count.toLocaleString()} 篇`} />
            <Row label="创建时间" content={formatDateTime(category.created_at)} />
            <Row label="编号" content={category.id} />
          </>
        )}
        {virtualGroup && (
          <>
            <Row label="名称" content={virtualGroup.name} />
            <Row label="笔记数量" content={`${virtualGroup.noteCount.toLocaleString()} 篇`} />
            <Row label="编号" content="此分组为默认分组" />
          </>
        )}
      </div>

      {groupMenu.open && note && (
        <>
          <div className="fixed inset-0 z-50" onClick={closeGroupMenu} />
          <div className="pop-menu" style={{ position: "fixed", top: groupMenu.top, left: groupMenu.left, minWidth: 160 }}>
            <button
              type="button"
              className={"pop-menu-item" + (note.category_id === null ? " is-active" : "")}
              onClick={() => {
                closeGroupMenu();
                void onMoveNote(note, null);
              }}
            >
              <Icon name="sidebar-list" className="w-3 h-3 flex-shrink-0" />
              <span>未分类</span>
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={"pop-menu-item" + (note.category_id === c.id ? " is-active" : "")}
                onClick={() => {
                  closeGroupMenu();
                  void onMoveNote(note, c.id);
                }}
              >
                <Icon name="sidebar-folder" className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
};
