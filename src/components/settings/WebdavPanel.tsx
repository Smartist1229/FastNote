/**
 * 设置 · 备份与恢复 · WebDAV 云同步。
 *
 * 三块能力：
 * - 连接配置：服务器 / 账号 / 密码 / 云端文件夹，密码单独加密入库；
 * - 自动备份：本地 / 云端 / 两者，间隔与本地保留份数存在 app.config.webdav.*，
 *   真正的定时任务在 Rust 后端（只生成 JSON、永不含 API Key）；
 * - 手动备份与恢复：上传当前数据到云端，以及从云端 / 本地备份目录列表中选择恢复。
 *
 * 恢复是覆盖式的：先 flush 主题的防抖写入，成功后延迟 reload，让各 store 重新读库。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as webdavApi from "@/api/webdav";
import type { BackupFileEntry } from "@/api/webdav";
import { openAppFolder } from "@/api/system";
import type { AutoBackupTarget, WebdavSettings } from "@/interface/settings";
import { DEFAULT_WEBDAV_SETTINGS } from "@/config/appDefaults";
import { Icon } from "@/components/common/Icon";
import { useToast } from "@/components/common/Toast";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { useActionGuard } from "@/hooks/useActionGuard";
import { flushThemeSettings } from "@/stores/themeStore";
import { formatBytes } from "@/lib/format";

const errorText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

/** ISO 时间去秒，展示成 2026-10-06 19:30；缺值或非法日期显示「未知」 */
const prettyTime = (iso: string | null) => {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 数值输入：输入过程中不夹取，失焦 / 回车时收敛到 [min, max] */
const NumberField: React.FC<{
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}> = ({ value, min, max, unit, onChange }) => {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const next = Number(text);
    if (!Number.isFinite(next)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(next)));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={1}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-16 px-2 py-1 text-right text-xs input-modern bg-app/60 transition-colors focus:bg-surface"
      />
      <span className="w-6 text-[11px] text-faint">{unit}</span>
    </div>
  );
};

