/**
 * AI 域（状态部分）：AI 面板开关 / 挂载、选区引用投递、服务商弹窗状态，
 * 以及 AI 设置与记忆列表（启动读库 + 逐项 diff 写库）。
 *
 * AI 设置读回前（aiConfigLoaded=false）绝不写库，避免默认值覆盖用户数据。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiNoteRefInjection, ChatNoteRef } from "@/interface/ai/aiChat";
import type { AiPromptEntry, AiProvider, AiSettings } from "@/interface/ai/ai";
import { DEFAULT_AI_SETTINGS, normalizeAiSettings } from "@/config/ai/aiDefaults";
import { loadAiConfig, saveSetting, saveAllSettings, savePrompts, ensureSettingsSeeded } from "@/stores/aiSettingsStore";
import { setAiSettingsBridge } from "@/plugins/host";

export interface UseAiStateParams {
  /** AI 总开关：关闭时立即收起面板，且不再自动挂载 */
  enableAI: boolean;
}

export function useAiState({ enableAI }: UseAiStateParams) {
  /** AI 面板是否展开：仅启动时从 layout 恢复，切换本身不写设置 */
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  /** AI 面板首次展开后才挂载：首屏不加载它依赖的 Markdown 渲染层，之后常驻以保留会话状态 */
  const [aiPanelMounted, setAiPanelMounted] = useState(false);
  /**
   * 选区 AI 工具条投递的引用块：润色/翻译/总结会再带一句指令。
   * 只追加到面板草稿里，不自动发送——发车前按回车仍由用户决定。
   */
  const [pendingNoteRef, setPendingNoteRef] = useState<AiNoteRefInjection | null>(null);
  const promptSeqRef = useRef(0);
  /** 服务商列表与当前选中项：由本组件代持，设置弹窗只做展示与回调 */
  const [providerModalProviders, setProviderModalProviders] = useState<AiProvider[]>([]);
  const [providerModalSelectedId, setProviderModalSelectedId] = useState<number>(0);
  /**
   * AI 记忆 / 前置提示词 + AI 全局设置。
   * 全部持久化在 SQLite 的 app_settings 表里：启动时读库，读不到的键回退默认值；
   * 首次运行会把老版本存在 localStorage 的设置自动迁移进库。
   */
  const [aiPrompts, setAiPrompts] = useState<AiPromptEntry[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  /** 设置是否已从数据库读回：读回前不写库，避免用默认值覆盖用户数据 */
  const [aiConfigLoaded, setAiConfigLoaded] = useState(false);

  /**
   * 新建笔记 / 分组时套用的初始 AI 档位（设置里的「新建笔记 / 新建分组默认权限」）。
   * 只决定"创建那一刻"的值，之后各按自己的属性走；取值在 normalizeAiSettings 里收敛到 0–2。
   */
  const defaultNoteAiAccess = aiSettings.defaultNoteAiAccess;
  const defaultCategoryAiAccess = aiSettings.defaultCategoryAiAccess;

  /**
   * 启动即恢复 AI 设置与记忆：读库、缺键回退默认、老版本 localStorage 首次迁移。
   * cancelled 避免 StrictMode 双执行或卸载后 setState；失败也要置 loaded，
   * 否则「读回前不写库」的保护会让设置永远无法保存。
   */
  useEffect(() => {
    let cancelled = false;
    loadAiConfig()
      .then(({ settings, prompts, migrated }) => {
        if (cancelled) return;
        setAiSettings(settings);
        setAiPrompts(prompts);
        setAiConfigLoaded(true);
        // 首次运行：把每个设置项显式写入一行，方便排查"哪一项被改过"
        if (migrated) ensureSettingsSeeded(settings);
      })
      .catch((e) => {
        console.error('读取设置失败，使用默认值：', e);
        if (!cancelled) setAiConfigLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // 设置变化后只写变化的那一项（读回之前不写，避免覆盖库里已有值）
  const prevSettingsRef = useRef<AiSettings | null>(null);
  useEffect(() => {
    if (!aiConfigLoaded) return;
    const prev = prevSettingsRef.current;
    prevSettingsRef.current = aiSettings;
    if (!prev) {
      // 第一次拿到设置：整份写入，保证库里每个键都有一行记录
      saveAllSettings(aiSettings);
      return;
    }
    for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
      if (prev[field] !== aiSettings[field]) saveSetting(field, aiSettings[field]);
    }
  }, [aiSettings, aiConfigLoaded]);

  // 记忆列表变化后写库
  const prevPromptsRef = useRef<AiPromptEntry[] | null>(null);
  useEffect(() => {
    if (!aiConfigLoaded) return;
    const prev = prevPromptsRef.current;
    prevPromptsRef.current = aiPrompts;
    if (!prev) return;                       // 首次读回不入库
    if (JSON.stringify(prev) !== JSON.stringify(aiPrompts)) savePrompts(aiPrompts);
  }, [aiPrompts, aiConfigLoaded]);

  /**
   * 插件桥：把 aiSettings 的读 / 写句柄注册给插件宿主（ctx.ai.updateSettings 走这里），
   * 插件改设置与设置页改动走同一条「改 state → diff 落库」的生效路径。
   */
  const aiSettingsRef = useRef(aiSettings);
  useEffect(() => {
    aiSettingsRef.current = aiSettings;
  }, [aiSettings]);
  useEffect(() => {
    setAiSettingsBridge({
      get: () => aiSettingsRef.current,
      set: (next) => setAiSettings(next),
      load: async () => (await loadAiConfig()).settings,
      defaults: () => DEFAULT_AI_SETTINGS as unknown as Record<string, unknown>,
      normalize: (settings) => normalizeAiSettings(settings as unknown as Record<string, unknown>),
    });
    return () => setAiSettingsBridge(null);
  }, []);

  const handleSelectionAddRef = useCallback((ref: ChatNoteRef, prompt?: string) => {
    promptSeqRef.current += 1;
    setPendingNoteRef({ id: promptSeqRef.current, ref, prompt });
    setAiPanelOpen(true);
  }, []);

  /** 展开/收起 AI 对话面板（只改当前界面，不写设置） */
  const toggleAiPanel = useCallback(() => setAiPanelOpen((open) => !open), []);

  // 关闭 AI 面板：AI 总开关关闭时立即收起，设置项本身由 applyAppSetting 负责落库
  useEffect(() => {
    if (!enableAI && aiPanelOpen) {
      setAiPanelOpen(false);
    }
  }, [enableAI, aiPanelOpen]);

  // 首次展开后挂载 AI 面板；收起不复位，避免丢掉正在进行的会话与草稿
  useEffect(() => {
    if (aiPanelOpen && enableAI) {
      setAiPanelMounted(true);
    }
  }, [aiPanelOpen, enableAI]);

  return {
    aiPanelOpen,
    setAiPanelOpen,
    aiPanelMounted,
    pendingNoteRef,
    handleSelectionAddRef,
    providerModalProviders,
    setProviderModalProviders,
    providerModalSelectedId,
    setProviderModalSelectedId,
    aiPrompts,
    setAiPrompts,
    aiSettings,
    setAiSettings,
    aiConfigLoaded,
    defaultNoteAiAccess,
    defaultCategoryAiAccess,
    toggleAiPanel,
  };
}
