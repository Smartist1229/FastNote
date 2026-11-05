/* 插件管理：安装 / 启用 / 卸载插件，数据直接来自插件宿主单例。 */

import { useMemo, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { openPluginFolder, uninstallPlugin } from "@/api/system/plugins";
import { Icon } from "@/components/common/Icon";
import { Modal } from "@/components/common/Modal";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { useToast } from "@/components/common/Toast";
import { useActionGuard } from "@/hooks/useActionGuard";
import { useI18n } from "@/i18n";
import { PERMISSION_INFO } from "@/interface/system/plugins";
import { openExternalLink } from "@/lib/app/externalLink";
import { PluginIcon } from "../PluginIcon";
import { pluginHost, type PluginEntry } from "@/plugins/host";
import { usePluginContributions, type PluginSettingsSectionEntry } from "@/plugins/contributions";
import { Switch } from "../controls";

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行提示文案 */
const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

/** 插件分区在设置弹窗里的合成 key，与 SettingsModal 的 pluginSectionKey 保持一致 */
const pluginSectionKey = (entry: PluginSettingsSectionEntry): string =>
  `plugin:${entry.pluginId}:${entry.section.id}`;

interface PluginsSectionProps {
  /** 跳到某个插件设置分区；由 SettingsModal 注入（内部就是 selectSection） */
  onOpenPluginSection?: (key: string) => void;
}

/** 数据直接取自插件宿主单例，不经过 SettingsModalProps / SettingsSectionContext */
export const PluginsSection: React.FC<PluginsSectionProps> = ({ onOpenPluginSection }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const guard = useActionGuard();
  const { confirm, confirmDialog } = useConfirm();
  const plugins = useSyncExternalStore(pluginHost.subscribe, pluginHost.snapshot);
  const [zipBusy, setZipBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  /** 正在查看权限的插件；非空时打开权限弹窗 */
  const [permTarget, setPermTarget] = useState<PluginEntry | null>(null);
  /** 插件介绍展开状态（按 dirName），不持久化 */
  const [expandedDesc, setExpandedDesc] = useState<Record<string, boolean>>({});

  /* 插件设置分区：门面订阅注册表版本，插件启停 / 重激活时刷新「配置」按钮 */
  const contributions = usePluginContributions();
  const sectionByPlugin = useMemo(() => {
    const out = new Map<string, PluginSettingsSectionEntry>();
    for (const entry of contributions.settingsSections()) {
      const prev = out.get(entry.pluginId);
      // 插件主动声明的分区优先于宿主自动生成的配置分区
      if (!prev || (prev.section.auto && !entry.section.auto)) {
        out.set(entry.pluginId, entry);
      }
    }
    return out;
  }, [contributions]);

  /** 安装插件包：文件对话框选 zip → 后端解压安装 → 权限确认弹窗 → 激活或回滚 */
  const handleInstallZip = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: t("插件包"), extensions: ["zip"] }],
    });
    if (!selected || typeof selected !== "string") return;
    setZipBusy(true);
    let installedManifest: Awaited<ReturnType<typeof pluginHost.installZip>> | null =
      null;
    try {
      // 第一步：落盘（Rust 端此时已做 manifest 完整性 + 权限白名单校验）
      installedManifest = await pluginHost.installZip(selected);
    } catch (e) {
      showToast(t("安装失败：{value1}", { value1: errorText(e) }), "error");
      return;
    } finally {
      setZipBusy(false);
    }

    // 第二步：权限确认弹窗（即使没有权限也要弹，保持一致的安全仪式感）
    const manifest = installedManifest;
    const perms = manifest.permissions ?? [];
    const permListHtml =
      perms.length === 0
        ? `<div class="text-sm text-faint">${t("无特殊权限")}</div>`
        : perms
            .map((p) => {
              const info = PERMISSION_INFO[p];
              return `<div class="flex items-start gap-2 py-1.5">
                <span class="text-[11px] font-medium text-primary-500 font-mono bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 rounded">${p}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-body">${info?.label ?? p}</div>
                  ${info?.desc ? `<div class="text-[11px] text-faint mt-0.5">${info.desc}</div>` : ""}
                </div>
              </div>`;
            })
            .join("");

    const confirmed = await confirm({
      title: t("安装前确认"),
      message: (
        <div className="space-y-3">
          <p className="text-sm text-body leading-relaxed">
            {t("插件 {name} 申请以下权限：", { name: manifest.name })}
          </p>
          <div className="bg-surface-alt border border-line rounded-xl p-2.5">
            {perms.length === 0 ? (
              <div className="text-sm text-faint">{t("无特殊权限")}</div>
            ) : (
              <div className="divide-y divide-line-soft">
                {perms.map((p) => {
                  const info = PERMISSION_INFO[p];
                  return (
                    <div key={p} className="flex items-start gap-2 py-1.5 first:pt-0 last:pb-0">
                      <span className="text-[11px] font-medium text-primary-500 font-mono bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 rounded whitespace-nowrap">
                        {p}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-body">{info?.label ?? p}</div>
                        {info?.desc && (
                          <div className="text-[11px] text-faint mt-0.5">{info.desc}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <p className="text-[11px] text-faint leading-relaxed">
            {t("安装后可在设置中变更。")}
          </p>
        </div>
      ),
      confirmText: t("安装"),
      cancelText: t("取消"),
    });

    if (confirmed) {
      // 点了安装：刷新插件列表（manifest 默认 enabled 由 Rust 端 plugin.json 的 defaultEnabled 决定）
      showToast(t("已安装插件：{name}", { name: manifest.name }), "success");
    } else {
      // 点了取消：回滚——删除刚落盘的插件目录
      try {
        await uninstallPlugin(manifest.dirName);
        await pluginHost.refresh();
      } catch {
        // 回滚失败不阻塞，只打日志
        console.warn("插件安装后取消，回滚删除失败", manifest.dirName);
      }
    }
    // 静默使用（避免 TS 抱怨未使用）：permListHtml 仅作为备用字符串拼接方案，实际用 JSX 渲染
    void permListHtml;
  };

  /** 重新扫描插件目录：用户直接在文件夹里增删插件后手动刷新 */
  const handleRefresh = async () => {
    setRefreshBusy(true);
    try {
      await pluginHost.refresh();
      showToast(t("已重新扫描插件文件夹"), "success");
    } catch (e) {
      showToast(t("刷新失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setRefreshBusy(false);
    }
  };

  /** 在文件管理器中打开插件文件夹 */
  const handleOpenFolder = async () => {
    try {
      await openPluginFolder();
    } catch (e) {
      showToast(t("插件文件夹路径获取失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const handleToggle = async (plugin: PluginEntry, enabled: boolean) => {
    try {
      await pluginHost.setPluginEnabled(plugin.dirName, enabled);
    } catch (e) {
      showToast(t("启用状态保存失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const handleUninstall = async (plugin: PluginEntry) => {
    try {
      await pluginHost.uninstall(plugin.dirName);
      showToast(t("已卸载：{name}", { name: plugin.name }), "success");
    } catch (e) {
      showToast(t("卸载失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const busy = zipBusy || refreshBusy;

  /** 「配置」按钮：该插件在 registry 里有设置分区时显示，点击跳到对应分区 */
  const renderConfigButton = (plugin: PluginEntry) => {
    const section = sectionByPlugin.get(plugin.dirName);
    if (!section) return null;
    return (
      <button
        onClick={() => onOpenPluginSection?.(pluginSectionKey(section))}
        disabled={busy}
        className="inline-flex h-7 items-center px-2 rounded-lg text-[11px] font-medium leading-none text-body hover:bg-surface-alt transition-colors disabled:opacity-50"
      >
        {t("配置")}
      </button>
    );
  };

  /** 渲染单个权限条目（只读：已授予/未知标识符） */
  const renderPermissionRow = (permId: string) => {
    const info = PERMISSION_INFO[permId];
    if (!info) {
      // 理论上 Rust 端白名单校验已拦住未知标识符，这里是防御性处理
      return (
        <div key={permId} className="flex items-center justify-between gap-3 py-2">
          <div className="flex items-start gap-2 min-w-0">
            <span className="text-[11px] font-mono bg-danger-soft text-danger-strong px-2 py-0.5 rounded whitespace-nowrap">
              {permId}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-danger-strong">{t("未知权限")}</div>
            </div>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded bg-danger-soft text-danger-strong whitespace-nowrap">
            {t("已拒绝")}
          </span>
        </div>
      );
    }
    return (
      <div key={permId} className="flex items-center justify-between gap-3 py-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="text-[11px] font-medium text-primary-500 font-mono bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 rounded whitespace-nowrap">
            {permId}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-body">{info.label}</div>
            {info.desc && (
              <div className="text-[11px] text-faint mt-0.5">{info.desc}</div>
            )}
          </div>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded bg-success-soft text-success-strong whitespace-nowrap">
          {t("已授予")}
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* 安全提示 + 实验性标签 */}
      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-purple-50 border border-purple-200">
        <Icon name="ai-alert-triangle" className="w-4 h-4 text-purple-600 mt-0.5" />
        <p className="text-[11px] text-purple-600 leading-relaxed">
          <span className="inline-flex items-center px-1.5 py-0.5 mr-1.5 rounded-md bg-purple-100 text-purple-700 font-medium">
            {t("实验性功能")}
          </span>
          {t("插件在应用内运行第三方代码，请仅安装可信来源的插件包；安装前会列出插件申请的权限。")}
        </p>
      </div>

      {/* 顶部操作 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void guard(handleInstallZip)}
          disabled={busy}
          className="btn-primary px-3 py-1.5 text-xs flex-shrink-0 disabled:opacity-50"
        >
          {zipBusy ? t("安装中...") : t("安装插件（zip）")}
        </button>
        <button
          onClick={() => void guard(handleRefresh)}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt border border-line rounded-xl hover:bg-surface transition-colors flex-shrink-0 disabled:opacity-50"
        >
          {refreshBusy ? t("刷新中...") : t("刷新")}
        </button>
        <button
          onClick={() => void guard(handleOpenFolder)}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt border border-line rounded-xl hover:bg-surface transition-colors flex-shrink-0 disabled:opacity-50"
        >
          {t("打开插件文件夹")}
        </button>
        <p className="text-[11px] text-faint ml-1">{t("插件可以为笔记右键菜单与命令面板添加功能。")}</p>
        <p className="text-[11px] text-faint ml-1">
          {t("配置在「插件」分组下的对应分区中修改，改动即时生效。")}
        </p>
      </div>

      {/* 插件列表 */}
      {plugins.length === 0 ? (
        <p className="text-[11px] text-faint px-3 py-2">{t("暂无插件")}</p>
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin) => (
            <div
              key={plugin.dirName}
              className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft"
            >
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <PluginIcon url={plugin.iconUrl} size={20} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-body">{plugin.name}</span>
                    <span className="text-[10px] text-faint">v{plugin.version}</span>
                    {plugin.author ? <span className="text-[10px] text-faint">{plugin.author}</span> : null}
                    {plugin.tags?.map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-[1px] rounded bg-surface-alt text-[10px] text-faint border border-line"
                      >
                        {t(tag)}
                      </span>
                    ))}
                  </div>
                  <p className="text-[10px] text-faint mt-0.5 break-all">{plugin.dirName}</p>
                  {plugin.homepage && (
                    <button
                      onClick={() => void openExternalLink(plugin.homepage!)}
                      className="text-[10px] text-primary-500 hover:underline break-all text-left mt-0.5"
                      title={plugin.homepage}
                    >
                      {plugin.homepage}
                    </button>
                  )}
                  {plugin.description && (
                    <div className="mt-1 flex items-start gap-1.5">
                      <p
                        className={`flex-1 min-w-0 text-[11px] text-faint leading-relaxed ${
                          expandedDesc[plugin.dirName] ? "whitespace-pre-wrap break-words" : "truncate"
                        }`}
                      >
                        {plugin.description}
                      </p>
                      <button
                        onClick={() =>
                          setExpandedDesc((prev) => ({
                            ...prev,
                            [plugin.dirName]: !prev[plugin.dirName],
                          }))
                        }
                        className="flex-shrink-0 text-[10px] text-primary-500 hover:underline leading-relaxed"
                      >
                        {expandedDesc[plugin.dirName] ? t("收起") : t("展开")}
                      </button>
                    </div>
                  )}
                  {plugin.failed && (
                    <p className="text-[11px] text-danger-strong mt-1">
                      {t("加载失败：{value1}", { value1: plugin.error ?? "" })}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {plugin.permissions && plugin.permissions.length > 0 && (
                  <button
                    onClick={() => setPermTarget(plugin)}
                    disabled={busy}
                    className="inline-flex h-7 items-center gap-1 px-2 rounded-lg text-[11px] font-medium leading-none text-body hover:bg-surface-alt transition-colors disabled:opacity-50"
                    title={t("申请权限")}
                  >
                    <Icon name="ai-shield-check" className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="leading-none">{t("权限")}</span>
                  </button>
                )}
                {renderConfigButton(plugin)}
                <button
                  onClick={() => void handleUninstall(plugin)}
                  disabled={busy}
                  className="inline-flex h-7 items-center px-2 rounded-lg text-[11px] font-medium leading-none text-danger-strong hover:bg-danger-soft transition-colors disabled:opacity-50"
                >
                  {t("卸载")}
                </button>
                <div className="flex h-7 items-center pl-1">
                  <Switch value={plugin.enabled} onChange={(v) => void handleToggle(plugin, v)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 权限查看弹窗（只读） */}
      {permTarget && (
        <Modal
          isOpen
          onClose={() => setPermTarget(null)}
          title={t("{name} 的申请权限", { name: permTarget.name })}
          zIndex={100}
        >
          <div className="space-y-3">
            <p className="text-[11px] text-faint leading-relaxed">
              {t("插件 {name} 声明会申请以下权限。当前版本全部自动授予；未来可在白名单收紧时单独拒绝。", {
                name: permTarget.name,
              })}
            </p>
            <div className="bg-surface-alt border border-line rounded-xl px-3 divide-y divide-line-soft">
              {(permTarget.permissions?.length ?? 0) === 0 ? (
                <div className="py-3 text-sm text-faint">{t("无特殊权限")}</div>
              ) : (
                permTarget.permissions!.map(renderPermissionRow)
              )}
            </div>
            <div className="flex justify-end pt-1">
              <button onClick={() => setPermTarget(null)} className="btn-ghost px-4 py-2 text-sm">
                {t("关闭")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* useConfirm 的 portal 必须渲染在 JSX 里 */}
      {confirmDialog}
    </div>
  );
};