/** 开关：与设置弹窗里的 Switch 同一套外观 */
const Toggle: React.FC<{ value: boolean; onChange: (value: boolean) => void }> = ({
  value,
  onChange,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={value}
    onClick={() => onChange(!value)}
    className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors relative ${
      value ? "bg-primary-500" : "bg-surface-strong"
    }`}
  >
    <span
      className={`absolute top-0.5 w-4 h-4 rounded-full bg-surface shadow transition-all ${
        value ? "left-[18px]" : "left-0.5"
      }`}
    />
  </button>
);

const TARGET_OPTIONS: { value: AutoBackupTarget; label: string }[] = [
  { value: "local", label: "仅本地" },
  { value: "cloud", label: "仅云端" },
  { value: "both", label: "云端 + 本地" },
];

/** 备份条目：文件名 + 大小 + 时间 + 恢复按钮 */
const BackupRow: React.FC<{
  entry: BackupFileEntry;
  busy: boolean;
  onRestore: () => void;
}> = ({ entry, busy, onRestore }) => (
  <div className="flex items-center gap-3 border-b border-line-soft px-3.5 py-2 last:border-0">
    <Icon name="app-backup" className="h-3.5 w-3.5 flex-shrink-0 text-faint-soft" />
    <div className="min-w-0 flex-1">
      <p className="truncate text-[12px] text-body" title={entry.name}>
        {entry.name}
      </p>
      <p className="text-[10px] text-faint">
        {prettyTime(entry.modified)}
        {entry.size > 0 ? ` · ${formatBytes(entry.size)}` : ""}
      </p>
    </div>
    <button
      type="button"
      onClick={onRestore}
      disabled={busy}
      className="flex-shrink-0 rounded-lg bg-warning-soft px-2.5 py-1 text-[11px] font-medium text-warning-deep transition-colors hover:bg-warning-line disabled:opacity-40"
    >
      恢复
    </button>
  </div>
);

interface WebdavPanelProps {
  settings: WebdavSettings;
  /** 写入 app.config.webdav.*（App 侧立即落库并生效） */
  onAppSettingChange: (
    category: "webdav",
    field: keyof WebdavSettings,
    value: boolean | number | string,
  ) => void;
  /** 与上方「备份 API Key」开关共用：手动云端备份是否带上 Key（自动备份永远不带） */
  includeApiKeys: boolean;
  /** 与上方「备份 WebDAV 配置」开关共用：手动云端备份是否带上 WebDAV 配置 */
  includeWebdav: boolean;
}

type Busy =
  | "password"
  | "test"
  | "backup"
  | "remoteList"
  | "restoreRemote"
  | "localList"
  | "restoreLocal"
  | null;

export const WebdavPanel: React.FC<WebdavPanelProps> = ({
  settings,
  onAppSettingChange,
  includeApiKeys,
  includeWebdav,
}) => {
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const guard = useActionGuard();

  const [server, setServer] = useState(settings.server);
  const [username, setUsername] = useState(settings.username);
  const [folder, setFolder] = useState(settings.folder);
  const [password, setPassword] = useState("");

  const [status, setStatus] = useState<webdavApi.WebdavStatus | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<BackupFileEntry[] | null>(null);
  const [localFiles, setLocalFiles] = useState<BackupFileEntry[] | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const aliveRef = useRef(true);

  // 外部恢复设置（如导入备份）后同步草稿
  useEffect(() => setServer(settings.server), [settings.server]);
  useEffect(() => setUsername(settings.username), [settings.username]);
  useEffect(() => setFolder(settings.folder), [settings.folder]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await webdavApi.getWebdavStatus();
      if (aliveRef.current) setStatus(next);
    } catch {
      // 状态只是辅助展示，读不到不影响配置与备份操作
    }
  }, []);

  const refreshLocal = useCallback(async () => {
    try {
      const list = await webdavApi.listLocalBackups();
      if (aliveRef.current) setLocalFiles(list);
    } catch (e) {
      showToast(`读取本地备份失败：${errorText(e)}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    void refreshStatus();
    void refreshLocal();
  }, [refreshStatus, refreshLocal]);

  /** 草稿提交：文件夹留空回落到默认 FastNote，避免把备份写到根目录 */
  const commitText = (field: "server" | "username" | "folder", raw: string) => {
    const value = raw.trim();
    if (field === "folder") {
      onAppSettingChange("webdav", field, value || DEFAULT_WEBDAV_SETTINGS.folder);
      if (!value) setFolder(DEFAULT_WEBDAV_SETTINGS.folder);
      return;
    }
    onAppSettingChange("webdav", field, value);
  };

  const handleSavePassword = async () => {
    if (!password.trim()) {
      showToast("请输入 WebDAV 密码", "info");
      return;
    }
    setBusy("password");
    try {
      await webdavApi.setWebdavPassword(password);
      setPassword("");
      await refreshStatus();
      showToast("WebDAV 密码已保存", "success");
    } catch (e) {
      showToast(`保存密码失败：${errorText(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleClearPassword = async () => {
    const ok = await confirm({
      title: "清除 WebDAV 密码",
      message: "清除后自动备份会停止上传云端，直到重新填写密码。已上传的云端备份不受影响。",
      confirmText: "清除",
      danger: true,
    });
    if (!ok) return;
    setBusy("password");
    try {
      await webdavApi.setWebdavPassword("");
      await refreshStatus();
      showToast("已清除 WebDAV 密码", "success");
    } catch (e) {
      showToast(`清除密码失败：${errorText(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setBusy("test");
    try {
      const typedPassword = password.trim();
      const message = await webdavApi.testWebdav({
        server: server.trim(),
        username: username.trim(),
        // 留空表示沿用已保存的密码，不能传空串把它覆盖掉
        password: typedPassword ? password : undefined,
        folder: folder.trim() || DEFAULT_WEBDAV_SETTINGS.folder,
      });
      showToast(message, "success");
      // 连接验证通过就把新密码落库，避免测试成功但自动备份仍用旧密码
      if (typedPassword) {
        try {
          await webdavApi.setWebdavPassword(password);
          setPassword("");
          await refreshStatus();
        } catch (e) {
          showToast(`连接成功，但密码保存失败：${errorText(e)}`, "error");
        }
      }
    } catch (e) {
      showToast(`连接失败：${errorText(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleBackup = async () => {
    setBusy("backup");
    try {
      const result = await webdavApi.backupToWebdav(includeApiKeys, includeWebdav);
      showToast(`已上传 ${result.file}（${result.summary.notes} 篇笔记）`, "success");
      await refreshStatus();
      if (remoteFiles) {
        const list = await webdavApi.listRemoteBackups();
        if (aliveRef.current) setRemoteFiles(list);
      }
    } catch (e) {
      showToast(`云端备份失败：${errorText(e)}`, "error");
      void refreshStatus();
    } finally {
      setBusy(null);
    }
  };

  const handleListRemote = async () => {
    setBusy("remoteList");
    try {
      const list = await webdavApi.listRemoteBackups();
      if (aliveRef.current) setRemoteFiles(list);
    } catch (e) {
      showToast(`读取云端备份失败：${errorText(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  /** 恢复前先冲掉主题防抖写入，否则旧主题会在恢复后回写覆盖备份里的主题 */
  const restore = async (
    source: "remote" | "local",
    name: string,
  ) => {
    const formatLabel = source === "remote" ? "云端备份" : "本地备份";
    const ok = await confirm({
      title: "从备份恢复",
      message: `恢复会用${formatLabel}「${name}」覆盖当前的**全部**笔记、分组、回收站、AI 对话记录与设置。当前数据将被清空，无法撤销，建议先导出一份备份。`,
      confirmText: "覆盖并恢复",
      danger: true,
    });
    if (!ok) return;

    setBusy(source === "remote" ? "restoreRemote" : "restoreLocal");
    try {
      await flushThemeSettings();
      const summary =
        source === "remote"
          ? await webdavApi.restoreRemoteBackup(name)
          : await webdavApi.restoreLocalBackup(name);
      showToast(`恢复完成：${summary.notes} 篇笔记，界面即将刷新`, "success");
      window.setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setBusy(null);
      showToast(`恢复失败：${errorText(e)}`, "error");
    }
  };

  const openBackupDir = async () => {
    try {
      const dir = status?.backup_dir ?? (await webdavApi.getBackupDir());
      await openAppFolder(dir);
    } catch (e) {
      showToast(`打开备份目录失败：${errorText(e)}`, "error");
    }
  };

  const target = settings.autoTarget;
  const autoBusy = busy !== null;
  const busyLabel = (label: string) => (busy !== null ? "处理中…" : label);

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-faint">
        WebDAV 可与 Nextcloud、群晖、坚果云、Alist 等服务配合，把备份保存到自己的云端。
        自动备份只生成 JSON 且不包含 API Key；手动备份是否带 Key 由上方开关决定。
      </p>

      {/* 连接配置 */}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">连接配置</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
              服务器填 WebDAV 根地址；备份会放进该地址下的文件夹（默认 FastNote，不存在时自动创建）。
            </p>
          </div>
          <span
            className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
              status?.has_password
                ? "bg-success-soft text-success"
                : "bg-surface-alt text-faint"
            }`}
          >
            {status?.has_password ? "密码已保存" : "密码未设置"}
          </span>
        </div>

        <div className="space-y-2 border-t border-line-soft px-3.5 py-3">
          <label className="block">
            <span className="mb-1 block text-[11px] text-faint">服务器地址</span>
            <input
              type="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => commitText("server", server)}
              placeholder="https://dav.example.com/remote.php/dav/files/user/"
              spellCheck={false}
              className="w-full px-2 py-1.5 text-xs input-modern"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-faint">账号</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onBlur={() => commitText("username", username)}
                autoComplete="username"
                spellCheck={false}
                className="w-full px-2 py-1.5 text-xs input-modern"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-faint">密码</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSavePassword();
                  }}
                  placeholder={status?.has_password ? "已保存，留空不修改" : "WebDAV 密码"}
                  autoComplete="new-password"
                  className="min-w-0 flex-1 px-2 py-1.5 text-xs input-modern"
                />
                <button
                  type="button"
                  onClick={() => void guard(handleSavePassword)}
                  disabled={autoBusy}
                  className="flex-shrink-0 rounded-lg bg-primary-500 px-2.5 py-1.5 text-[11px] font-medium text-on-accent transition-colors hover:bg-primary-600 disabled:opacity-40"
                >
                  {busy === "password" ? "保存中…" : "保存"}
                </button>
                {status?.has_password && (
                  <button
                    type="button"
                    onClick={() => void guard(handleClearPassword)}
                    disabled={autoBusy}
                    title="清除已保存的密码"
                    className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-lg border border-line text-faint transition-colors hover:bg-surface-alt hover:text-danger disabled:opacity-40"
                  >
                    <Icon name="modal-close" className="h-3 w-3" />
                  </button>
                )}
              </div>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] text-faint">云端文件夹</span>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onBlur={() => commitText("folder", folder)}
              placeholder={DEFAULT_WEBDAV_SETTINGS.folder}
              spellCheck={false}
              className="w-full px-2 py-1.5 text-xs input-modern"
            />
          </label>

          <div className="flex items-center justify-between gap-3 pt-0.5">
            <p className="text-[10px] leading-relaxed text-faint">
              {status?.last_backup_at
                ? `最近自动备份：${prettyTime(status.last_backup_at)}${status.last_file ? `（${status.last_file}）` : ""}`
                : "还没有自动备份记录"}
            </p>
            <button
              type="button"
              onClick={() => void guard(handleTest)}
              disabled={autoBusy}
              className="flex-shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt disabled:opacity-40"
            >
              {busy === "test" ? "测试中…" : "测试连接"}
            </button>
          </div>

          {status?.last_error && (
            <p className="break-all rounded-lg bg-danger-soft px-2 py-1.5 text-[10px] leading-relaxed text-danger">
              上次自动备份失败：{status.last_error}
            </p>
          )}
        </div>
      </div>

      {/* 自动备份 */}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">自动备份</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
              后台按间隔自动生成本地 JSON 备份，并可按目标上传云端；失败 10 分钟后重试。
            </p>
          </div>
          <Toggle
            value={settings.autoBackup}
            onChange={(v) => onAppSettingChange("webdav", "autoBackup", v)}
          />
        </div>

        {settings.autoBackup && (
          <div className="space-y-2.5 border-t border-line-soft px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-body">备份间隔</p>
                <p className="mt-0.5 text-[10px] text-faint">1–720 小时，修改后下一轮生效。</p>
              </div>
              <NumberField
                value={settings.autoIntervalHours}
                min={1}
                max={720}
                unit="小时"
                onChange={(v) => onAppSettingChange("webdav", "autoIntervalHours", v)}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-body">备份目标</p>
                <p className="mt-0.5 text-[10px] text-faint">
                  本地备份默认写入软件目录下的 backup 文件夹。
                </p>
              </div>
              <div className="flex flex-shrink-0 gap-1">
                {TARGET_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onAppSettingChange("webdav", "autoTarget", option.value)}
                    className={`rounded-lg px-2 py-1 text-[11px] transition-colors ${
                      target === option.value
                        ? "bg-primary-50 font-medium text-primary-600"
                        : "bg-surface-alt text-muted hover:text-body"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {target !== "cloud" && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-body">本地最多保留</p>
                  <p className="mt-0.5 text-[10px] text-faint">
                    超出后删除最早的自动备份；云端备份不清理。
                  </p>
                </div>
                <NumberField
                  value={settings.autoMaxLocal}
                  min={1}
                  max={200}
                  unit="份"
                  onChange={(v) => onAppSettingChange("webdav", "autoMaxLocal", v)}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 手动备份 */}
      <div className="flex items-center gap-3 rounded-xl bg-app border border-line-soft p-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary-50">
          <Icon name="app-backup" className="h-4 w-4 text-primary-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-body">备份到云端</p>
          <p className="mt-0.5 text-[11px] text-faint">
            立即上传一份 JSON 备份
            {includeApiKeys || includeWebdav
              ? `（含${[includeApiKeys ? "API Key" : "", includeWebdav ? "WebDAV 配置" : ""].filter(Boolean).join("、")}）`
              : "（不含 API Key 与 WebDAV 配置）"}
            。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void guard(handleBackup)}
          disabled={autoBusy}
          className="btn-primary flex-shrink-0 px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busyLabel("备份")}
        </button>
      </div>

      {/* 云端恢复 */}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">从云端恢复</p>
            <p className="mt-0.5 text-[11px] text-faint">获取云端备份列表后，选择一份拉取并覆盖当前数据。</p>
          </div>
          <button
            type="button"
            onClick={() => void guard(handleListRemote)}
            disabled={autoBusy}
            className="flex-shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-body transition-colors hover:bg-surface-alt disabled:opacity-40"
          >
            {busy === "remoteList" ? "读取中…" : remoteFiles ? "刷新列表" : "获取列表"}
          </button>
        </div>
        {remoteFiles && remoteFiles.length > 0 && (
          <div className="border-t border-line-soft">
            <div className="max-h-56 overflow-y-auto">
              {remoteFiles.map((entry) => (
                <BackupRow
                  key={entry.name}
                  entry={entry}
                  busy={autoBusy}
                  onRestore={() => void guard(() => restore("remote", entry.name))}
                />
              ))}
            </div>
          </div>
        )}
        {remoteFiles && remoteFiles.length === 0 && (
          <p className="border-t border-line-soft px-3.5 py-3 text-[11px] text-faint">
            云端文件夹里还没有 FastNote 备份。
          </p>
        )}
      </div>

      {/* 本地恢复 */}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">从本地恢复</p>
            <p className="mt-0.5 text-[11px] text-faint">
              自动备份目录{status?.backup_dir ? `：${status.backup_dir}` : ""}
            </p>
          </div>
          <div className="flex flex-shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => void guard(openBackupDir)}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-body transition-colors hover:bg-surface-alt"
            >
              打开目录
            </button>
            <button
              type="button"
              onClick={() => void guard(refreshLocal)}
              disabled={autoBusy}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-body transition-colors hover:bg-surface-alt disabled:opacity-40"
            >
              刷新
            </button>
          </div>
        </div>
        {localFiles && localFiles.length > 0 && (
          <div className="max-h-56 overflow-y-auto border-t border-line-soft">
            {localFiles.map((entry) => (
              <BackupRow
                key={entry.name}
                entry={entry}
                busy={autoBusy}
                onRestore={() => void guard(() => restore("local", entry.name))}
              />
            ))}
          </div>
        )}
        {localFiles && localFiles.length === 0 && (
          <p className="border-t border-line-soft px-3.5 py-3 text-[11px] text-faint">
            备份目录里还没有备份文件；开启自动备份或手动导出后会出现在这里。
          </p>
        )}
      </div>

      {confirmDialog}
    </div>
  );
};
