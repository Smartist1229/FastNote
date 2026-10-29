/**
 * 属性弹窗：右键菜单「笔记属性 / 分组属性」的落地页——只读展示 + 行内改名。
 * target 为 null 时不渲染；note / category / group 三种目标互斥，各渲染一套字段。
 * group 指默认分组或搜索视图的虚拟分组：没有 id、也没有可写回的对象，因此全部只读。
 */
import { useI18n } from "@/i18n";
import { useEffect, useState } from "react";
import type { Category, Note, NoteHistoryEntry, NoteHistoryKind, Tag } from "@/interface/note";
import type { AiAccessLevel } from "@/interface/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/aiAccess";
import type { PropertiesTarget } from "@/interface/ui";
import * as encryptionApi from "@/api/encryption";
import { Modal } from "@/components/common/Modal";
import { Icon } from "@/components/common/Icon";
import { AiAccessLevelSelect } from "@/components/common/AiAccessLevelSelect";
import { HistoryDiffModal } from "@/components/common/HistoryDiffModal";
import { formatDateTime } from "@/lib/format";

/** 属性行：左侧字段名，中间内容，右侧操作按钮 */
const Row: React.FC<{ label: string; content: React.ReactNode; action?: React.ReactNode }> = ({ label, content, action }) => (
  <div className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0 min-h-[38px]">
    <span className="w-[92px] flex-shrink-0 text-xs text-faint">{label}</span>
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

/** 历史版本类型徽标：自动版本不加徽标，其余标明来源 */
const HISTORY_KIND_LABELS: Record<NoteHistoryKind, string> = {
  auto: "",
  session: "打开时",
  manual: "手动",
  "pre-rollback": "回滚前",
};

/** 固定按钮提示：手动版本本来就长期保留，星标对它只是标记 */
const historyPinTitle = (entry: NoteHistoryEntry) => {
  if (entry.kind === "manual") {
    return entry.pinned ? "取消标记（手动版本始终保留）" : "标记为固定（手动版本本就始终保留）";
  }
  return entry.pinned ? "取消固定（之后可能被自动清理）" : "固定此版本（不会被自动清理）";
};

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
  const { t } = useI18n();
  const byAi = tag.source === "ai";
  return (
    <span
      className={`group inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md text-[12px] leading-5 ${
        byAi ? "border border-dashed border-line text-faint bg-transparent" : "bg-surface-alt text-body"
      }`}
      title={byAi ? t(tag.note_count === 1 ? "AI 生成（1 篇），不可手动修改" : "AI 生成（{count} 篇），不可手动修改", { count: tag.note_count }) : t(tag.note_count === 1 ? "用户添加（1 篇）" : "用户添加（{count} 篇）", { count: tag.note_count })}
    >
      <Icon name="shared-tag" className="w-3 h-3 flex-none opacity-60" />
      <span className="truncate">{tag.name}</span>
      {editable && !byAi && (
        <span className="flex items-center gap-0.5 ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            title={t("重命名标签（全局生效）")}
            onClick={onStartRename}
            className="w-4 h-4 rounded flex items-center justify-center text-faint-soft hover:text-primary-500 hover:bg-primary-50"
          >
            <Icon name="sidebar-edit" className="w-3 h-3" />
          </button>
          <button
            type="button"
            title={t("移除此标签")}
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
  /** 这篇笔记的历史版本；同样由父组件按需加载后传入 */
  history?: NoteHistoryEntry[];
  /** 在编辑器里以只读方式预览某个历史版本（父组件负责打开预览并关闭属性窗） */
  onPreviewHistory?: (entry: NoteHistoryEntry) => void;
  /** 回滚到某个历史版本（父组件负责写库并刷新 notes / 编辑器） */
  onRollbackHistory?: (entry: NoteHistoryEntry) => void | Promise<void>;
  /** 删除单条历史版本 */
  onDeleteHistory?: (entry: NoteHistoryEntry) => void | Promise<void>;
  /** 清空这篇笔记的全部历史版本 */
  onClearHistory?: () => void | Promise<void>;
  /** 把当前内容手动存成一个历史版本（内容未变化时后端不会重复写） */
  onCreateHistoryVersion?: () => void | Promise<void>;
  /** 固定 / 取消固定某个版本：固定的版本不会被自动清理 */
  onToggleHistoryPinned?: (entry: NoteHistoryEntry) => void | Promise<void>;
  /** 加密动作：弹窗只负责触发，密码收集与命令调用由 App 负责 */
  onEncryptNote?: (note: Note) => void;
  onUnlockNote?: (note: Note) => void;
  onLockNote?: (note: Note) => void;
  onDecryptNote?: (note: Note) => void;
  onEncryptCategory?: (category: Category) => void;
  onUnlockCategory?: (category: Category) => void;
  onLockCategory?: (category: Category) => void;
  onDecryptCategory?: (category: Category) => void;
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
  history = [],
  onPreviewHistory,
  onRollbackHistory,
  onDeleteHistory,
  onClearHistory,
  onCreateHistoryVersion,
  onToggleHistoryPinned,
  onEncryptNote,
  onUnlockNote,
  onLockNote,
  onDecryptNote,
  onEncryptCategory,
  onUnlockCategory,
  onLockCategory,
  onDecryptCategory,
}) => {
  const { locale, t } = useI18n();
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
    setConfirmRollbackId(null);
    setConfirmDeleteId(null);
    setConfirmClear(false);
    setDiffEntry(null);
  }, [targetKey]);

  /**
   * 根密码可恢复性不在 Note / Category 行里，单独问后端：早期数据的 wrap_root 可能为空。
   * null 表示未取到（非加密项或查询中）。
   */
  const [rootWrapped, setRootWrapped] = useState<boolean | null>(null);
  useEffect(() => {
    const scope = note && note.enc_mode !== 0 ? "note" : category?.is_encrypted ? "category" : null;
    const id = note?.id ?? category?.id ?? null;
    setRootWrapped(null);
    if (!scope || id === null) return;
    let cancelled = false;
    encryptionApi
      .getEncryptionInfo(scope, id)
      .then((info) => {
        if (!cancelled) setRootWrapped(info.root_wrapped);
      })
      .catch(() => {
        if (!cancelled) setRootWrapped(null);
      });
    return () => {
      cancelled = true;
    };
  }, [targetKey, note?.enc_mode, category?.is_encrypted]);

  /**
   * 字数：列表本身就带正文，直接取，不用再按 id 读一次。
   */
  const wordCount = note ? note.content.length : 0;

  /** 笔记所属分组名；分组已删除时退化为占位文案，避免显示成空白 */
  const categoryName = note
    ? note.category_id === null
      ? t("未分类")
      : categories.find((c) => c.id === note.category_id)?.name ?? t("未知分组")
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

  /** 锁定态：标题/正文不下发、标签不可改、历史不可读，界面上要明确说明原因 */
  const noteLocked = note != null && note.enc_mode !== 0 && note.is_locked;

  /* ---------------- 标签 ---------------- */
  /** 新建草稿输入框：show=false 时只留一个「+」按钮 */
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  /** 正在改名的标签（行内输入框替掉徽标），与新建互斥 */
  const [tagEdit, setTagEdit] = useState<TagEdit>(null);
  // 加密笔记的标签随正文一起加密，后端也会拒绝直接增删
  const canEditTags = !!onAddTags && !!onRemoveTag && note?.enc_mode === 0;
  /** 二次确认中的历史版本 id：回滚会覆盖当前正文，点一次先亮出「确认」 */
  const [confirmRollbackId, setConfirmRollbackId] = useState<number | null>(null);
  /** 二次确认中的删除 / 清空：删了就找不回来，同样先亮「确认」 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  /** 正在对比的历史版本：弹层展示「该版本 → 当前内容」的逐行差异 */
  const [diffEntry, setDiffEntry] = useState<NoteHistoryEntry | null>(null);

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

  // 属性窗在矮窗口下内容区会滚动，fixed 定位的浮层不跟着走，一滚就和按钮脱节——干脆收起
  useEffect(() => {
    if (!groupMenu.open) return;
    const close = () => setGroupMenu((m) => ({ ...m, open: false }));
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [groupMenu.open]);

  return (
    <Modal isOpen={target !== null} onClose={onClose} title={note ? t("笔记属性") : t("分组属性")}>
      <div className="rounded-xl border border-line-soft px-3.5 py-1">
        {note && (
          <>
            <Row
              label={t("标题")}
              content={
                editing?.field === "noteTitle" ? (
                  <RowInput
                    value={editing.draft}
                    onChange={(v) => setEditing({ field: "noteTitle", draft: v })}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  note.title || t("无标题")
                )
              }
              action={
                noteLocked ? undefined : (
                  <RowButton
                    icon={editing?.field === "noteTitle" ? "sidebar-check" : "sidebar-edit"}
                    title={editing?.field === "noteTitle" ? t("保存标题") : t("编辑标题")}
                    active={editing?.field === "noteTitle"}
                    onClick={() => (editing?.field === "noteTitle" ? commitEdit() : startEdit("noteTitle", note.title))}
                  />
                )
              }
            />
            <Row
              label={t("加密状态")}
              content={
                note.enc_mode === 0 ? (
                  <span className="text-muted">{t("未加密")}</span>
                ) : note.enc_mode === 2 ? (
                  <span className="text-body">
                    {t("分组加密")} · {note.is_locked ? t("已锁定") : t("已解锁")}
                    <span className="ml-1.5 text-[11px] text-faint">{t("此笔记随所属分组加密，请在分组上操作")}</span>
                  </span>
                ) : (
                  <span className={note.is_locked ? "text-warning" : "text-primary-500"}>
                    {t("单篇加密")} · {note.is_locked ? t("已锁定") : t("已解锁")}
                  </span>
                )
              }
              action={
                note.enc_mode === 0 ? (
                  <RowButton icon="security-lock" title={t("加密")} onClick={() => onEncryptNote?.(note)} />
                ) : note.enc_mode === 1 ? (
                  <div className="flex items-center gap-0.5">
                    {note.is_locked ? (
                      <RowButton icon="security-unlock" title={t("解锁")} onClick={() => onUnlockNote?.(note)} />
                    ) : (
                      <RowButton icon="security-lock" title={t("锁定")} onClick={() => onLockNote?.(note)} />
                    )}
                    <RowButton icon="security-unlock" title={t("永久解密")} onClick={() => onDecryptNote?.(note)} />
                  </div>
                ) : undefined
              }
            />
            {note.enc_mode !== 0 && (
              <Row
                label={t("根密码恢复")}
                content={
                  rootWrapped === false ? (
                    <span className="text-warning">{t("无法用根密码恢复（早期数据）")}</span>
                  ) : rootWrapped ? (
                    <span className="text-muted">{t("忘记条目密码时可用根密码解密")}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )
                }
              />
            )}
            {note.enc_mode !== 0 && note.enc_hint && (
              <Row label={t("密码提示")} content={<span className="text-muted">{note.enc_hint}</span>} />
            )}
            <Row
              label={t("所属分组")}
              content={categoryName}
              action={
                note.enc_mode === 0 ? (
                  <RowButton icon="sidebar-edit" title={t("移动到其他分组")} onClick={openGroupMenu} />
                ) : undefined
              }
            />
            <div className="py-2 border-b border-line-soft min-h-[38px]">
              <div className="flex items-start gap-3">
                <span className="w-[92px] flex-shrink-0 text-xs text-faint mt-1">{t("标签")}</span>
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
                  {tags.length === 0 && !addingTag && (
                    <span className="text-[13px] text-muted leading-5">
                      {note.enc_mode !== 0 && note.is_locked ? t("标签随笔记加密") : t("暂无标签")}
                    </span>
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
                      placeholder={t("标签名，可一次输入多个")}
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
                        title={t("添加标签")}
                        onClick={() => setAddingTag(true)}
                        className="inline-flex items-center gap-0.5 px-1.5 h-[24px] rounded-md text-[12px] text-faint-soft hover:text-primary-500 hover:bg-primary-50 transition-colors"
                      >
                        <Icon name="sidebar-plus" className="w-3 h-3" />
                        <span>{t("标签")}</span>
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
            <Row
              label={t("收藏状态")}
              content={<span className={note.is_pinned ? "text-primary-500" : "text-muted"}>{note.is_pinned ? t("已收藏") : t("未收藏")}</span>}
              action={
                <RowButton
                  icon={note.is_pinned ? "sidebar-star-filled" : "sidebar-star"}
                  title={note.is_pinned ? t("取消收藏") : t("收藏")}
                  active={note.is_pinned}
                  onClick={() => void onTogglePin(note)}
                />
              }
            />
            {/* 关闭 AI 能力时整行不显示：那时 AI 不存在，权限设置没有意义；加密内容对 AI 恒为禁止 */}
            {enableAI && note.enc_mode === 0 && (
              <Row
                label={t("AI 访问")}
                content={
                  limitedByGroup ? (
                    <span className="text-warning">
                      {t("实际生效：{level}（受所属分组限制）", { level: t(AI_ACCESS_LABELS[effectiveNoteLevel]) })}
                    </span>
                  ) : effectiveNoteLevel === 0 ? (
                    <span className="text-danger">{t("AI 完全看不到这篇笔记")}</span>
                  ) : (
                    <span className="text-body">{t("{level}访问", { level: t(AI_ACCESS_LABELS[effectiveNoteLevel]) })}</span>
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
            <Row
              label={t("字数")}
              content={noteLocked ? "—" : t(wordCount === 1 ? "1 字" : "{count} 字", { count: wordCount.toLocaleString(locale) })}
            />
            <Row label={t("创建时间")} content={formatDateTime(note.created_at, locale)} />
            <Row label={t("更新时间")} content={formatDateTime(note.updated_at, locale)} />
            <Row label={t("编号")} content={note.id} />
          </>
        )}
        {category && (
          <>
            <Row
              label={t("名称")}
              content={
                editing?.field === "categoryName" ? (
                  <RowInput
                    value={editing.draft}
                    onChange={(v) => setEditing({ field: "categoryName", draft: v })}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  category.name || t("未命名分组")
                )
              }
              action={
                <RowButton
                  icon={editing?.field === "categoryName" ? "sidebar-check" : "sidebar-edit"}
                  title={editing?.field === "categoryName" ? t("保存名称") : t("编辑名称")}
                  active={editing?.field === "categoryName"}
                  onClick={() => (editing?.field === "categoryName" ? commitEdit() : startEdit("categoryName", category.name))}
                />
              }
            />
            <Row
              label={t("加密状态")}
              content={
                !category.is_encrypted ? (
                  <span className="text-muted">{t("未加密")}</span>
                ) : (
                  <span className={category.is_locked ? "text-warning" : "text-primary-500"}>
                    {t("分组加密")} · {category.is_locked ? t("已锁定") : t("已解锁")}
                  </span>
                )
              }
              action={
                !category.is_encrypted ? (
                  <RowButton icon="security-lock" title={t("加密")} onClick={() => onEncryptCategory?.(category)} />
                ) : (
                  <div className="flex items-center gap-0.5">
                    {category.is_locked ? (
                      <RowButton icon="security-unlock" title={t("解锁")} onClick={() => onUnlockCategory?.(category)} />
                    ) : (
                      <RowButton icon="security-lock" title={t("锁定")} onClick={() => onLockCategory?.(category)} />
                    )}
                    <RowButton icon="security-unlock" title={t("永久解密")} onClick={() => onDecryptCategory?.(category)} />
                  </div>
                )
              }
            />
            {category.is_encrypted && (
              <Row
                label={t("根密码恢复")}
                content={
                  rootWrapped === false ? (
                    <span className="text-warning">{t("无法用根密码恢复（早期数据）")}</span>
                  ) : rootWrapped ? (
                    <span className="text-muted">{t("忘记条目密码时可用根密码解密")}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )
                }
              />
            )}
            {category.is_encrypted && category.enc_hint && (
              <Row label={t("密码提示")} content={<span className="text-muted">{category.enc_hint}</span>} />
            )}
            <Row label={t("笔记数量")} content={t(category.note_count === 1 ? "1 篇" : "{count} 篇", { count: category.note_count.toLocaleString(locale) })} />
            {enableAI && !category.is_encrypted && (
              <Row
                label={t("AI 访问")}
                content={
                  category.ai_access === 0 ? (
                    <span className="text-danger">{t("组内笔记全部对 AI 不可见")}</span>
                  ) : (
                    <span className="text-body">
                      {t("组内笔记上限：{level}", { level: t(AI_ACCESS_LABELS[category.ai_access]) })}
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
            <Row label={t("创建时间")} content={formatDateTime(category.created_at, locale)} />
            <Row label={t("编号")} content={category.id} />
          </>
        )}
        {virtualGroup && (
          <>
            <Row label={t("名称")} content={t(virtualGroup.name)} />
            <Row label={t("笔记数量")} content={t(virtualGroup.noteCount === 1 ? "1 篇" : "{count} 篇", { count: virtualGroup.noteCount.toLocaleString(locale) })} />
            <Row label={t("编号")} content={t("此分组为默认分组")} />
          </>
        )}
      </div>

      {/* 历史版本：每次保存前记录旧版本，回滚会覆盖当前正文，所以点一次先出「确认」 */}
      {note && (
        <div className="mt-3 rounded-xl border border-line-soft px-3.5 py-2">
          <div className="flex items-center justify-between gap-2 py-1">
            <span className="text-xs font-medium text-body">{t("历史版本")}</span>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-faint">{history.length ? t(history.length === 1 ? "1 个版本" : "{count} 个版本", { count: history.length }) : t("暂无")}</span>
              {onCreateHistoryVersion && !noteLocked && (
                <button
                  type="button"
                  title={t("把当前内容存为一个手动版本，不会被自动清理")}
                  onClick={() => {
                    setConfirmRollbackId(null);
                    setConfirmDeleteId(null);
                    setConfirmClear(false);
                    void onCreateHistoryVersion();
                  }}
                  className="px-2 py-0.5 text-[11px] rounded-md border border-line text-body hover:bg-surface-alt transition-colors"
                >
                  {t("存版本")}
                </button>
              )}
              {history.length > 0 && onClearHistory && !noteLocked && (
                confirmClear ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmClear(false);
                        void onClearHistory();
                      }}
                      className="px-2 py-0.5 text-[11px] rounded-md text-danger bg-danger-soft hover:opacity-80 transition-opacity"
                    >
                      {t("确认清空")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClear(false)}
                      className="px-2 py-0.5 text-[11px] rounded-md text-faint hover:bg-surface-alt transition-colors"
                    >
                      {t("取消")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmRollbackId(null);
                      setConfirmDeleteId(null);
                      setConfirmClear(true);
                    }}
                    className="px-2 py-0.5 text-[11px] rounded-md text-faint hover:bg-danger-soft hover:text-danger transition-colors"
                  >
                    {t("清空")}
                  </button>
                )
              )}
            </div>
          </div>
          {history.length === 0 ? (
            <p className="pb-2 text-[11px] text-faint leading-relaxed">
              {noteLocked
                ? t("解锁后可查看历史版本")
                : t("编辑并保存后，系统会按设定的间隔自动记录旧版本；最早的一版会一直保留。点「存版本」可随时手动留存，固定或手动的版本不会被自动清理。")}
            </p>
          ) : (
            <div className="max-h-[200px] overflow-y-auto -mx-1">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 px-1 py-1.5 rounded-md hover:bg-surface-alt transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-body truncate">{entry.title || t("无标题")}</div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                      <span>
                        {formatDateTime(entry.saved_at, locale)} · {t(entry.content.length === 1 ? "1 字" : "{count} 字", { count: entry.content.length.toLocaleString(locale) })}
                      </span>
                      {HISTORY_KIND_LABELS[entry.kind] && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] leading-none bg-surface-alt text-faint">
                          {t(HISTORY_KIND_LABELS[entry.kind])}
                        </span>
                      )}
                      {entry.pinned && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] leading-none bg-primary-50 text-primary-500">
                          {t("固定")}
                        </span>
                      )}
                    </div>
                  </div>
                  {confirmRollbackId === entry.id ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmRollbackId(null);
                          void onRollbackHistory?.(entry);
                        }}
                        title={t("恢复此版本，并删除它及之后的所有历史版本")}
                        className="px-2 py-1 text-[11px] rounded-md text-danger bg-danger-soft hover:opacity-80 transition-opacity"
                      >
                        {t("确认回滚")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRollbackId(null)}
                        className="px-2 py-1 text-[11px] rounded-md text-faint hover:bg-surface-alt transition-colors"
                      >
                        {t("取消")}
                      </button>
                    </div>
                  ) : confirmDeleteId === entry.id ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteId(null);
                          void onDeleteHistory?.(entry);
                        }}
                        className="px-2 py-1 text-[11px] rounded-md text-danger bg-danger-soft hover:opacity-80 transition-opacity"
                      >
                        {t("确认删除")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1 text-[11px] rounded-md text-faint hover:bg-surface-alt transition-colors"
                      >
                        {t("取消")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {onToggleHistoryPinned && (
                        <RowButton
                          icon={entry.pinned ? "sidebar-star-filled" : "sidebar-star"}
                          title={t(historyPinTitle(entry))}
                          active={entry.pinned}
                          onClick={() => {
                            setConfirmRollbackId(null);
                            setConfirmDeleteId(null);
                            setConfirmClear(false);
                            void onToggleHistoryPinned(entry);
                          }}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmRollbackId(null);
                          setConfirmDeleteId(null);
                          setConfirmClear(false);
                          setDiffEntry(entry);
                        }}
                        className="px-2 py-1 text-[11px] rounded-md border border-line text-body hover:bg-surface-alt transition-colors"
                      >
                        {t("对比")}
                      </button>
                      {onPreviewHistory && (
                        <button
                          type="button"
                          onClick={() => onPreviewHistory(entry)}
                          className="px-2 py-1 text-[11px] rounded-md border border-line text-body hover:bg-surface-alt transition-colors"
                        >
                          {t("预览")}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={!onRollbackHistory}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          setConfirmClear(false);
                          setConfirmRollbackId(entry.id);
                        }}
                        className="px-2 py-1 text-[11px] rounded-md border border-line text-body hover:bg-surface-alt disabled:opacity-40 transition-colors"
                      >
                        {t("回滚")}
                      </button>
                      {onDeleteHistory && (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRollbackId(null);
                            setConfirmClear(false);
                            setConfirmDeleteId(entry.id);
                          }}
                          className="px-2 py-1 text-[11px] rounded-md text-faint hover:bg-danger-soft hover:text-danger transition-colors"
                        >
                          {t("删除")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
              <span>{t("未分类")}</span>
            </button>
            {/* 加密分组不能接收明文笔记：与右键菜单的移动列表保持一致 */}
            {categories.filter((c) => !c.is_encrypted).map((c) => (
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

      {/* 版本对比：叠在属性窗之上，关掉后回到历史列表 */}
      <HistoryDiffModal
        isOpen={diffEntry != null}
        onClose={() => setDiffEntry(null)}
        entry={diffEntry}
        currentContent={note?.content ?? ""}
      />
    </Modal>
  );
};
