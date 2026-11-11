/*
 * 恢复选项弹窗：先预检、再勾选、最后才写库。
 *
 * 过去恢复是「选文件 → 二次确认 → 整库覆盖」，用户没有任何选择权，
 * 有加密内容时还会被直接拒绝。现在拆成三步：
 *   1. 预检只读扫一遍，把「备份里有什么、和本地冲突几条」摆出来；
 *   2. 用户勾分区 / 分组 / 单篇笔记 / 冲突策略（即 `import_*_selected` 的入参）；
 *   3. 确认后才写库，而且是**合并**语义——本地多出来的内容一条都不会被删。
 *
 * JSON 与 SQLite 走同一份 UI：后端把快照读成与 JSON 备份同构的数据，
 * 两种格式的选择语义完全一致，这里只需要换一下命令名。
 *
 * 加密笔记的解锁也在这里处理：备份带着根密码材料时，让用户输一次原设备根密码，
 * 验过就把 keyring 采纳进本机，恢复完直接能读。
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  importBackupRootKey,
  importBackupSelected,
  importSqliteSelected,
  migrateBackupRootWrap,
  preflightBackup,
  preflightSqliteBackup,
  verifyBackupRootPassword,
} from "@/api/note/backup";
import { Icon } from "@/components/common/Icon";
import { Modal } from "@/components/common/Modal";
import { useI18n } from "@/i18n";
import {
  UNGROUPED_CATEGORY_KEY,
  type BackupGroupInfo,
  type BackupNoteInfo,
  type BackupPreflight,
  type BackupSelection,
  type BackupSummary,
} from "@/interface/settings/backup";

import { Switch } from "./controls";
import { errorText } from "@/lib/app/errorText";
import { backendErrorCode } from "@/lib/app/backendError";

/** 分区开关的展示顺序与文案键；`key` 对应 BackupSelection 里的字段 */
const SECTIONS = [
  { key: "notes", label: "笔记", desc: "正文、标题、分组归属与回收站状态" },
  { key: "categories", label: "分组", desc: "分组名称与 AI 访问设置" },
  { key: "tags", label: "标签", desc: "标签本体与笔记上的标记" },
  { key: "history", label: "历史版本", desc: "每篇笔记的自动与手动快照" },
  { key: "attachments", label: "图片", desc: "正文引用的附件（按内容去重）" },
  { key: "providers", label: "AI 服务商", desc: "模型配置；Key 默认不外带" },
  { key: "sessions", label: "AI 对话", desc: "会话与消息记录" },
  { key: "settings", label: "设置", desc: "编辑器、主题等偏好（不含根密码）" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

const allSectionsOn = (): Record<SectionKey, boolean> =>
  SECTIONS.reduce(
    (acc, s) => ({ ...acc, [s.key]: true }),
    {} as Record<SectionKey, boolean>,
  );

/** 笔记列表一次渲染多少条：几千条全铺出来会卡，搜索仍覆盖全集 */
const NOTE_RENDER_LIMIT = 300;

export interface RestoreDialogProps {
  isOpen: boolean;
  /** 选中的备份路径；为 null 时不渲染 */
  path: string | null;
  /** 备份格式：决定预检与恢复走哪条命令 */
  format: "json" | "sqlite";
  onClose: () => void;
  /** 恢复成功：把摘要与「是否采纳了根密码」交给调用方决定提示与刷新 */
  onDone: (summary: BackupSummary, rootAdopted: boolean) => void;
}

export const RestoreDialog: React.FC<RestoreDialogProps> = ({
  isOpen,
  path,
  format,
  onClose,
  onDone,
}) => {
  const { t, locale } = useI18n();

  const [preflight, setPreflight] = useState<BackupPreflight | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const [sections, setSections] = useState<Record<SectionKey, boolean>>(allSectionsOn);
  const [keepLocal, setKeepLocal] = useState(false);
  /** 勾选的分组 id；等于全部分组时提交空数组（空 = 全部，避免分组列表变动后漏项） */
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [groupsOpen, setGroupsOpen] = useState(false);

  /** 笔记白名单开关：关掉 = 不限制（按分组范围走） */
  const [noteMode, setNoteMode] = useState(false);
  const [pickedNoteIds, setPickedNoteIds] = useState<string[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteQuery, setNoteQuery] = useState("");

  const [rootPassword, setRootPassword] = useState("");
  const [allowReplaceRoot, setAllowReplaceRoot] = useState(false);
  /** 已有本机根密码时：把密钥迁移到本机根密码（默认开，比重置安全） */
  const [migrateRoot, setMigrateRoot] = useState(true);
  const [localRootPassword, setLocalRootPassword] = useState("");
  const [rootError, setRootError] = useState("");

  // 每次打开都重新预检：同一路径的备份可能在两次打开之间被覆盖
  useEffect(() => {
    if (!isOpen || !path) return;
    let cancelled = false;
    const load = format === "sqlite" ? preflightSqliteBackup : preflightBackup;
    setLoading(true);
    setLoadError("");
    setPreflight(null);
    setSections(allSectionsOn());
    setKeepLocal(false);
    setGroupIds([]);
    setGroupsOpen(false);
    setNoteMode(false);
    setPickedNoteIds([]);
    setNotesOpen(false);
    setNoteQuery("");
    setRootPassword("");
    setAllowReplaceRoot(false);
    setMigrateRoot(true);
    setLocalRootPassword("");
    setRootError("");
    void load(path)
      .then((data) => {
        if (cancelled) return;
        setPreflight(data);
        // 默认全选分组（空数组 = 全部），用户取消勾选时才变成白名单
        setGroupIds(data.groups.map((g) => g.id));
        // 笔记白名单默认也全选：用户打开开关后一般只是取消几条
        setPickedNoteIds(data.noteList.map((n) => n.id));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, path, format]);

  const allGroups = preflight?.groups ?? [];
  const allNotes = preflight?.noteList ?? [];
  const allGroupsSelected =
    allGroups.length > 0 && allGroups.every((g) => groupIds.includes(g.id));

  /** 分组勾选范围内的笔记：笔记列表跟着分组走，别让用户选到范围外的条目 */
  const notesInScope = useMemo(() => {
    if (allGroupsSelected) return allNotes;
    return allNotes.filter((n) =>
      groupIds.includes(n.categoryId ?? UNGROUPED_CATEGORY_KEY),
    );
  }, [allNotes, allGroupsSelected, groupIds]);

  /** 搜索过滤后的可见列表 */
  const visibleNotes = useMemo(() => {
    const q = noteQuery.trim().toLowerCase();
    const list = q
      ? notesInScope.filter(
          (n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q),
        )
      : notesInScope;
    return list.slice(0, NOTE_RENDER_LIMIT);
  }, [notesInScope, noteQuery]);

  /** 勾选范围内会带回来多少篇笔记：让用户在点确认前就看到真实数量 */
  const scopedNotes = useMemo(() => {
    if (!preflight) return 0;
    if (!sections.notes) return 0;
    if (noteMode) return pickedNoteIds.length;
    if (allGroupsSelected || allGroups.length === 0) return preflight.notes;
    return allGroups
      .filter((g) => groupIds.includes(g.id))
      .reduce((sum, g) => sum + g.notes, 0);
  }, [
    preflight,
    sections.notes,
    noteMode,
    pickedNoteIds,
    allGroups,
    allGroupsSelected,
    groupIds,
  ]);

  const anySection = SECTIONS.some((s) => sections[s.key]);
  /** 开了笔记白名单却一条没选：提交会被误解成「全部」，直接挡住 */
  const notePickedEmpty = noteMode && sections.notes && pickedNoteIds.length === 0;

  /** 需不需要让用户输原设备根密码：备份里有加密笔记且带着根密码材料 */
  const needsRootPassword =
    (preflight?.encryptedNotes ?? 0) > 0 && (preflight?.hasRootKey ?? false);

  const toggleGroup = (id: string) => {
    setGroupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleAllGroups = () => {
    setGroupIds(allGroupsSelected ? [] : allGroups.map((g) => g.id));
  };

  const toggleNote = (id: string) => {
    setPickedNoteIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const buildSelection = (): BackupSelection => ({
    ...sections,
    keepLocal,
    // 全选时提交空数组：语义是「不限分组」，比逐个列 id 更稳
    categoryIds: allGroupsSelected ? [] : groupIds,
    noteIds: noteMode ? pickedNoteIds : [],
  });

  const handleSubmit = async () => {
    if (!path || !preflight) return;
    setRunning(true);
    setRootError("");
    try {
      const hasPassword = rootPassword.trim().length > 0;
      // 先验密码（只算不写）：错的密码绝不能进入「采纳 keyring」那一步
      if (hasPassword && needsRootPassword) {
        try {
          await verifyBackupRootPassword(path, rootPassword);
        } catch (e) {
          setRootError(
            backendErrorCode(e) === "root_bad_password"
              ? t("原设备根密码不正确")
              : errorText(e),
          );
          setRunning(false);
          return;
        }
      }

      const selection = buildSelection();
      const summary =
        format === "sqlite"
          ? await importSqliteSelected(path, selection)
          : await importBackupSelected(path, selection);

      /*
       * 数据（含密文与 encrypted_keys）已入库，接下来处理「根密码这一层」。
       * 三种走法，按安全性从高到低：
       *   1. 迁移：原设备密码解开 wrap_root → 用本机 KEK 重包（推荐）
       *   2. 替换：把本机根密码直接换成备份里那份（会让本机原有加密笔记打不开）
       *   3. 什么都不做：数据在、但根密码解不开，只能逐篇用单元密码
       */
      let rootAdopted = false;
      if (hasPassword && needsRootPassword) {
        try {
          if (!preflight.localRootSet) {
            // 本机还没有根密码：直接采纳备份的 keyring
            await importBackupRootKey(path, rootPassword, false);
            rootAdopted = true;
          } else if (allowReplaceRoot) {
            await importBackupRootKey(path, rootPassword, true);
            rootAdopted = true;
          } else if (migrateRoot) {
            if (!localRootPassword.trim()) {
              setRootError(t("要迁移密钥，请填写本机当前的根密码"));
            } else {
              await migrateBackupRootWrap(path, rootPassword, localRootPassword);
              rootAdopted = true;
            }
          }
        } catch (e) {
          const code = backendErrorCode(e);
          if (code === "root_already_set") {
            setRootError(t("本机已有根密码，需要勾选「替换本机根密码」才能采纳备份的密钥"));
          } else if (code === "root_bad_password") {
            setRootError(t("本机根密码不正确，密钥未迁移（数据已恢复，仍可用各笔记自己的密码打开）"));
          } else {
            setRootError(errorText(e));
          }
        }
      }

      onDone(summary, rootAdopted);
    } catch (e) {
      setRootError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  if (!isOpen) return null;

  const summaryRow = (label: string, value: number) => (
    <div
      key={label}
      className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-surface-alt border border-line-soft"
    >
      <span className="text-[11px] text-faint">{label}</span>
      <span
        className={`text-[11px] font-mono tabular-nums ${
          value > 0 ? "text-body" : "text-faint"
        }`}
      >
        {value}
      </span>
    </div>
  );

  const groupRow = (g: BackupGroupInfo) => {
    const checked = groupIds.includes(g.id);
    return (
      <label
        key={g.id}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-alt cursor-pointer"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggleGroup(g.id)}
          className="accent-primary-500 w-3.5 h-3.5 flex-shrink-0"
        />
        <span className="text-[11px] text-body truncate min-w-0 flex-1">
          {g.id === UNGROUPED_CATEGORY_KEY ? t("未分组") : g.name || g.id}
        </span>
        {g.encrypted && (
          <Icon name="ai-shield-check" className="w-3 h-3 text-faint flex-shrink-0" />
        )}
        <span className="text-[10px] text-faint tabular-nums flex-shrink-0">
          {t("{count} 篇", { count: g.notes })}
        </span>
      </label>
    );
  };

  const noteRow = (n: BackupNoteInfo) => {
    const checked = pickedNoteIds.includes(n.id);
    return (
      <label
        key={n.id}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-alt cursor-pointer"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggleNote(n.id)}
          className="accent-primary-500 w-3.5 h-3.5 flex-shrink-0"
        />
        <span className="text-[11px] text-body truncate min-w-0 flex-1" title={n.title}>
          {n.title || t("无标题")}
        </span>
        {n.encrypted && (
          <Icon name="security-lock" className="w-3 h-3 text-faint flex-shrink-0" />
        )}
        {n.conflict && (
          <span className="text-[10px] text-warning flex-shrink-0" title={t("本地已有同一条")}>
            {t("已存在")}
          </span>
        )}
      </label>
    );
  };

  /*
   * 挂到 body：这个弹窗是在「设置」浮窗内部渲染的，而设置浮窗自带 transform 与滚动容器，
   * 留在里面会被裁切、层级也压不过它。portal 出去之后才是真正的全屏模态。
   */
  return createPortal(
    <Modal isOpen onClose={onClose} title={t("选择要恢复的内容")} size="lg" zIndex={200}>
      <div className="space-y-3">
        {loading && (
          <p className="text-[11px] text-faint py-6 text-center">
            {t("正在读取备份清单…")}
          </p>
        )}

        {!loading && loadError && (
          <div className="bg-danger-soft border border-line rounded-xl px-3 py-2 text-[11px] text-danger-strong break-all">
            {t("读取备份失败：{value1}", { value1: loadError })}
          </div>
        )}

        {!loading && !loadError && preflight && (
          <>
            {/* 摘要：备份是什么时候的、里面有什么 */}
            <div className="bg-surface-alt border border-line rounded-xl px-3 py-2">
              <p className="text-[11px] text-body">
                {t("备份导出于 {value1}", {
                  value1: preflight.exportedAt
                    ? new Date(preflight.exportedAt).toLocaleString(locale)
                    : t("未知时间"),
                })}
              </p>
              <p className="text-[10px] text-faint mt-0.5">
                {t("格式 v{value1}", { value1: preflight.version })}
                {preflight.conflictsNotes > 0
                  ? ` · ${t("与本地重复 {count} 篇", { count: preflight.conflictsNotes })}`
                  : ""}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {summaryRow(t("笔记"), preflight.notes)}
              {summaryRow(t("分组"), preflight.categories)}
              {summaryRow(t("历史版本"), preflight.history)}
              {summaryRow(t("标签"), preflight.tags)}
              {summaryRow(t("图片"), preflight.attachments)}
              {summaryRow(t("AI 对话"), preflight.sessions)}
            </div>

            {/* 分区勾选 */}
            <div>
              <p className="text-[11px] text-muted pb-1.5">{t("恢复哪些内容")}</p>
              <div className="grid grid-cols-2 gap-1">
                {SECTIONS.map((s) => (
                  <div
                    key={s.key}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-app border border-line-soft"
                  >
                    <div className="min-w-0">
                      <p className="text-[11px] text-body truncate">{t(s.label)}</p>
                      <p className="text-[10px] text-faint truncate">{t(s.desc)}</p>
                    </div>
                    <Switch
                      value={sections[s.key]}
                      onChange={(v) => setSections((prev) => ({ ...prev, [s.key]: v }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* 分组勾选：只恢复某几个分组时用 */}
            {sections.notes && allGroups.length > 0 && (
              <div>
                <button
                  onClick={() => setGroupsOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-1 py-1 text-[11px] text-body hover:text-primary-500"
                >
                  <span>
                    {t("分组范围")}
                    <span className="text-faint ml-1">
                      {allGroupsSelected
                        ? t("全部分组")
                        : t("已选 {count} / {total} 个分组", {
                            count: groupIds.length,
                            total: allGroups.length,
                          })}
                    </span>
                  </span>
                  <Icon
                    name={groupsOpen ? "ai-chevron-up" : "ai-chevron-down"}
                    className="w-3.5 h-3.5 text-faint"
                  />
                </button>
                {groupsOpen && (
                  <div className="mt-1 border border-line-soft rounded-xl p-1 max-h-52 overflow-y-auto">
                    <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-alt cursor-pointer border-b border-line-soft mb-1">
                      <input
                        type="checkbox"
                        checked={allGroupsSelected}
                        onChange={toggleAllGroups}
                        className="accent-primary-500 w-3.5 h-3.5 flex-shrink-0"
                      />
                      <span className="text-[11px] text-body flex-1">{t("全选")}</span>
                      <span className="text-[10px] text-faint">
                        {t("{count} 篇", { count: preflight.notes })}
                      </span>
                    </label>
                    {allGroups.map(groupRow)}
                  </div>
                )}
              </div>
            )}

            {/* 笔记勾选：只恢复某几篇时用，支持搜索 */}
            {sections.notes && allNotes.length > 0 && (
              <div>
                <button
                  onClick={() => setNotesOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-1 py-1 text-[11px] text-body hover:text-primary-500"
                >
                  <span>
                    {t("只恢复指定的笔记")}
                    <span className="text-faint ml-1">
                      {noteMode
                        ? t("已选 {count} / {total} 篇", {
                            count: pickedNoteIds.length,
                            total: notesInScope.length,
                          })
                        : t("未启用（按上方分组范围）")}
                    </span>
                  </span>
                  <Icon
                    name={notesOpen ? "ai-chevron-up" : "ai-chevron-down"}
                    className="w-3.5 h-3.5 text-faint"
                  />
                </button>
                {notesOpen && (
                  <div className="mt-1 border border-line-soft rounded-xl p-1.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 px-0.5">
                      <span className="text-[11px] text-body">{t("逐篇挑选")}</span>
                      <Switch value={noteMode} onChange={(v) => setNoteMode(v)} />
                    </div>
                    {noteMode && (
                      <>
                        <input
                          value={noteQuery}
                          onChange={(e) => setNoteQuery(e.target.value)}
                          placeholder={t("搜索标题或 id")}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-app border border-line text-[11px] text-body outline-none focus:border-accent"
                        />
                        <div className="flex items-center justify-between px-0.5">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setPickedNoteIds(notesInScope.map((n) => n.id))}
                              className="text-[10px] text-primary-500 hover:underline"
                            >
                              {t("全选")}
                            </button>
                            <button
                              onClick={() => setPickedNoteIds([])}
                              className="text-[10px] text-faint hover:underline"
                            >
                              {t("清空")}
                            </button>
                          </div>
                          <span className="text-[10px] text-faint">
                            {t("显示 {shown} / {total} 篇", {
                              shown: visibleNotes.length,
                              total: notesInScope.length,
                            })}
                          </span>
                        </div>
                        <div className="max-h-56 overflow-y-auto">
                          {visibleNotes.length === 0 ? (
                            <p className="text-[11px] text-faint px-2 py-3 text-center">
                              {t("没有匹配的笔记")}
                            </p>
                          ) : (
                            visibleNotes.map(noteRow)
                          )}
                        </div>
                        {preflight.noteListTruncated && (
                          <p className="text-[10px] text-faint px-1 leading-relaxed">
                            {t("备份里的笔记太多，这里只列出了前 {count} 篇；要恢复更多请用分组范围。", {
                              count: allNotes.length,
                            })}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 冲突策略 */}
            <div>
              <p className="text-[11px] text-muted pb-1.5">{t("本地已有同名内容时")}</p>
              <div className="grid grid-cols-2 gap-1">
                <button
                  onClick={() => setKeepLocal(false)}
                  className={`text-left px-2.5 py-2 rounded-lg border transition-colors ${
                    keepLocal ? "border-line-soft bg-app" : "border-primary-500 bg-surface-alt"
                  }`}
                >
                  <p className="text-[11px] text-body">{t("用备份覆盖")}</p>
                  <p className="text-[10px] text-faint mt-0.5">
                    {t("同一条内容换成备份里的版本")}
                  </p>
                </button>
                <button
                  onClick={() => setKeepLocal(true)}
                  className={`text-left px-2.5 py-2 rounded-lg border transition-colors ${
                    keepLocal ? "border-primary-500 bg-surface-alt" : "border-line-soft bg-app"
                  }`}
                >
                  <p className="text-[11px] text-body">{t("保留本地版本")}</p>
                  <p className="text-[10px] text-faint mt-0.5">
                    {t("已存在的跳过，只补本地没有的")}
                  </p>
                </button>
              </div>
              <p className="text-[10px] text-faint mt-1 leading-relaxed">
                {t("无论选哪个，本地独有的内容都不会被删除。")}
              </p>
            </div>

            {/* 加密笔记解锁 */}
            {needsRootPassword && (
              <div className="bg-app border border-line rounded-xl px-3 py-2 space-y-1.5">
                <p className="text-[11px] text-body">
                  {t("备份含 {count} 篇加密笔记", { count: preflight.encryptedNotes })}
                </p>
                <p className="text-[10px] text-faint leading-relaxed">
                  {preflight.localRootSet
                    ? t("本机已有根密码，这些笔记需要原设备根密码才能查看。输入后会把本机根密码换成备份里那份。")
                    : t("输入原设备根密码即可在恢复后直接查看；留空则先以锁定状态入库，之后随时可解锁。")}
                </p>
                <input
                  type="password"
                  value={rootPassword}
                  onChange={(e) => {
                    setRootPassword(e.target.value);
                    setRootError("");
                  }}
                  placeholder={t("原设备根密码（可留空）")}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-line text-[11px] text-body outline-none focus:border-accent"
                />
                {preflight.localRootSet && rootPassword.trim() && (
                  <div className="space-y-1.5 pt-0.5">
                    <label className="flex items-start gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={migrateRoot}
                        onChange={(e) => {
                          setMigrateRoot(e.target.checked);
                          if (e.target.checked) setAllowReplaceRoot(false);
                        }}
                        className="accent-primary-500 mt-0.5 w-3.5 h-3.5 flex-shrink-0"
                      />
                      <span className="text-[10px] text-body leading-relaxed">
                        {t("把备份的加密密钥迁移到本机根密码（推荐，之后一把根密码就能全开）")}
                      </span>
                    </label>
                    {migrateRoot && (
                      <input
                        type="password"
                        value={localRootPassword}
                        onChange={(e) => {
                          setLocalRootPassword(e.target.value);
                          setRootError("");
                        }}
                        placeholder={t("本机当前的根密码")}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-line text-[11px] text-body outline-none focus:border-accent"
                      />
                    )}
                    <label className="flex items-start gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allowReplaceRoot}
                        onChange={(e) => {
                          setAllowReplaceRoot(e.target.checked);
                          if (e.target.checked) setMigrateRoot(false);
                        }}
                        className="accent-danger mt-0.5 w-3.5 h-3.5 flex-shrink-0"
                      />
                      <span className="text-[10px] text-danger-strong leading-relaxed">
                        {t("改为直接替换本机根密码（本机原有的加密笔记会因此打不开）")}
                      </span>
                    </label>
                  </div>
                )}
              </div>
            )}

            {rootError && (
              <p className="text-[11px] text-danger-strong break-all">{rootError}</p>
            )}

            {/* 结果预览 + 操作 */}
            <div className="border-t border-line-soft pt-2.5">
              <p className="text-[11px] text-faint pb-2">
                {!anySection
                  ? t("没有勾选任何内容")
                  : notePickedEmpty
                    ? t("已开启逐篇挑选，但一篇都没选中")
                    : t("将恢复 {count} 篇笔记", { count: scopedNotes })}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  disabled={running}
                  className="btn-ghost px-4 py-2 text-sm"
                >
                  {t("取消")}
                </button>
                <button
                  onClick={() => void handleSubmit()}
                  disabled={running || !anySection || notePickedEmpty}
                  className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
                >
                  {running ? t("恢复中...") : t("开始恢复")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>,
    document.body,
  );
};
