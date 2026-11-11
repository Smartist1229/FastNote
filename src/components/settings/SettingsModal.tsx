import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  SectionMeta,
  SettingRow,
  SettingsModalProps,
  SettingsSection,
} from "@/interface/settings/settingsModal";
import { SETTINGS_SECTIONS } from "@/config/app/settingsSections";
import { Icon } from "@/components/common/Icon";
import { useDraggable } from "@/components/common/useDraggable";
import { useI18n } from "@/i18n";
import type { SettingsSectionContext } from "@/features/settings/context";
import {
  SECTION_RENDERERS,
  buildSettingRows,
  sectionSearchText,
} from "@/features/settings/registry";
import { groupKey } from "@/features/settings/sectionRows";
import { PluginSectionView } from "@/features/settings/sections/pluginSection";
import { PluginIcon } from "@/features/settings/PluginIcon";
import { pluginHost } from "@/plugins/host";
import { usePluginContributions, type PluginSettingsSectionEntry } from "@/plugins/contributions";

/**
 * 统一设置窗口（外壳）。
 *
 * 职责：左侧分区目录与右侧设置项的外壳，收集改动后上抛，不直接写库。
 * 落库路径：软件设置由 onAppSettingChange 交给 App 的 applyAppSetting 立即写单键；
 * AI 设置交给 App 的 effect 逐项 diff 后写库。两者都落在 SQLite 的 app_settings 表。
 *
 * 分区内容由 features/settings 的注册表提供：
 *   1. 打开时清空搜索、切到 defaultSection，并向 Tauri 取应用名与版本；
 *   2. **一次只渲染一个分区**（目录点选切换）：几百行设置项全量挂载会让打开明显变慢，
 *      ThemePanel / 服务商 / 访问权限这些子面板也会跟着空跑；
 *   3. 搜索同时匹配数据行的 title/desc/keywords 与分区关键词表，命中数标在目录上；
 *   4. 徽标目录见 config/app/settingBadges.json：live 立即生效，startup 只影响下次启动时的初始状态。
 */

/** AI 专属分区：enableAI 为 false 时整组隐藏，避免出现点了没反应的入口 */
const AI_SECTION_KEYS: SettingsSection[] = [
  "semantic",
  "provider",
  "chat",
  "context",
  "memory",
  "access",
];

/** 分区元数据在 config 里定义（命令面板复用）；这里只做本地别名 */
const SECTIONS = SETTINGS_SECTIONS;

/** 目录分组顺序：与 SECTIONS 里的 group 对应，空分组在渲染时自动跳过 */
const ALL_GROUPS: SectionMeta["group"][] = ["常规", "界面", "AI", "数据", "其他"];

/** 关闭 AI 能力时，「AI」分组整体不渲染 */
const getVisibleGroups = (enableAI: boolean): SectionMeta["group"][] =>
  enableAI ? ALL_GROUPS : ["常规", "界面", "数据", "其他"];

