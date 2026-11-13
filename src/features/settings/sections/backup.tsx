/* 备份与恢复：JSON / SQLite / 加密容器三种整库备份，恢复时覆盖当前数据。 */

import { logAction } from "@/lib/app/actionLog";
import { useState } from "react";
import { createPortal } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { BackupSummary } from "@/interface/settings/backup";
import { t, getLocale, useI18n } from "@/i18n";
import {
  exportBackup,
  exportEncryptedBackup,
  exportSqliteBackup,
  importEncryptedBackup,
} from "@/api/note/backup";
import { BackupPassphraseDialog } from "@/components/common/EncryptionDialogs";
import { useToast } from "@/components/common/Toast";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { useActionGuard } from "@/hooks/useActionGuard";
import { flushThemeSettings } from "@/stores/themeStore";
import { WebdavPanel } from "@/components/settings/WebdavPanel";
import { RestoreDialog } from "@/features/settings/RestoreDialog";
import { Icon } from "@/components/common/Icon";
import { SegmentedInput, Switch } from "../controls";
import type { SettingsSectionContext } from "../context";
import { errorText } from "@/lib/app/errorText";

/* ---------- 备份工具函数 ---------- */

/** 备份文件名里的时间戳：20261006-1930 */
const fileStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** ISO 时间去秒，展示成 2026-10-06 19:30；缺值或非法日期显示「未知」 */
const prettyTime = (iso: string | null) => {
  if (!iso) return t("未知");
  const d = new Date(iso);
  // new Date 对非法字符串不抛错，只会得到 Invalid Date，必须显式判断
  if (Number.isNaN(d.getTime())) return t("未知");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 取路径最后一段文件名：兼容 Windows 反斜杠与 POSIX 斜杠 */
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行提示文案 */

export const BackupSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const guard = useActionGuard();

  /* 备份操作的进行中状态：非 null 时禁用导出/导入按钮，防止并发 */
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  /** 勾选式恢复的目标：JSON 与 SQLite 都走这条通道 */
  const [restoreTarget, setRestoreTarget] = useState<{
    path: string;
    format: "json" | "sqlite";
  } | null>(null);
  const [lastExport, setLastExport] = useState<{ summary: BackupSummary; path: string } | null>(null);
  /** 导出备份时是否一并写入 AI 服务商 API Key（JSON 为明文，SQLite 为本机加密值） */
  const [backupIncludeApiKey, setBackupIncludeApiKey] = useState(false);
  /** 导出备份时是否一并写入 WebDAV 配置（JSON 含明文密码，SQLite 保留本机密文） */
  const [backupIncludeWebdav, setBackupIncludeWebdav] = useState(false);
  /** SQLite 快照是否带加密内容（密文 + 密钥 + 根密码材料）；默认带上，备份要完整 */
  const [backupIncludeEncrypted, setBackupIncludeEncrypted] = useState(true);
  /**
 * 备份格式：JSON 适合换机迁移，SQLite 是整库快照、适合本机快速备份，
 * 加密备份（.fnbak）在整库快照外再套一层独立备份口令，连加密笔记一起带走。
 */
  const [backupFormat, setBackupFormat] = useState<"json" | "sqlite" | "encrypted">("json");
  /** 加密备份的口令弹窗：选完文件/确认覆盖后才弹，取消则整个操作作废 */
  const [backupPassphrase, setBackupPassphrase] = useState<{
    mode: "export" | "import";
    path: string;
  } | null>(null);

  /** 导出：先让用户选保存路径（取消则返回），再交给后端写文件；失败只弹提示 */
  const handleExport = async () => {
    const isSqlite = backupFormat === "sqlite";
    const isEncrypted = backupFormat === "encrypted";
    try {
      const path = await save({
        defaultPath: `fastnote-backup-${fileStamp()}.${isEncrypted ? "fnbak" : isSqlite ? "db" : "json"}`,
        filters: [
          isEncrypted
            ? { name: t("FastNote 加密备份"), extensions: ["fnbak"] }
            : isSqlite
              ? { name: t("SQLite 数据库备份"), extensions: ["db", "sqlite"] }
              : { name: t("FastNote 备份"), extensions: ["json"] },
        ],
      });
      if (!path) return;
      // 加密备份还要口令：先记下路径，等弹窗确认后再真正写文件
      if (isEncrypted) {
        setBackupPassphrase({ mode: "export", path });
        return;
      }
      // 主题落库有防抖：导出前把最后一次改动冲下去，避免备份里少了刚改的主题
      await flushThemeSettings();
      setBackupBusy("export");
      const summary = isSqlite
        ? await exportSqliteBackup(
            path,
            backupIncludeApiKey,
            backupIncludeWebdav,
            backupIncludeEncrypted,
          )
        : await exportBackup(path, backupIncludeApiKey, backupIncludeWebdav);
      setLastExport({ summary, path });
      logAction("backup.export", `${isSqlite ? "sqlite" : "json"} · ${summary.notes} notes`);
      const extras = [
        backupIncludeApiKey ? (isSqlite ? t("本机加密 Key") : "API Key") : "",
        backupIncludeWebdav ? t("WebDAV 配置") : "",
      ].filter(Boolean);
      const keyNote = extras.length ? t("（含{value1}）", { value1: extras.join(getLocale() === "zh-CN" ? "、" : ", ") }) : "";
      showToast(t("已导出 {notes} 篇笔记{keyNote}", { notes: summary.notes, keyNote: keyNote }), "success");
    } catch (e) {
      showToast(t("导出失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setBackupBusy(null);
    }
  };

  /**
   * 加密备份：口令由弹窗收集，这里只负责调用后端。
   * 失败直接抛出，让弹窗原地显示错误（口令错要能重试），不再额外弹 toast。
   */
  const runEncryptedExport = async (passphrase: string) => {
    const path = backupPassphrase?.path;
    if (!path) return;
    // 主题落库有防抖：导出前把最后一次改动冲下去
    await flushThemeSettings();
    setBackupBusy("export");
    try {
      const summary = await exportEncryptedBackup(path, passphrase);
      setLastExport({ summary, path });
      logAction("backup.export_encrypted", `${summary.notes} notes`);
      showToast(t("已导出加密备份：{notes} 篇笔记（含加密笔记与密钥元数据）", { notes: summary.notes }), "success");
    } finally {
      setBackupBusy(null);
    }
  };

  /**
   * 导入：覆盖式恢复，必须先二次确认（数据不可撤销）；
   * 成功后延迟 800ms 再整页 reload，一是让提示能被看到，二是让各 store 重新从库里读。
   */
  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          // gz：WebDAV / 自动备份写的是压缩后的 .gz，从云端「另存为本地副本」后要能选回来
          { name: t("FastNote 备份"), extensions: ["json", "gz", "db", "sqlite", "fnbak"] },
        ],
      });
      if (!selected || typeof selected !== "string") return;

      const lower = selected.toLowerCase();
      const isEncrypted = lower.endsWith(".fnbak");
      const isSqlite = lower.endsWith(".db") || lower.endsWith(".sqlite");

      /*
       * JSON 与 SQLite 都走「先预检、再勾选」的合并恢复：不会清库、不会删本地独有内容，
       * 所以这里不做「覆盖当前全部数据」的二次确认，确认交给恢复弹窗里的结果预览。
       * 主题有防抖写入，先冲掉旧改动，免得恢复完又被内存里的旧值回写。
       */
      if (!isEncrypted) {
        await flushThemeSettings();
        setRestoreTarget({ path: selected, format: isSqlite ? "sqlite" : "json" });
        return;
      }

      // 加密容器（.fnbak）仍是整库替换：它是密文包，必须先有口令才能读
      const ok = await confirm({
        title: t("从备份恢复"),
        message: t("恢复会用{formatLabel}备份覆盖当前的**全部**笔记、分组、回收站、AI 对话记录与设置。当前数据将被清空，无法撤销，建议先导出一份备份。\n\n备份文件：{value2}", { formatLabel: t("加密容器"), value2: baseName(selected) }),
        confirmText: t("覆盖并恢复"),
        danger: true,
      });
      if (!ok) return;

      // 加密备份覆盖前先问口令：口令错就原地重试，不会碰到现有数据
      setBackupPassphrase({ mode: "import", path: selected });
    } catch (e) {
      setBackupBusy(null);
      showToast(t("恢复失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  /** 加密备份恢复：口令由弹窗收集；失败抛出给弹窗显示，成功后才整页刷新 */
  const runEncryptedImport = async (passphrase: string) => {
    const path = backupPassphrase?.path;
    if (!path) return;
    await flushThemeSettings();
    setBackupBusy("import");
    try {
      const summary = await importEncryptedBackup(path, passphrase);
      showToast(t("恢复完成：{notes} 篇笔记，界面即将刷新", { notes: summary.notes }), "success");
      setTimeout(() => window.location.reload(), 800);
    } finally {
      setBackupBusy(null);
    }
  };

  return (
    <>
      <div className="space-y-3">
        <p className="text-[11px] text-faint leading-relaxed">{t("备份包含笔记、分组、回收站、标签、历史版本、AI 对话与设置；语义索引与模型文件不在备份内，需重建。")}</p>

        {/* 格式选择：JSON 带字段级兼容，SQLite 是整库快照，加密备份再套一层口令 */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
          <div className="min-w-0 flex-1 basis-[220px]">
            <span className="text-xs font-medium text-body">{t("备份格式")}</span>
            <p className="text-[11px] text-faint leading-relaxed mt-1">
              {backupFormat === "sqlite"
                ? t("整库快照（.db），恢复更快，适合本机定期备份。")
                : backupFormat === "encrypted"
                  ? t("整库快照再用独立口令加密（.fnbak），恢复时需输入备份口令。")
                  : t("带字段级兼容，可跨版本恢复，适合换机迁移。")}
            </p>
          </div>
          <SegmentedInput
            value={backupFormat}
            options={[
              { value: "json", label: "JSON" },
              { value: "sqlite", label: "SQLite" },
              { value: "encrypted", label: "加密备份" },
            ]}
            onChange={(v) =>
              setBackupFormat(
                v === "sqlite" || v === "encrypted" ? v : "json",
              )
            }
          />
        </div>

        {/* 加密备份是整库打包：两个开关不适用，改为说明一行 */}
        {backupFormat === "encrypted" && (
          <div className="px-3 py-2.5 rounded-xl bg-app border border-line-soft">
            <p className="text-[11px] text-faint leading-relaxed">
              {t("加密备份始终包含整库内容，由备份口令保护，无需勾选下方选项。")}
            </p>
          </div>
        )}

        {/* API Key 默认不备份，避免密钥被误带到网盘 */}
        {backupFormat !== "encrypted" && (
        <>
        <div className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
          <div className="min-w-0">
            <span className="text-xs font-medium text-body">{t("备份 API Key")}</span>
            <p className="text-[11px] text-faint leading-relaxed mt-1">{t("备份保留 API Key（JSON 中为明文）；不勾选则只留服务商配置。自动备份始终不含 Key。")}</p>
          </div>
          <div className="max-w-full pt-0.5">
            <Switch value={backupIncludeApiKey} onChange={setBackupIncludeApiKey} />
          </div>
        </div>

        {/* SQLite 快照默认带上加密内容：不带的话换机恢复会发现加密笔记整批消失 */}
        {backupFormat === "sqlite" && (
          <div className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
            <div className="min-w-0">
              <span className="text-xs font-medium text-body">{t("备份加密内容")}</span>
              <p className="text-[11px] text-faint leading-relaxed mt-1">{t("快照带上加密笔记与密钥材料（仅密文），换机恢复需原设备根密码。")}</p>
            </div>
            <div className="max-w-full pt-0.5">
              <Switch value={backupIncludeEncrypted} onChange={setBackupIncludeEncrypted} />
            </div>
          </div>
        )}

        {/* WebDAV 配置默认同样不进备份：里面含云端账号与密码 */}
        <div className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
          <div className="min-w-0">
            <span className="text-xs font-medium text-body">{t("备份 WebDAV 配置")}</span>
            <p className="text-[11px] text-faint leading-relaxed mt-1">{t("备份带上 WebDAV 服务器、账号与密码（JSON 中为明文）。自动备份不含。")}</p>
          </div>
          <div className="max-w-full pt-0.5">
            <Switch value={backupIncludeWebdav} onChange={setBackupIncludeWebdav} />
          </div>
        </div>
        </>
        )}

        <div className="flex items-center gap-3 p-3 rounded-xl bg-app border border-line-soft">
          <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
            <Icon name="app-backup" className="w-4 h-4 text-primary-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-body">{t("导出备份")}</p>
            <p className="text-[11px] text-faint mt-0.5">
              {backupFormat === "sqlite"
                ? t("保存为一个 SQLite 数据库文件（.db），可放到 U 盘或备份目录。")
                : backupFormat === "encrypted"
                  ? t("保存为一个加密备份文件（.fnbak），需要备份口令才能打开。")
                  : t("保存为一个 JSON 文件，可放到网盘或 U 盘带走。")}
            </p>
            {lastExport && (
              <p className="text-[11px] text-success mt-1 truncate" title={lastExport.path}>{t("已导出：{value1} · {notes} 篇笔记 · {messages} 条对话消息", { value1: baseName(lastExport.path), notes: lastExport.summary.notes, messages: lastExport.summary.messages })}</p>
            )}
          </div>
          <button
            onClick={() => void guard(handleExport)}
            disabled={backupBusy !== null}
            className="btn-primary px-3 py-1.5 text-xs flex-shrink-0 disabled:opacity-50"
          >
            {backupBusy === "export" ? t("导出中...") : t("导出")}
          </button>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-xl bg-app border border-line-soft">
          <div className="w-8 h-8 rounded-lg bg-warning-soft flex items-center justify-center flex-shrink-0">
            <Icon name="app-restore" className="w-4 h-4 text-warning" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-body">{t("从备份恢复")}</p>
            <p className="text-[11px] text-faint mt-0.5">{t("支持 .json、.gz、.db 与 .fnbak。JSON / SQLite 先勾选再合并恢复，不删本地数据；.fnbak 整库覆盖。")}</p>
          </div>
          <button
            onClick={() => void guard(handleImport)}
            disabled={backupBusy !== null}
            className="px-3 py-1.5 text-xs font-medium text-warning-deep bg-warning-soft rounded-xl hover:bg-warning-line transition-colors flex-shrink-0 disabled:opacity-50"
          >
            {backupBusy === "import" ? t("恢复中...") : t("选择文件")}
          </button>
        </div>

        {lastExport?.summary.exported_at && (
          <p className="text-[11px] text-faint">{t("本次导出时间：{value1}", { value1: prettyTime(lastExport.summary.exported_at) })}</p>
        )}

        <WebdavPanel
          settings={ctx.appSettings.webdav}
          onAppSettingChange={ctx.onAppSettingChange}
          includeApiKeys={backupIncludeApiKey}
          includeWebdav={backupIncludeWebdav}
        />
      </div>

      {confirmDialog}

      {/* 恢复选项：预检清单 → 勾选分区/分组 → 合并写入；JSON 备份的唯一入口 */}
      <RestoreDialog
        isOpen={restoreTarget !== null}
        path={restoreTarget?.path ?? null}
        format={restoreTarget?.format ?? "json"}
        onClose={() => setRestoreTarget(null)}
        onDone={(summary, rootAdopted) => {
          setRestoreTarget(null);
          showToast(
            rootAdopted
              ? t("恢复完成：{notes} 篇笔记，并已用备份的根密码解锁加密笔记，界面即将刷新", {
                  notes: summary.notes,
                })
              : summary.notes > 0
                ? t("恢复完成：{notes} 篇笔记，界面即将刷新", { notes: summary.notes })
                : t("恢复完成：已按选择更新内容，界面即将刷新"),
            "success",
          );
          setTimeout(() => window.location.reload(), 800);
        }}
      />

      {/* 加密备份口令：导出/恢复共用，口令只活在这个弹窗里；挂到 body，避免被可拖动浮窗的 transform 与滚动容器裁切 */}
      {createPortal(
        <BackupPassphraseDialog
          isOpen={backupPassphrase !== null}
          mode={backupPassphrase?.mode ?? "export"}
          onClose={() => setBackupPassphrase(null)}
          onSubmit={
            backupPassphrase?.mode === "import" ? runEncryptedImport : runEncryptedExport
          }
        />,
        document.body,
      )}
    </>
  );
};
