/**
 * 设置域：软件设置（app.config.*）、主题、语义索引状态与统一设置窗口。
 *
 * 状态全部由本 hook 持有，App 只负责把排序 / 布局等运行时状态写回各自域。
 * 持久化仍交给 stores；这里只做启动读库、逐项写库与重置。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "@/interface/settings/settings";
import type { SettingsSection } from "@/interface/settings/settingsModal";
import type { ThemeSettings } from "@/interface/settings/theme";
import type { ConfirmOptions } from "@/interface/app/ui";
import { DEFAULT_THEME_SETTINGS } from "@/config/theme/themes";
import { applyTheme, cacheTheme, readCachedTheme } from "@/lib/theme/theme";
import { setResolvedThemeMode } from "@/lib/theme/themeRuntime";
import {
  flushThemeSettings,
  loadThemeSettings,
  resetThemeSettings,
  saveThemeSettings,
} from "@/stores/themeStore";
import { DEFAULT_APP_SETTINGS } from "@/config/app/appDefaults";
import {
  loadAppSettings,
  saveAllAppSettings,
  saveAppSetting,
  resetAppSettings,
  resetEditorSettings,
} from "@/stores/appSettingsStore";
import * as notesApi from "@/api/note/notes";
import * as settingsApi from "@/api/settings/settings";
import * as semanticApi from "@/api/ai/semantic";
import { setLanguage, t as translateNow, useI18n } from "@/i18n";
import { setLinkOpenTarget } from "@/lib/app/externalLink";
import { schedulePeriodicCheck, scheduleStartupCheck } from "@/stores/updaterStore";
import { useToast } from "@/components/common/Toast";

/** 启动读库后需要同步的其它域运行时状态（由 App 注入，避免循环依赖） */
export interface SettingsRuntime {
  setSortBy: (value: string) => void;
  setSortOrder: (value: "asc" | "desc") => void;
  setIsSidebarCollapsed: (value: boolean) => void;
  setAiPanelOpen: (value: boolean) => void;
}

export interface UseSettingsStateParams {
  /** 全局唯一的确认弹窗（由 App 持有，不能在多个 hook 里各自 useConfirm） */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  runtime: SettingsRuntime;
}