/** 插件设置分区在目录 / 状态里用的合成 key：`plugin:<dirName>:<sectionId>`（dirName 与 id 都不含冒号） */
const pluginSectionKey = (entry: PluginSettingsSectionEntry): string =>
  `plugin:${entry.pluginId}:${entry.section.id}`;

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  defaultSection,
  appSettings,
  onAppSettingChange,
  onResetAppSettings,
  onResetEditorSettings,
  onResetThemeSettings,
  aiSettings,
  onAiSettingsChange,
  aiProviders,
  aiSelectedProviderId,
  onAiProvidersChange,
  onAiSelectedProviderChange,
  aiPrompts,
  onAiPromptsChange,
  categories = [],
  notes = [],
  onSetCategoryAiAccess,
  onSetNoteAiAccess,
  theme,
  onThemeChange,
  onRequestRootPasswordChange,
}) => {
  const { t } = useI18n();

  /** 搜索关键词：非空时只渲染命中的分区与行 */
  const [query, setQuery] = useState("");
  /**
   * 当前显示的分区。**一次只渲染这一个**：设置项加起来有几百行，全量挂载既拖慢打开速度，
   * 也会让 ThemePanel / 服务商 / 访问权限这些带副作用的子面板白白运行。
   * 类型是 string：内置分区是 SettingsSection 枚举，插件分区用 plugin:<dirName>:<id> 合成 key。
   */
  const [active, setActive] = useState<string>(defaultSection ?? "general");
  /** 当前分区里滚到的二级分组（目录里的子项高亮），null 表示还在最上面 */
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  /** 右侧滚动容器：切换分区时归零，也用于滚动反查二级分组 */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 当前分区内各分组段的节点：二级目录跳转与高亮反查都靠它 */
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});
  /** 左侧目录容器（高亮项自动滚进可视区） */
  const navRef = useRef<HTMLElement>(null);
  /** 滚动事件的 rAF 句柄：一帧只反查一次，避免高频 setState */
  const scrollRafRef = useRef<number | null>(null);

  /* 顶部「已保存」提示：平时隐藏，发生修改后短暂出现 */
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimerRef = useRef<number | null>(null);
  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    // 连续修改时不叠加定时器，只把消失时间往后推
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      setSavedFlash(false);
      savedTimerRef.current = null;
    }, 2000);
  }, []);

  /** 写软件设置：改动立即上抛（App 侧同步运行时状态并落库），并闪一下「已保存」 */
  const setApp = useCallback(
    <K extends keyof typeof appSettings>(
      category: K,
      field: keyof (typeof appSettings)[K],
      value: boolean | number | string,
    ) => {
      onAppSettingChange(category, field as string, value);
      flashSaved();
    },
    [onAppSettingChange, flashSaved],
  );

  /** 写 AI 设置：整个对象上抛，App 侧 diff 出真正变化的字段再落库 */
  const setAi = useCallback(
    <K extends keyof typeof aiSettings>(field: K, value: (typeof aiSettings)[K]) => {
      onAiSettingsChange({ ...aiSettings, [field]: value });
      flashSaved();
    },
    [aiSettings, onAiSettingsChange, flashSaved],
  );

  /**
   * 数据驱动的设置行：文案、搜索关键词、当前值与写回回调在 features/settings/sections 里声明，
   * 这里按分区聚合成一份，供搜索与命中计数使用。
   */
  const rowsCtx = useMemo(
    () => ({ appSettings, aiSettings, aiProviders, setApp, setAi }),
    [appSettings, aiSettings, aiProviders, setApp, setAi],
  );
  const rows: SettingRow[] = useMemo(() => buildSettingRows(rowsCtx), [rowsCtx]);

  /* 搜索过滤：q 为归一化后的关键词，空串表示不过滤 */
  const q = query.trim().toLowerCase();
  const providerNames = useMemo(() => aiProviders.map((p) => p.name), [aiProviders]);

  /* 插件贡献的设置分区：门面订阅注册表版本，插件启停 / 重激活时自动刷新目录 */
  const contributions = usePluginContributions();
  const pluginSections = useMemo(() => contributions.settingsSections(), [contributions.version]);
  /** 插件实例的图标 URL（dirName → iconUrl）；设置分区用 dirName 作为插件 id */
  const pluginEntries = useSyncExternalStore(pluginHost.subscribe, pluginHost.snapshot);
  const pluginIconUrlByDir = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const entry of pluginEntries) map.set(entry.dirName, entry.iconUrl);
    return map;
  }, [pluginEntries]);
  /** 搜索时按分区标题过滤插件分区（插件分区没有行级关键词） */
  const visiblePluginSections = useMemo(
    () =>
      pluginSections.filter(
        (e) => !q || `${e.section.title} ${t(e.section.title)}`.toLowerCase().includes(q),
      ),
    [pluginSections, q, t],
  );
  /**
   * 目录里的插件分区按插件聚合（保持注册顺序）：
   * 1 个分区直接平铺一行；2 个及以上先给一个可点击的插件父级（点击选中首个分区），
   * 再缩进列出各分区。
   */
  const pluginNavGroups = useMemo(() => {
    const byPlugin = new Map<
      string,
      {
        pluginId: string;
        pluginName: string;
        iconUrl?: string;
        sections: PluginSettingsSectionEntry[];
      }
    >();
    for (const entry of visiblePluginSections) {
      const group = byPlugin.get(entry.pluginId);
      if (group) group.sections.push(entry);
      else
        byPlugin.set(entry.pluginId, {
          pluginId: entry.pluginId,
          pluginName: entry.pluginName,
          iconUrl: pluginIconUrlByDir.get(entry.pluginId),
          sections: [entry],
        });
    }
    return Array.from(byPlugin.values());
  }, [visiblePluginSections, pluginIconUrlByDir]);

  /** 单行是否命中搜索：标题、说明、分组名、关键词与选项文案都参与匹配 */
  const matchesRow = useCallback(
    (r: SettingRow) =>
      `${r.title} ${t(r.title)} ${r.desc} ${t(r.desc)} ${r.group ? t(r.group) : ""} ${r.keywords ?? ""} ${"options" in r ? r.options.map((o) => t(o.label)).join(" ") : ""}`.toLowerCase().includes(q),
    [q, t],
  );

  /**
   * 可见分区：先按 enableAI 剔除 AI 分区，再按搜索词过滤。
   * 自定义面板匹配「分区名 + 关键词表」，普通分区只要任一子行命中就整段保留。
   */
  const visibleSections = useMemo(
    () =>
      SECTIONS.filter((s) => {
        if (!appSettings.general.enableAI && AI_SECTION_KEYS.includes(s.key)) {
          return false;
        }
        if (!q || `${s.label} ${t(s.label)}`.toLowerCase().includes(q)) return true;
        if (`${s.label} ${t(s.label)} ${sectionSearchText(s.key, providerNames)}`.toLowerCase().includes(q)) {
          return true;
        }
        return rows.some((r) => r.section === s.key && matchesRow(r));
      }),
    [q, rows, providerNames, matchesRow, appSettings.general.enableAI, t],
  );

  /** 某分区下命中搜索的行；没有关键词时返回该分区全部行 */
  const visibleRowsOf = useCallback(
    (section: SettingsSection) =>
      rows.filter(
        (r) =>
          r.section === section &&
          (!q || SECTIONS.some((s) => s.key === section && `${s.label} ${t(s.label)}`.toLowerCase().includes(q)) || matchesRow(r)),
      ),
    [rows, q, t, matchesRow],
  );

  /** 分区的二级分组（按行顺序去重）；空数组表示这个分区在目录里是叶子节点 */
  const groupsOf = useCallback(
    (section: SettingsSection) => {
      const out: string[] = [];
      for (const row of visibleRowsOf(section)) {
        if (row.group && !out.includes(row.group)) out.push(row.group);
      }
      return out;
    },
    [visibleRowsOf],
  );

  /**
   * 右侧实际渲染的分区：**只有一个**（当前选中的那个）。
   * 搜索把当前分区过滤掉时先渲染第一个命中的，随后的 effect 会把 active 同步过去。
   * active 是插件分区时这里返回空数组，内容区改渲染 PluginSectionView。
   */
  const activePluginEntry = visiblePluginSections.find((e) => pluginSectionKey(e) === active);
  const shownSections = useMemo(() => {
    if (activePluginEntry) return [];
    const meta = visibleSections.find((s) => s.key === active) ?? visibleSections[0];
    return meta ? [meta] : [];
  }, [visibleSections, active, activePluginEntry]);

  /* 打开时：重置搜索与滚动位置，并切到目标分区 */
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSavedFlash(false);
    setActive(defaultSection ?? "general");
    setActiveGroup(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [isOpen, defaultSection]);

  /* 搜索变化后，把高亮收回到首个可见分区（内置优先，其次插件分区） */
  useEffect(() => {
    if (!isOpen) return;
    if (visibleSections.length === 0 && visiblePluginSections.length === 0) return;
    const activeVisible =
      visibleSections.some((s) => s.key === active) ||
      visiblePluginSections.some((e) => pluginSectionKey(e) === active);
    if (!activeVisible) {
      const first =
        visibleSections[0]?.key ??
        (visiblePluginSections[0] ? pluginSectionKey(visiblePluginSections[0]) : undefined);
      if (first) setActive(first);
    }
  }, [visibleSections, visiblePluginSections, isOpen, active]);

  /**
   * 切换分区：右侧换内容、滚动位置归零。
   * 只渲染当前分区，所以这里不需要"滚动到锚点"，只要把容器拉回顶部。
   */
  const selectSection = useCallback((key: string) => {
    setActive(key);
    setActiveGroup(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  /* 滚动监听：只反查当前分区内的二级分组，让目录里的子项高亮跟着走 */
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = contentRef.current;
      if (!container) return;
      const groups = groupsOf(active as SettingsSection);
      if (groups.length === 0) {
        setActiveGroup(null);
        return;
      }
      const top = container.scrollTop + 20;
      let group: string | null = null;
      for (const name of groups) {
        const el = groupRefs.current[groupKey(active as SettingsSection, name)];
        if (el && el.offsetTop <= top) group = name;
      }
      setActiveGroup(group);
    });
  }, [active, groupsOf]);

  /** 二级目录：跳到当前分区里的某个分组 */
  const scrollToGroup = useCallback((section: SettingsSection, group: string) => {
    const container = contentRef.current;
    const el = groupRefs.current[groupKey(section, group)];
    if (!container || !el) return;
    setActiveGroup(group);
    container.scrollTo({ top: Math.max(0, el.offsetTop - 8) });
  }, []);

  /** 高亮项自动滚进目录可视区（分组很多时，滚到下面的分区目录也能跟得上） */
  useEffect(() => {
    if (!isOpen) return;
    const nav = navRef.current;
    const selector = activeGroup ? `[data-nav-key="${active}:${activeGroup}"]` : `[data-nav-key="${active}"]`;
    const el = nav?.querySelector<HTMLElement>(selector);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, activeGroup, isOpen]);

  /* 卸载时清掉挂起的 rAF 与 timer，避免回调打到已卸载的组件上 */
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  // 非模态浮窗：标题栏拖动挪位置（不落库，关掉再开回到居中）
  const drag = useDraggable(isOpen);

  // 所有 hook 都已执行完，关闭时直接不渲染（保留组件状态，下次打开不闪）
  if (!isOpen) return null;

  /** 分区渲染所需的全部上下文：值与回调都从 Props 原样转交 */
  const ctx: SettingsSectionContext = {
    isOpen,
    onClose,
    appSettings,
    aiSettings,
    setApp,
    setAi,
    onAppSettingChange,
    onResetAppSettings,
    onResetEditorSettings,
    onResetThemeSettings,
    aiProviders,
    aiSelectedProviderId,
    onAiProvidersChange,
    onAiSelectedProviderChange,
    aiPrompts,
    onAiPromptsChange,
    categories,
    notes,
    onSetCategoryAiAccess,
    onSetNoteAiAccess,
    theme,
    onThemeChange,
    onAiSettingsChange,
    onRequestRootPasswordChange,
    rowsOf: visibleRowsOf,
    groupRefs,
    flashSaved,
    /** 插件管理分区的「配置」按钮：清掉搜索保证目标分区在目录里可见，再切过去 */
    onOpenPluginSection: (key) => {
      setQuery("");
      selectSection(key);
    },
  };

  /**
   * 目录里一条插件分区按钮：
   * - single：单个分区的插件直接平铺，保留 section 图标（缺省回落插件图标）；
   * - child：多分区插件的二级子项，样式与「编辑器」子项一致。
   */
  const pluginSectionButton = (
    entry: PluginSettingsSectionEntry,
    variant: "single" | "child",
    pluginIconUrl?: string,
  ) => {
    const key = pluginSectionKey(entry);
    const isActive = active === key;
    const iconOpacity = variant === "single" && !isActive ? "opacity-70" : "";
    const icon = entry.section.icon ? (
      <Icon name={entry.section.icon} className={`w-3.5 h-3.5 flex-shrink-0 ${iconOpacity}`} />
    ) : (
      <PluginIcon url={pluginIconUrl} size={14} className={iconOpacity} />
    );

    if (variant === "child") {
      return (
        <button
          key={key}
          data-nav-key={key}
          onClick={() => selectSection(key)}
          className={`w-full flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs ${
            isActive
              ? "bg-primary-50 text-primary-600"
              : "text-faint hover:bg-surface-alt/70 hover:text-body"
          }`}
        >
          {icon}
          <span className="min-w-0 break-words">{t(entry.section.title)}</span>
          {isActive && (
            <span className="ml-auto w-1 h-1 rounded-full bg-primary-500 flex-shrink-0" />
          )}
        </button>
      );
    }

    return (
      <button
        key={key}
        data-nav-key={key}
        onClick={() => selectSection(key)}
        className={`w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-xs font-medium ${
          isActive ? "bg-primary-50 text-primary-600" : "text-muted hover:bg-surface-alt/70"
        }`}
      >
        {icon}
        <span className="min-w-0 text-left break-words">{t(entry.section.title)}</span>
        {isActive && (
          <span className="ml-auto w-1 h-1 rounded-full bg-primary-500 flex-shrink-0" />
        )}
      </button>
    );
  };

  return (
    <>
      {/* 非模态：不铺遮罩、整层 pointer-events 关掉，只有卡片本身可点——
          开着设置也能继续看笔记、点列表；点窗外不会关闭，关闭走按钮或 Esc */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={drag.panelRef}
          className="modal-content floating-panel pointer-events-auto bg-surface rounded-2xl w-[860px] h-[600px] max-w-[94vw] max-h-[92vh] flex flex-col overflow-hidden"
          style={drag.style}
        >
          {/* 头部：标题 + 自动保存提示（aria-live 供读屏播报）+ 关闭；按住可拖动窗口 */}
          <div
            className="flex items-center justify-between px-5 py-3.5 border-b border-line-soft flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
            onPointerDown={drag.startDrag}
          >
            <div className="flex items-center gap-2">
              <Icon name="ai-settings-bold" className="w-4 h-4 text-primary-500" />
              <h3 className="text-base font-semibold text-ink">{t("设置")}</h3>
            </div>
            <div className="flex items-center gap-3">
              <span
                aria-live="polite"
                className={`hidden sm:flex items-center gap-1.5 text-[11px] text-faint transition-opacity duration-500 ${
                  savedFlash ? "opacity-100" : "opacity-0"
                }`}
              >
                <Icon name="editor-check" className="w-3 h-3 text-success" />
                {t("更改已自动保存")}</span>
              <button onClick={onClose} className="toolbar-btn hover:bg-surface-alt!" title={t("关闭设置")}>
                <Icon name="modal-close" className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* 左侧目录：搜索框 + 分组导航，空分组不渲染 */}
            <div className="w-[186px] flex-shrink-0 border-r border-line-soft flex flex-col bg-app/40">
              <div className="p-2.5 flex-shrink-0">
                <div className="relative">
                  <Icon
                    name="sidebar-search"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint-soft pointer-events-none"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("搜索设置...")}
                    className="w-full pl-8 pr-2 py-1.5 text-xs input-modern"
                  />
                </div>
              </div>
              <nav ref={navRef} className="flex-1 overflow-y-auto chat-scrollbar px-2 pb-3">
                {getVisibleGroups(appSettings.general.enableAI).map((group) => {
                  const items = visibleSections.filter((s) => s.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div key={group} className="mb-1">
                      <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold text-faint-soft uppercase tracking-wider">
                        {t(group)}
                      </div>
                      {items.map((s) => {
                        const isActive = active === s.key;
                        // 二级项只列当前分区的：一次只显示一个分区，别的分区的子项没有落点
                        const subGroups = isActive ? groupsOf(s.key) : [];
                        // 搜索时把命中条数标在没被选中的分区上，省得一个个点开找
                        const hits = q ? visibleRowsOf(s.key).length : 0;
                        return (
                          <div key={s.key}>
                            <button
                              data-nav-key={s.key}
                              onClick={() => selectSection(s.key)}
                              className={`w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-xs font-medium ${
                                isActive ? "bg-primary-50 text-primary-600" : "text-muted hover:bg-surface-alt/70"
                              }`}
                            >
                              <Icon
                                name={s.icon}
                                className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "opacity-100" : "opacity-70"}`}
                              />
                              <span className="min-w-0 text-left truncate">{t(s.label)}</span>
                              {hits > 0 && !isActive && (
                                <span className="ml-auto flex-shrink-0 text-[10px] text-faint-soft">{hits}</span>
                              )}
                              {/* 叶子分区用圆点标记当前项 */}
                              {isActive && subGroups.length === 0 && (
                                <span className="ml-auto w-1 h-1 rounded-full bg-primary-500 flex-shrink-0" />
                              )}
                            </button>
                            {subGroups.length > 0 && (
                              <div className="mt-0.5 mb-1 ml-[18px] border-l border-line-soft pl-1.5">
                                {subGroups.map((name) => {
                                  const on = activeGroup === name;
                                  return (
                                    <button
                                      key={name}
                                      data-nav-key={`${s.key}:${name}`}
                                      onClick={() => scrollToGroup(s.key, name)}
                                      className={`w-full text-left px-2 py-[5px] rounded-md text-[11px] truncate ${
                                        on
                                          ? "bg-primary-50 text-primary-600 font-medium"
                                          : "text-faint hover:bg-surface-alt/70 hover:text-body"
                                      }`}
                                    >
                                      {t(name)}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {/* 插件分区：追加在原有分区之后，单独一组「插件」；同一插件多分区时聚合为二级菜单 */}
                {pluginNavGroups.length > 0 && (
                  <div className="mb-1">
                    <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold text-faint-soft uppercase tracking-wider">
                      {t("插件")}
                    </div>
                    {pluginNavGroups.map((group) => {
                      if (group.sections.length === 1) {
                        // 单分区插件：与旧布局完全一致，不显示父级
                        return (
                          <div key={group.pluginId}>
                            {pluginSectionButton(group.sections[0], "single", group.iconUrl)}
                          </div>
                        );
                      }
                      const groupActive = group.sections.some(
                        (entry) => pluginSectionKey(entry) === active,
                      );
                      return (
                        <div key={group.pluginId}>
                          {/* 父级与「编辑器」父项同一套样式：点击选中第一个分区 */}
                          <button
                            onClick={() => selectSection(pluginSectionKey(group.sections[0]))}
                            className={`w-full flex items-center gap-1.5 px-2.5 py-[7px] rounded-lg text-xs font-medium ${
                              groupActive
                                ? "bg-primary-50 text-primary-600"
                                : "text-muted hover:bg-surface-alt/70"
                            }`}
                          >
                            <PluginIcon
                              url={group.iconUrl}
                              size={16}
                              className={groupActive ? "opacity-100" : "opacity-70"}
                            />
                            <span className="min-w-0 text-left truncate">{group.pluginName}</span>
                          </button>
                          <div className="mt-0.5 mb-1 ml-[18px] border-l border-line-soft pl-1.5">
                            {group.sections.map((entry) =>
                              pluginSectionButton(entry, "child", group.iconUrl),
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {visibleSections.length === 0 && visiblePluginSections.length === 0 && (
                  <p className="px-3 py-6 text-center text-[11px] text-faint">{t("没有匹配的设置项")}</p>
                )}
              </nav>
            </div>

            {/* 右侧内容：只挂载当前分区；滚动时反查本分区内的二级分组 */}
            <div
              ref={contentRef}
              onScroll={handleScroll}
              className="relative flex-1 min-w-0 overflow-y-auto chat-scrollbar px-6 py-5"
            >
              {shownSections.length === 0 && !activePluginEntry ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-faint">
                  <Icon name="sidebar-search" className="w-8 h-8 text-faint-soft" />
                  <p className="text-sm">{t("没有找到相关设置")}</p>
                  <p className="text-[11px] text-faint-soft">{t("换个关键词试试")}</p>
                </div>
              ) : activePluginEntry ? (
                <section data-section={active} className="animate-fadeIn [&>*+*]:pl-8">
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-line-soft">
                    <span className="w-6 h-6 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                      <Icon
                        name={activePluginEntry.section.icon ?? "toolbox"}
                        className="w-3.5 h-3.5 text-primary-500"
                      />
                    </span>
                    <h4 className="text-sm font-semibold text-body">{t(activePluginEntry.section.title)}</h4>
                  </div>
                  <PluginSectionView entry={activePluginEntry} />
                </section>
              ) : (
                shownSections.map((s) => (
                  <section key={s.key} data-section={s.key} className="animate-fadeIn [&>*+*]:pl-8">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-line-soft">
                      <span className="w-6 h-6 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                        <Icon name={s.icon} className="w-3.5 h-3.5 text-primary-500" />
                      </span>
                      <h4 className="text-sm font-semibold text-body">{t(s.label)}</h4>
                    </div>
                    {SECTION_RENDERERS[s.key](ctx)}
                  </section>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
