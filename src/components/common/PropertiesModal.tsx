/**
 * 属性弹窗：右键菜单「笔记属性 / 分组属性」的落地页——只读展示 + 行内改名。
 * target 为 null 时不渲染；note / category / group 三种目标互斥，各渲染一套字段。
 * group 指默认分组或搜索视图的虚拟分组：没有 id、也没有可写回的对象，因此全部只读。
 */
import { useEffect, useState } from "react";
import type { Category, Note, Tag } from "@/interface/note";
import type { AiAccessLevel } from "@/interface/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/aiAccess";
import type { PropertiesTarget } from "@/interface/ui";
import { Modal } from "@/components/common/Modal";
import { Icon } from "@/components/common/Icon";
import { AiAccessLevelSelect } from "@/components/common/AiAccessLevelSelect";

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
  <div className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0 min-h-[38px]">
    <span className="w-[68px] flex-shrink-0 text-xs text-faint">{label}</span>
    <div className="flex-1 min-w-0 flex items-center gap-1.5">
      <div className="flex-1 min-w-0 text-[13px] text-body leading-5 break-all">{content}</div>
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
      active ? "text-primary-500 hover:bg-primary-50" : "text-faint-soft hover:bg-surface-alt hover:text-body"
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
    className="w-full min-w-0 px-2 py-0.5 text-[13px] text-body rounded-md border border-primary-200 bg-surface outline-none focus:border-primary-400"
  />
);

/** 标签编辑态：新建时为 null（草稿输入框），改名为其标签 id */
type TagEdit = { kind: "new" | "rename"; id: number | null; draft: string } | null;

/**
 * 单个标签徽标。
 *
 * 两种来源外观不同：用户的是实底、AI 的是虚线描边——不是为了好看，
 * 是因为**删除 / 改名按钮只挂在用户添加的标签上**，一眼要能看出哪个能点。
 */