export function useSettingsState({ confirm, runtime }: UseSettingsStateParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /** 软件设置：启动读库，读不到的键回退默认值 */
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  /** 软件设置是否已从数据库读回：读回前不碰开机启动快捷方式，避免用默认值覆盖用户设置 */
  const [appSettingsLoaded, setAppSettingsLoaded] = useState(false);
  /** 统一设置窗口：null 表示关闭，否则为打开时的分区 */
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  /** 语义索引是否在后台构建：只为搜索框下的提示，开启语义搜索后才订阅 */
  const [semanticIndexing, setSemanticIndexing] = useState(false);
  /**
   * 主题设置：初值取 localStorage 的快照（首帧不闪），随后被数据库的值覆盖。
   * 落库在 app.config.theme.settings 一个键里，见 stores/themeStore.ts。
   */
  const [theme, setTheme] = useState<ThemeSettings>(() => readCachedTheme() ?? DEFAULT_THEME_SETTINGS);

  useEffect(() => {
    if (!appSettingsLoaded) return;
    setLanguage(appSettings.general.language);
    // 链接打开方式同样是模块级运行时状态：同步给所有非 React 消费方的打开入口
    setLinkOpenTarget(appSettings.general.linkOpenTarget);
  }, [
    appSettings.general.language,
    appSettings.general.linkOpenTarget,
    appSettingsLoaded,
  ]);

  /**
   * 启动读软件设置：优先读库，缺键回退 config/appDefaults.ts 的默认值。
   * 读回后一次性对齐排序、侧栏折叠、AI 面板等运行时状态；
   * 「启动时清空回收站」属于启动动作，只在这里执行一次。
   */
  useEffect(() => {
    let cancelled = false;
    loadAppSettings()
      .then((settings) => {
        if (cancelled) return;
        setAppSettings(settings);
        setAppSettingsLoaded(true);
        runtime.setSortBy(settings.view.sortBy);
        runtime.setSortOrder(settings.view.sortOrder);
        runtime.setIsSidebarCollapsed(settings.layout.sidebarCollapsed);
        runtime.setAiPanelOpen(settings.layout.aiPanelOpen);
        if (settings.general.cleanTrashOnStartup) {
          // 清空回收站：永久删除里面的全部笔记（仅在启动时执行一次）
          notesApi
            .getTrashNotes()
            .then((list) =>
              list.length > 0 ? notesApi.deleteMultipleNotesPermanently(list.map((n) => n.id)) : undefined,
            )
            .catch((e) => console.error("清空回收站失败：", e));
        }
      })
      .catch((e) => console.error("读取软件设置失败，使用默认值：", e));
    return () => { cancelled = true; };
    // 与重构前一致：只在挂载时读取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 主题读库：启动时异步补上，读回后覆盖缓存快照 */
  useEffect(() => {
    let cancelled = false;
    loadThemeSettings()
      .then((loaded) => {
        if (!cancelled) setTheme(loaded);
      })
      .catch((e) => console.error("读取主题设置失败，使用默认主题：", e));
    return () => { cancelled = true; };
  }, []);

  /**
   * 应用主题：把令牌写进 <html> 的 CSS 变量，并同步给需要按明暗分支的组件。
   * 依赖 theme 本身，因此任何一次取色都会立刻反映到整个界面（含设置窗口）。
   * cacheTheme 写的是首帧快照，只为下次启动时不闪白。
   */
  useEffect(() => {
    setResolvedThemeMode(applyTheme(theme));
    cacheTheme(theme);
  }, [theme]);

  /** 兜底：组件卸载时把还没落库的主题改动冲下去 */
  useEffect(() => () => { void flushThemeSettings(); }, []);

  /** 主题整对象回写：立即生效（上面的 effect）并落库 */
  const handleThemeChange = useCallback((next: ThemeSettings) => {
    setTheme(next);
    void saveThemeSettings(next);
  }, []);

  /**
   * 写入软件设置：更新内存状态并实时持久化到数据库。
   * 「实时生效」的项在这里额外同步运行时状态；「重启生效」的项（布局）只落库，不动当前界面。
   */
  const applyAppSetting = useCallback(
    (category: keyof AppSettings, field: string, value: boolean | number | string) => {
      setAppSettings((prev) => ({ ...prev, [category]: { ...prev[category], [field]: value } }));
      saveAppSetting(category as never, field as never, value as never);
      // 笔记列表排序需要立刻反映到运行时状态，否则要刷新后才会生效
      if (category === "view") {
        if (field === "sortBy") runtime.setSortBy(value as string);
        if (field === "sortOrder") runtime.setSortOrder(value as "asc" | "desc");
      }

      // 托盘图标变更：交由 Rust 侧创建/移除（托盘生命周期不归 webview 管）
      if (category === "general" && field === "trayEnabled") {
        settingsApi.setTrayEnabled(value as boolean).catch((e) => {
          console.error("切换托盘图标失败：", e);
        });
      }
    },
    [runtime],
  );

  // 单实例、托盘、关闭到托盘、开机启动都由 Rust 侧处理（见 src-tauri/src/lib.rs）：
  // 前端不持有托盘图标、不监听窗口关闭事件，窗口隐藏后即使 JS 失联也不影响托盘。

  /**
   * 开机自启动：只有开关真正翻转时才创建/删除启动文件夹快捷方式。
   * 首次读回不写（Rust 的 sync_autostart_shortcut 会补齐缺失项）；
   * 「开机后最小化到托盘」不进快捷方式，因此切换它不会重写快捷方式。
   */
  const prevAutostartRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!appSettingsLoaded) return;
    const { autostart } = appSettings.general;
    const prev = prevAutostartRef.current;
    prevAutostartRef.current = autostart;
    if (prev === null || prev === autostart) return;
    settingsApi.setAutostart(autostart);
  }, [appSettingsLoaded, appSettings.general.autostart]);

  /**
   * 语义索引状态：只影响「索引构建中」提示，因此不必轮询。
   * 开工时 worker 会发 running=true 的进度事件，收尾发 done 事件；事件丢失则由首次状态查询兜底。
   */
  useEffect(() => {
    if (!appSettingsLoaded || !appSettings.general.semanticSearch) {
      setSemanticIndexing(false);
      return;
    }
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const status = await semanticApi.getSemanticStatus();
        if (!disposed) setSemanticIndexing(status.indexing);
      } catch {
        // 状态查询失败不影响搜索本身，下次索引事件仍会更新提示
      }
      const offProgress = await semanticApi.onSemanticIndexProgress((progress) =>
        setSemanticIndexing(progress.running),
      );
      const offDone = await semanticApi.onSemanticIndexDone(() => setSemanticIndexing(false));
      if (disposed) {
        offProgress();
        offDone();
      } else {
        unlisteners.push(offProgress, offDone);
      }
    })();
    return () => {
      disposed = true;
      unlisteners.forEach((off) => off());
    };
  }, [appSettingsLoaded, appSettings.general.semanticSearch]);

  /** 启动后静默检查一次更新：只更新状态层，不弹 Toast、不自动下载 */
  useEffect(() => {
    if (!appSettingsLoaded) return;
    scheduleStartupCheck();
  }, [appSettingsLoaded]);

  /**
   * 运行期间的定时检查：按设置里的间隔静默探测，设置改动立即重建计时器。
   * 0 = 关闭；卸载或间隔变化时先清掉旧计时器，避免两个间隔同时跑。
   */
  useEffect(() => {
    if (!appSettingsLoaded) return;
    schedulePeriodicCheck(appSettings.general.updateCheckIntervalMinutes);
    return () => schedulePeriodicCheck(0);
  }, [appSettingsLoaded, appSettings.general.updateCheckIntervalMinutes]);

  /** 打开统一设置窗口，并定位到指定分区 */
  const openSettings = useCallback((section: SettingsSection = "general") => {
    setSettingsSection(section);
    setShowSettings(true);
  }, []);

  /** 恢复软件默认设置：删库里全部 app.config.* 键，运行时状态同步回默认 */
  const handleResetAppSettings = useCallback(async () => {
    const ok = await confirm({
      title: t("恢复软件默认设置"),
      message: t("将把通用（含托盘图标、关闭窗口行为、开机自启动）、编辑器、笔记列表、界面布局、主题等软件设置恢复为默认值（AI 设置不受影响）。"),
      confirmText: t("恢复默认"),
      danger: true,
    });
    if (!ok) return;
    // 先清掉主题的防抖写入，避免删除后计时器又把旧主题写回去
    await resetThemeSettings();
    await resetAppSettings();
    const d = DEFAULT_APP_SETTINGS;
    setAppSettings(d);
    // 默认值也写回库：库里始终保有一份完整设置，读库时不必每次都补写
    await saveAllAppSettings(d);
    // 主题也存在 app.config.* 前缀下，已被删除，运行时同步回默认
    setTheme(DEFAULT_THEME_SETTINGS);
    // 排序是实时生效项，立即同步；布局是启动项，只落默认值、下次启动才应用
    runtime.setSortBy(d.view.sortBy);
    runtime.setSortOrder(d.view.sortOrder);
    showToast(translateNow("已恢复软件默认设置"), "success");
  }, [confirm, showToast, runtime, t]);

  /** 只恢复编辑器设置：其他软件设置、主题与 AI 设置都不动 */
  const handleResetEditorSettings = useCallback(async () => {
    const ok = await confirm({
      title: t("恢复编辑器默认设置"),
      message: t("将把字号、行高、间距、工具栏、颜色预设等编辑器选项恢复为默认值。主题、其他软件设置与 AI 设置不受影响。"),
      confirmText: t("恢复默认"),
      danger: true,
    });
    if (!ok) return;
    await resetEditorSettings();
    setAppSettings((prev) => ({ ...prev, editor: { ...DEFAULT_APP_SETTINGS.editor } }));
    showToast(t("已恢复编辑器默认设置"), "success");
  }, [confirm, showToast, t]);

  /** 只恢复主题设置：其他软件设置与 AI 设置都不动 */
  const handleResetThemeSettings = useCallback(async () => {
    const ok = await confirm({
      title: t("恢复主题默认设置"),
      message: t("将把明暗模式、预设配色、自定义取色与「我的主题」恢复为默认值。其他软件设置与 AI 设置不受影响。"),
      confirmText: t("恢复默认"),
      danger: true,
    });
    if (!ok) return;
    await resetThemeSettings();
    setTheme(DEFAULT_THEME_SETTINGS);
    showToast(t("已恢复主题默认设置"), "success");
  }, [confirm, showToast, t]);

  return {
    appSettings,
    appSettingsLoaded,
    showSettings,
    setShowSettings,
    settingsSection,
    semanticIndexing,
    theme,
    setTheme,
    applyAppSetting,
    openSettings,
    handleResetAppSettings,
    handleResetEditorSettings,
    handleResetThemeSettings,
    handleThemeChange,
  };
}
