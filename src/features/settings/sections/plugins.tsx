/* 插件管理：安装 / 启用 / 卸载插件，数据直接来自插件宿主单例。 */

import { useMemo, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { installDemoPlugin, openPluginFolder, uninstallPlugin } from "@/api/system/plugins";
import { Icon } from "@/components/common/Icon";
import { Modal } from "@/components/common/Modal";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { useToast } from "@/components/common/Toast";
import { useActionGuard } from "@/hooks/useActionGuard";
import { useI18n } from "@/i18n";
import { PERMISSION_INFO } from "@/interface/system/plugins";
import { compareVersions } from "@/plugins/version";
import { openExternalLink } from "@/lib/app/externalLink";
import { PluginIcon } from "../PluginIcon";
import { pluginHost, type PluginDiagnostics, type PluginEntry } from "@/plugins/host";
import { usePluginContributions, type PluginSettingsSectionEntry } from "@/plugins/contributions";
import { Switch } from "../controls";

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行提示文案 */
const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

/** 开发预览（vite dev）下刷新才同步演示插件；打包版刷新只重扫目录，不重装 */
const IS_DEV = import.meta.env.DEV;

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
  /** 「安装演示插件」按钮的忙碌态（与刷新分开，两个按钮的文案各自独立） */
  const [demoBusy, setDemoBusy] = useState(false);
  /** 正在查看权限的插件；非空时打开权限弹窗 */
  const [permTarget, setPermTarget] = useState<PluginEntry | null>(null);
  /** 正在重载的插件（按钮忙碌态） */
  const [reloadBusy, setReloadBusy] = useState<string | null>(null);
  /** 诊断弹窗目标 */
  const [diagTarget, setDiagTarget] = useState<PluginEntry | null>(null);
  /** 诊断快照：停用中的插件要临时激活一次才采得到贡献，所以是异步取回来的 */
  const [diag, setDiag] = useState<PluginDiagnostics | null>(null);
  /** 诊断读取中（首次打开 / 弹窗里重新读取） */
  const [diagBusy, setDiagBusy] = useState(false);
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
    // 装之前先记一份现状：装完要能对比「新增了哪些权限」「是不是降级」
    const beforeById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
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
    const previous = beforeById.get(manifest.id);
    // 升级时新增的权限单独列出来：静默全授予是对用户不诚实
    const addedPerms = previous
      ? perms.filter((p) => !(previous.permissions ?? []).includes(p))
      : [];
    // 降级安装：不阻止（有时就是为了回滚），但要在弹窗里说清楚
    const downgrade =
      previous != null && compareVersions(manifest.version, previous.version) < 0
        ? { from: previous.version, to: manifest.version }
        : null;
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
                        <div className="text-sm text-body">{info ? t(info.label) : p}</div>
                        {info?.desc && (
                          <div className="text-[11px] text-faint mt-0.5">{t(info.desc)}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {addedPerms.length > 0 && (
            <p className="text-[11px] text-warning leading-relaxed">
              {t("本次升级新增权限：{value1}", { value1: addedPerms.join("、") })}
            </p>
          )}
          {downgrade && (
            <p className="text-[11px] text-warning leading-relaxed">
              {t("这是降级安装：已装 v{value1}，即将装 v{value2}", {
                value1: downgrade.from,
                value2: downgrade.to,
              })}
            </p>
          )}
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

  /**
   * 刷新 = 重新扫描插件目录。
   * 只有开发预览下才顺带覆盖写一份最新的演示插件，方便改完立刻看效果；
   * 打包版刷新不重装演示插件（它只在首次启动种一次，之后想装回来点「安装演示插件」）。
   */
  const handleRefresh = async () => {
    setRefreshBusy(true);
    try {
      if (IS_DEV) await installDemoPlugin();
      await pluginHost.refresh();
      showToast(t(IS_DEV ? "已重新扫描插件文件夹，并更新了演示插件" : "已重新扫描插件文件夹"), "success");
    } catch (e) {
      showToast(t("刷新失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setRefreshBusy(false);
    }
  };

  /**
   * 单独安装 / 重装演示插件。
   * 打包版只在首次启动释放一次，用户删掉后不会再自动出现——想装回来点这里。
   */
  const handleInstallDemo = async () => {
    setDemoBusy(true);
    try {
      await installDemoPlugin();
      await pluginHost.refresh();
      showToast(t("已安装演示插件（最新版本）"), "success");
    } catch (e) {
      showToast(t("安装演示插件失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setDemoBusy(false);
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

  /**
   * 卸载插件：先查它建过哪些私有表——有的话问一句要不要一起删。
   * 表名前缀带插件目录名，卸载后不会有人再用它们，留着就是孤儿；
   * 但数据可能对用户有价值（重新装回插件还能读到），所以交给用户决定。
   */
  const handleUninstall = async (plugin: PluginEntry) => {
    try {
      const tables = await pluginHost.pluginTables(plugin.dirName);
      let dropped = 0;
      if (tables.length > 0) {
        const wipe = await confirm({
          title: t("卸载 {name}", { name: plugin.name }),
          message: (
            <div className="space-y-2">
              <p className="text-sm text-body leading-relaxed">
                {t("这个插件创建了 {count} 张数据表：", { count: tables.length })}
              </p>
              <p className="font-mono text-[12px] text-faint break-all">{tables.join(" · ")}</p>
              <p className="text-[11px] text-faint leading-relaxed">
                {t(
                  "删除后无法恢复；保留则只卸载插件，表留在数据库里，重新安装该插件后仍能读到。",
                )}
              </p>
            </div>
          ),
          confirmText: t("删除数据表并卸载"),
          cancelText: t("保留数据表并卸载"),
          danger: true,
        });
        if (wipe) {
          dropped = await pluginHost.dropPluginTables(plugin.dirName);
        }
      }
      await pluginHost.uninstall(plugin.dirName);
      showToast(
        dropped > 0
          ? t("已卸载：{name}（删除 {count} 张数据表）", { name: plugin.name, count: dropped })
          : t("已卸载：{name}", { name: plugin.name }),
        "success",
      );
    } catch (e) {
      showToast(t("卸载失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  /** 重新加载单个插件：不用关开关、不用重启软件，排查「改完没生效」时最快 */
  const handleReload = async (plugin: PluginEntry) => {
    setReloadBusy(plugin.dirName);
    try {
      await pluginHost.reloadPlugin(plugin.dirName);
      showToast(t("已重新加载：{name}", { name: plugin.name }), "success");
    } catch (e) {
      showToast(t("重新加载失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setReloadBusy(null);
    }
  };

  /**
   * 打开诊断：直接带着数字打开，不等用户再点一次「重新加载」。
   * 贡献统计只存在于内存注册表里，停用中的插件早就被清空了，所以宿主会临时
   * activate 一次采集（probed），采完立刻停回去——这里只要 await 结果即可。
   */
  const openDiagnostics = async (plugin: PluginEntry) => {
    setDiagTarget(plugin);
    setDiag(null);
    setDiagBusy(true);
    try {
      setDiag(await pluginHost.pluginDiagnostics(plugin.dirName));
    } catch (e) {
      showToast(t("诊断读取失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setDiagBusy(false);
    }
  };

  /**
   * 弹窗里的「重新加载」：原地刷新数字，不再关掉弹窗让人重开一遍。
   * 启用中的插件走真正的重载（副作用重跑）；停用中的插件仍由 probe 临时采集，读完全停回去。
   */
  const handleDiagReload = async () => {
    const target = diagTarget;
    if (!target) return;
    if (target.enabled) await handleReload(target);
    setDiagBusy(true);
    try {
      setDiag(await pluginHost.pluginDiagnostics(target.dirName));
    } catch (e) {
      showToast(t("诊断读取失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setDiagBusy(false);
    }
  };

  const busy = zipBusy || refreshBusy || demoBusy;

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
            <div className="text-sm text-body">{t(info.label)}</div>
            {info.desc && (
              <div className="text-[11px] text-faint mt-0.5">{t(info.desc)}</div>
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
          title={t("重新扫描插件文件夹（开发预览下会同步更新演示插件）")}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt border border-line rounded-xl hover:bg-surface transition-colors flex-shrink-0 disabled:opacity-50"
        >
          {refreshBusy ? t("刷新中...") : t("刷新")}
        </button>
        <button
          onClick={() => void guard(handleInstallDemo)}
          disabled={busy}
          title={t("把内置的演示插件装回来（会覆盖为最新版本，配置保留）")}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt border border-line rounded-xl hover:bg-surface transition-colors flex-shrink-0 disabled:opacity-50"
        >
          {demoBusy ? t("安装中...") : t("安装演示插件")}
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
            <div key={plugin.dirName} className="px-3 py-2.5 rounded-xl bg-app border border-line-soft">
              {/* 顶部一行：左边标题块、右边操作按钮 */}
              <div className="flex items-start justify-between gap-6">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <PluginIcon url={plugin.iconUrl} size={20} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    {/* 标题行只放名称 / 版本 / 作者：标签已挪到下一行的目录名旁边。
                        原因：启用后会多出一个「配置」按钮，右侧操作区变宽、左栏变窄，
                        标签留在这一行就会被挤到第二行（未启用时恰好放得下）。 */}
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-medium text-body truncate min-w-0">{plugin.name}</span>
                      <span className="text-[10px] text-faint flex-shrink-0">v{plugin.version}</span>
                      {plugin.author ? (
                        <span className="text-[10px] text-faint truncate min-w-0">{plugin.author}</span>
                      ) : null}
                    </div>
                    {/* 目录名 + 标签同一行：这一行左侧空间富余（不跟操作按钮抢宽度），
                        标签跟着目录名走，插件启停时行数不变，视觉上也不再被按钮挤来挤去。 */}
                    <div className="mt-0.5 flex items-center gap-2 min-w-0">
                      <span className="text-[10px] text-faint truncate min-w-0" title={plugin.dirName}>
                        {plugin.dirName}
                      </span>
                      {plugin.tags && plugin.tags.length > 0 && (
                        <span className="flex items-center gap-1 flex-shrink-0">
                          {plugin.tags.map((tag) => (
                            <span
                              key={tag}
                              className="px-1.5 py-[1px] rounded bg-surface-alt text-[10px] text-faint border border-line whitespace-nowrap"
                            >
                              {t(tag)}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
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
                    onClick={() => void handleReload(plugin)}
                    disabled={busy || reloadBusy === plugin.dirName}
                    className="inline-flex h-7 items-center gap-1 px-2 rounded-lg text-[11px] font-medium leading-none text-body hover:bg-surface-alt transition-colors disabled:opacity-50"
                    title={t("重新加载这个插件（等价于停用再启用）")}
                  >
                    <Icon name="sidebar-refresh" className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="leading-none">{t("重载")}</span>
                  </button>
                  <button
                    onClick={() => void openDiagnostics(plugin)}
                    disabled={busy}
                    className="inline-flex h-7 items-center gap-1 px-2 rounded-lg text-[11px] font-medium leading-none text-body hover:bg-surface-alt transition-colors disabled:opacity-50"
                    title={t("查看这个插件注册了哪些东西")}
                  >
                    <Icon name="sidebar-list" className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="leading-none">{t("诊断")}</span>
                  </button>
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

              {/* 简介 / 主页 / 错误横跨整张卡片：右栏只有顶部那一行按钮，
                  下面那片空白正好留给正文——之前描述被关在左栏里，右边明明空着一大片却只能窄着换行 */}
              <div className="mt-1.5 min-w-0 pl-7">
                {plugin.description && (
                  <div className="flex items-start gap-1.5">
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
                {plugin.homepage && (
                  <button
                    onClick={() => void openExternalLink(plugin.homepage!)}
                    className="mt-0.5 text-[10px] text-primary-500 hover:underline break-all text-left"
                    title={plugin.homepage}
                  >
                    {plugin.homepage}
                  </button>
                )}
                {plugin.failed && (
                  <p className="mt-1 text-[11px] text-danger-strong">
                    {t("加载失败：{value1}", { value1: plugin.error ?? "" })}
                  </p>
                )}
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

      {/* 诊断弹窗：这个插件到底注册上了什么，一眼看清。
          数字在「点开」时就已经取好（停用中的插件由宿主临时加载一次采集），
          不再需要先点「重新加载」、再重开弹窗看第二遍。 */}
      {diagTarget && (
        <Modal
          isOpen
          onClose={() => setDiagTarget(null)}
          title={t("{name} 的诊断", { name: diagTarget.name })}
          zIndex={100}
        >
          <div className="space-y-3">
            {diag ? (
              <>
                <div className="bg-surface-alt border border-line rounded-xl px-3 py-2 text-[11px] text-faint leading-relaxed break-all">
                  <div>
                    {t("目录名：{value1}", { value1: diag.dirName })} · v{diag.version}
                  </div>
                  <div>
                    {diag.enabled ? t("已启用") : t("已停用")}
                    {diag.failed ? ` · ${t("加载失败")}` : ""}
                  </div>
                  {diag.error && <div className="text-danger-strong mt-1">{diag.error}</div>}
                </div>

                {/* 停用中的插件没有任何真实贡献，这里的数字是临时加载采回来的，必须说清楚 */}
                {diag.probed && (
                  <p className="px-1 text-[11px] text-muted leading-relaxed">
                    {t(
                      "插件当前为停用状态：下面的数字由「临时加载一次」采集，采集后已恢复停用，这些能力目前不会生效。",
                    )}
                  </p>
                )}

                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: t("笔记右键菜单"), value: diag.contributions.noteMenus },
                    { label: t("分组右键菜单"), value: diag.contributions.groupMenus },
                    { label: t("命令面板命令"), value: diag.contributions.commands },
                    { label: t("编辑器工具栏"), value: diag.contributions.toolbars },
                    { label: t("AI 工具"), value: diag.contributions.aiTools },
                    { label: t("AI 提示词"), value: diag.contributions.aiPrompts },
                    { label: t("AI 服务商模板"), value: diag.contributions.aiProviders },
                    { label: t("设置分区"), value: diag.contributions.settingsSections },
                    { label: t("生命周期钩子"), value: diag.contributions.hooks },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between px-3 py-2 rounded-xl bg-app border border-line-soft"
                    >
                      <span className="text-[11px] text-body">{row.label}</span>
                      <span
                        className={`text-[11px] font-mono tabular-nums ${
                          row.value > 0 ? "text-primary-500" : "text-faint"
                        }`}
                      >
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>

                <div>
                  <p className="text-[11px] text-muted pb-1">{t("占用的快捷键")}</p>
                  <p className="text-[11px] text-faint font-mono break-all">
                    {diag.shortcuts.length > 0 ? diag.shortcuts.join(" · ") : t("（没有）")}
                  </p>
                </div>

                {diag.shortcutFailures.length > 0 && (
                  <div>
                    <p className="text-[11px] text-muted pb-1">{t("注册失败的全局快捷键")}</p>
                    <p className="text-[11px] text-danger font-mono break-all">
                      {diag.shortcutFailures.join(" · ")}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-[11px] text-muted pb-1">{t("已授予的权限")}</p>
                  <p className="text-[11px] text-faint font-mono break-all">
                    {diag.permissions.length > 0 ? diag.permissions.join(" · ") : t("（无）")}
                  </p>
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-[11px] text-faint">
                {diagBusy ? t("正在读取插件注册信息…") : t("没有读到诊断信息")}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              {/* 原地重读：不关弹窗，停用中的插件仍是「临时加载 → 采集 → 停回去」 */}
              <button
                onClick={() => void handleDiagReload()}
                disabled={diagBusy}
                className="btn-ghost px-4 py-2 text-sm disabled:opacity-50"
              >
                {diagBusy ? t("读取中…") : t("重新加载")}
              </button>
              <button onClick={() => setDiagTarget(null)} className="btn-ghost px-4 py-2 text-sm">
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