const TagChip: React.FC<{
  tag: Tag;
  editable: boolean;
  onRemove: () => void;
  onStartRename: () => void;
}> = ({ tag, editable, onRemove, onStartRename }) => {
  const byAi = tag.source === "ai";
  return (
    <span
      className={`group inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md text-[12px] leading-5 ${
        byAi ? "border border-dashed border-line text-faint bg-transparent" : "bg-surface-alt text-body"
      }`}
      title={byAi ? `AI 生成（${tag.note_count} 篇），不可手动修改` : `用户添加（${tag.note_count} 篇）`}
    >
      <Icon name="shared-tag" className="w-3 h-3 flex-none opacity-60" />
      <span className="truncate">{tag.name}</span>
      {editable && !byAi && (
        <span className="flex items-center gap-0.5 ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            title="重命名标签（全局生效）"
            onClick={onStartRename}
            className="w-4 h-4 rounded flex items-center justify-center text-faint-soft hover:text-primary-500 hover:bg-primary-50"
          >
            <Icon name="sidebar-edit" className="w-3 h-3" />
          </button>
          <button
            type="button"
            title="移除此标签"
            onClick={onRemove}
            className="w-4 h-4 rounded flex items-center justify-center text-faint-soft hover:text-danger hover:bg-danger-soft"
          >
            <Icon name="modal-close" className="w-3 h-3" />
          </button>
        </span>
      )}
    </span>
  );
};

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
  /** 设置笔记的 AI 访问档位（0 禁止 / 1 只读 / 2 完全） */
  onSetNoteAiAccess?: (note: Note, level: AiAccessLevel) => void | Promise<void>;
  /** 设置分组的 AI 访问档位 */
  onSetCategoryAiAccess?: (category: Category, level: AiAccessLevel) => void | Promise<void>;
  /** AI 能力总开关：关闭时整行隐藏（此时 AI 不存在，权限设置没有意义） */
  enableAI?: boolean;
  /** 这篇笔记当前的标签；属性窗自身不发请求，由调用方加载后传入 */
  tags?: Tag[];
  /** 添加标签 / 移除标签 / 标签改名——均返回操作后的最新列表，由父组件回写 */
  onAddTags?: (note: Note, names: string[]) => void | Promise<void>;
  onRemoveTag?: (note: Note, name: string) => void | Promise<void>;
  onRenameTag?: (id: number, name: string) => void | Promise<void>;
}> = ({
  target,
  categories,
  onClose,
  onRenameNote,
  onMoveNote,
  onTogglePin,
  onRenameCategory,
  onSetNoteAiAccess,
  onSetCategoryAiAccess,
  enableAI = false,
  tags = [],
  onAddTags,
  onRemoveTag,
  onRenameTag,
}) => {
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
  // 用身份字符串而非对象引用做依赖：父组件每次渲染都可能传新对象，按引用比较会误伤正在输入的草稿
  useEffect(() => {
    setEditing(null);
    setGroupMenu((m) => ({ ...m, open: false }));
    setAddingTag(false);
    setTagDraft("");
    setTagEdit(null);
  }, [targetKey]);

  /**
   * 字数：列表本身就带正文，直接取，不用再按 id 读一次。
   */
  const wordCount = note ? note.content.length : 0;

  /** 笔记所属分组名；分组已删除时退化为占位文案，避免显示成空白 */
  const categoryName = note
    ? note.category_id === null
      ? "未分类"
      : categories.find((c) => c.id === note.category_id)?.name ?? "未知分组"
    : "";

  /** 笔记所属分组的 AI 档位：分组更严格时，笔记实际只能到这个上限 */
  const groupLevel: AiAccessLevel | null =
    note?.category_id != null
      ? ((categories.find((c) => c.id === note.category_id)?.ai_access ?? 2) as AiAccessLevel)
      : null;
  /** 生效档位 = min(笔记, 分组) */
  const effectiveNoteLevel: AiAccessLevel = note
    ? ((Math.min(note.ai_access, groupLevel ?? 2) as AiAccessLevel) ?? 0)
    : 0;
  /** 分组把笔记卡住了：用来提示"改笔记没用，得先放开分组" */
  const limitedByGroup = note != null && groupLevel !== null && groupLevel < note.ai_access;

  const startEdit = (field: "noteTitle" | "categoryName", draft: string) => setEditing({ field, draft });

  /* ---------------- 标签 ---------------- */
  /** 新建草稿输入框：show=false 时只留一个「+」按钮 */
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  /** 正在改名的标签（行内输入框替掉徽标），与新建互斥 */
  const [tagEdit, setTagEdit] = useState<TagEdit>(null);
  const canEditTags = !!onAddTags && !!onRemoveTag;

  /** 新建草稿提交：支持逗号 / 顿号 / 分号 / 空格分隔一次加多个，已存在的词跳过 */
  const commitTagDraft = () => {
    if (!note) return;
    // 逗号 / 顿号 / 分号分隔，一次能加好几个
    const names = tagDraft
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter((s) => s && !tags.some((t) => t.name.toLowerCase() === s.toLowerCase()));
    setTagDraft("");
    setAddingTag(false);
    if (names.length) void onAddTags?.(note, names);
  };

  const commitTagRename = () => {
    const draft = tagEdit?.draft.trim();
    const id = tagEdit?.id ?? null;
    setTagEdit(null);
    if (!draft || id === null) return;
    const current = tags.find((t) => t.id === id)?.name;
    if (!current || draft === current) return;
    void onRenameTag?.(id, draft);
  };
  /** 提交行内编辑：草稿为空或与原值相同则不回调，避免把标题改空、也省掉一次无谓写库 */
  const commitEdit = () => {
    if (!editing) return;
    const draft = editing.draft.trim();
    const current = editing.field === "noteTitle" ? note?.title : category?.name;
    setEditing(null);
    if (!draft || draft === current) return;
    if (editing.field === "noteTitle" && note) void onRenameNote(note, draft);
    if (editing.field === "categoryName" && category) void onRenameCategory(category, draft);
  };
  /** 分组候选浮层：贴着按钮下沿展开，右侧夹到 innerWidth - 176（minWidth 160 + 边距）防溢出 */
  const openGroupMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setGroupMenu({ open: true, top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 176) });
  };
  const closeGroupMenu = () => setGroupMenu((m) => ({ ...m, open: false }));

  return (
    <Modal isOpen={target !== null} onClose={onClose} title={note ? "笔记属性" : "分组属性"}>
      <div className="rounded-xl border border-line-soft px-3.5 py-1">
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
            <div className="py-2 border-b border-line-soft min-h-[38px]">
              <div className="flex items-start gap-3">
                <span className="w-[68px] flex-shrink-0 text-xs text-faint mt-1">标签</span>
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
                  {tags.length === 0 && !addingTag && (
                    <span className="text-[13px] text-muted leading-5">暂无标签</span>
                  )}
                  {tags.map((tag) =>
                    tagEdit?.kind === "rename" && tagEdit.id === tag.id ? (
                      <input
                        key={tag.id}
                        autoFocus
                        value={tagEdit.draft}
                        onChange={(e) => setTagEdit({ kind: "rename", id: tag.id, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitTagRename();
                          if (e.key === "Escape") setTagEdit(null);
                        }}
                        onBlur={commitTagRename}
                        className="w-28 px-2 py-0.5 text-[12px] text-body rounded-md border border-primary-200 bg-surface outline-none focus:border-primary-400"
                      />
                    ) : (
                      <TagChip
                        key={tag.id}
                        tag={tag}
                        editable={canEditTags}
                        onRemove={() => note && void onRemoveTag?.(note, tag.name)}
                        onStartRename={() => setTagEdit({ kind: "rename", id: tag.id, draft: tag.name })}
                      />
                    ),
                  )}
                  {addingTag ? (
                    <input
                      autoFocus
                      value={tagDraft}
                      placeholder="标签名，可一次输入多个"
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitTagDraft();
                        if (e.key === "Escape") {
                          setTagDraft("");
                          setAddingTag(false);
                        }
                      }}
                      onBlur={commitTagDraft}
                      className="w-44 px-2 py-0.5 text-[12px] text-body rounded-md border border-primary-200 bg-surface outline-none focus:border-primary-400"
                    />
                  ) : (
                    canEditTags && (
                      <button
                        type="button"
                        title="添加标签"
                        onClick={() => setAddingTag(true)}
                        className="inline-flex items-center gap-0.5 px-1.5 h-[24px] rounded-md text-[12px] text-faint-soft hover:text-primary-500 hover:bg-primary-50 transition-colors"
                      >
                        <Icon name="sidebar-plus" className="w-3 h-3" />
                        <span>标签</span>
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
            <Row
              label="收藏状态"
              content={<span className={note.is_pinned ? "text-primary-500" : "text-muted"}>{note.is_pinned ? "已收藏" : "未收藏"}</span>}
              action={
                <RowButton
                  icon={note.is_pinned ? "sidebar-star-filled" : "sidebar-star"}
                  title={note.is_pinned ? "取消收藏" : "收藏"}
                  active={note.is_pinned}
                  onClick={() => void onTogglePin(note)}
                />
              }
            />
            {/* 关闭 AI 能力时整行不显示：那时 AI 不存在，权限设置没有意义 */}
            {enableAI && (
              <Row
                label="AI 访问"
                content={
                  limitedByGroup ? (
                    <span className="text-warning">
                      实际生效：{AI_ACCESS_LABELS[effectiveNoteLevel]}（受所属分组限制）
                    </span>
                  ) : effectiveNoteLevel === 0 ? (
                    <span className="text-danger">AI 完全看不到这篇笔记</span>
                  ) : (
                    <span className="text-body">{AI_ACCESS_LABELS[effectiveNoteLevel]}访问</span>
                  )
                }
                action={
                  <AiAccessLevelSelect
                    value={note.ai_access}
                    disabled={!onSetNoteAiAccess}
                    onChange={(level) => void onSetNoteAiAccess?.(note, level)}
                  />
                }
              />
            )}
            <Row label="字数" content={`${wordCount.toLocaleString()} 字`} />
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
            {enableAI && (
              <Row
                label="AI 访问"
                content={
                  category.ai_access === 0 ? (
                    <span className="text-danger">组内笔记全部对 AI 不可见</span>
                  ) : (
                    <span className="text-body">
                      组内笔记上限：{AI_ACCESS_LABELS[category.ai_access]}
                    </span>
                  )
                }
                action={
                  <AiAccessLevelSelect
                    value={category.ai_access}
                    disabled={!onSetCategoryAiAccess}
                    onChange={(level) => void onSetCategoryAiAccess?.(category, level)}
                  />
                }
              />
            )}
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
