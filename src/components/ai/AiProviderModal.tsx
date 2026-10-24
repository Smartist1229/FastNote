/**
 * AI 服务商配置面板：协议选择、Base URL / API Key 编辑、模型列表拉取与勾选、删除。
 * 只渲染面板本体（不含弹窗外壳），供统一设置窗口的 AI 标签页嵌入。
 *
 * 边界：所有 HTTP 请求都在 Rust 端（fetch_ai_models / send_ai_chat*），这里仅维护表单与列表状态；
 * API Key 没有独立的校验接口，"Key 是否可用"是通过拉取模型或首次请求失败暴露的。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as aiApi from "@/api/ai";
import type { AiProvider, AiProviderType } from "@/interface/ai";
import type { AiProviderModalProps } from "@/interface/aiProvider";
import { useToast } from "@/components/common/Toast";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { Icon } from "@/components/common/Icon";

/**
 * 三种协议的默认名称与地址，新建配置时填入草稿。
 * api_path 只有 OpenAI 兼容协议可改：Rust 用它推导 .../chat/completions 与 .../models；
 * Google 固定走 /models 与 /models/{model}:generateContent，Claude 固定走 /v1/models，
 * 因此后两者的 path 为 null，界面上也不显示该输入框。
 */
const providerDefaults: Record<AiProviderType, { name: string; baseUrl: string; path: string | null }> = {
  openai: {
    name: "OpenAI 兼容",
    baseUrl: "https://api.openai.com",
    path: "/v1/chat/completions",
  },
  google: {
    name: "Google 兼容",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    path: null,
  },
  claude: {
    name: "Claude 兼容",
    baseUrl: "https://api.anthropic.com",
    path: null,
  },
};

/**
 * 把 Tauri / JS 抛出的任意错误转成可读文案。
 * invoke 失败多以字符串 reject，其次才是 Error；两者都不匹配时兜底序列化，保证原因不被吞掉。
 */
const formatError = (error: unknown): string => {
  if (error == null) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/**
 * 统一取"已勾选模型"。
 * enabled_models 为多选主字段；为空时回退到单选字段 enabled_model，兼容只写了单个模型的配置。
 * 返回前去空、去空白、去重，调用方不必再判空。
 */
const normalizeModelList = (provider: AiProvider): string[] => {
  const list = (provider.enabled_models || []).filter((m) => m && m.trim());
  if (list.length > 0) return [...new Set(list)];
  return provider.enabled_model ? [provider.enabled_model] : [];
};

/**
 * 求并集：本次获取的模型 ∪ 历史已勾选 ∪ 当前使用模型。
 * 用并集而非替换，重新获取模型时已勾选项和当前模型才不会从列表里消失。
 */
const mergeModelList = (...lists: string[][]): string[] => [
  ...new Set(lists.flat().filter((m) => m && m.trim())),
];

/** 按协议生成空白草稿；id === 0 是"尚未入库"的哨兵值，全流程据此区分新建与编辑 */
const emptyProvider = (type: AiProviderType = "openai"): AiProvider => {
  const defaults = providerDefaults[type];
  return {
    id: 0,
    name: defaults.name,
    provider_type: type,
    api_base_url: defaults.baseUrl,
    api_key: "",
    api_path: defaults.path,
    enabled_model: null,
    enabled_models: [],
    created_at: "",
    updated_at: "",
  };
};

/** 面板本体：列表 / 新建 / 编辑 / 模型勾选 / 删除，由设置窗口作为标签页渲染 */
export const AiProviderSettings: React.FC<AiProviderModalProps> = ({
  isOpen,
  providers,
  selectedProviderId,
  onProvidersChange,
  onSelectedProviderChange,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draftProvider, setDraftProvider] = useState<AiProvider>(emptyProvider());
  const [models, setModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  /** 用户是否手动调过勾选（手动清空后，重新获取模型不应再自动全选） */
  const hasUserPickedModelsRef = useRef(false);
  /** 同步守卫：state 更新是异步的，连点会穿透并写入多条记录 */
  const savingRef = useRef(false);
  const fetchingRef = useRef(false);

  /**
   * 面板自持一份列表：父级传入的 providers 可能滞后于写库结果，
   * 因此每次打开面板、每次写入之后都以数据库重读的结果为准。
   */
  const [ownProviders, setOwnProviders] = useState<AiProvider[]>([]);
  /** 是否已成功从数据库读取过（区分"尚未加载"与"加载后确实为空"） */
  const [isListLoaded, setIsListLoaded] = useState(false);
  const listProviders = isListLoaded ? ownProviders : providers;

  /** 同时更新弹窗内部列表与父级列表，避免两边不同步 */
  const publishProviders = useCallback((list: AiProvider[]) => {
    setOwnProviders(list);
    setIsListLoaded(true);
    onProvidersChange(list);
  }, [onProvidersChange]);

  /** 从数据库重读列表并同步给父级；失败返回 null，保留当前列表由调用方决定是否提示 */
  const reloadProviders = useCallback(async () => {
    try {
      const list = await aiApi.getAiProviders();
      setOwnProviders(list);
      setIsListLoaded(true);
      onProvidersChange(list);
      return list;
    } catch (error) {
      console.error("读取 AI 服务商列表失败:", error);
      return null;
    }
  }, [onProvidersChange]);

  // 每次打开面板都重新读取，保证显示的是库里的最新状态
  useEffect(() => {
    if (!isOpen) return;
    reloadProviders();
  }, [isOpen, reloadProviders]);

  /* ---------- 表单打开 / 关闭 ---------- */
  /** 打开编辑：把已勾选模型同步进候选列表，并清掉"手动选过"标记，恢复自动全选策略 */
  const openEdit = (provider: AiProvider) => {
    const checked = normalizeModelList(provider);
    setDraftProvider({ ...provider, enabled_models: checked });
    setModels(checked);
    hasUserPickedModelsRef.current = false;
    setEditingId(provider.id);
    setShowForm(true);
  };

  /** 打开新建：清空模型候选，名称/地址取该协议的默认值 */
  const openCreate = (type: AiProviderType = "openai") => {
    setDraftProvider(emptyProvider(type));
    setModels([]);
    hasUserPickedModelsRef.current = false;
    setEditingId(null);
    setShowForm(true);
  };

  /** 已勾选的可用模型 */
  const checkedModels = normalizeModelList(draftProvider);
  /** 列表 = 已获取的模型 ∪ 已勾选的模型（保证历史勾选项不会因重新获取而消失） */
  const availableModels = mergeModelList(
    models,
    checkedModels,
    draftProvider.enabled_model ? [draftProvider.enabled_model] : [],
  );

  /**
   * 全选 / 清空模型。
   * 已入库的服务商当场写库，避免用户以为改动已保存；草稿（id=0）只改内存，等保存时统一提交。
   * 当前使用模型若被清掉则回退到第一项，否则置空。
   */
  const handleCheckAllModels = async (checked: boolean) => {
    hasUserPickedModelsRef.current = true;
    const nextList = checked ? availableModels : [];
    const nextProvider: AiProvider = {
      ...draftProvider,
      enabled_models: nextList,
      enabled_model: nextList.includes(draftProvider.enabled_model || "")
        ? draftProvider.enabled_model
        : nextList[0] ?? null,
    };
    setDraftProvider(nextProvider);
    if (nextProvider.id === 0) return;
    try {
      await aiApi.updateAiProvider(nextProvider);
      publishProviders(listProviders.map((p) => (p.id === nextProvider.id ? nextProvider : p)));
      window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
    } catch {
      showToast("模型保存失败", "error");
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
  };

  const updateDraft = <K extends keyof AiProvider>(key: K, value: AiProvider[K]) => {
    setDraftProvider((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * 切换协议：地址与路径换成该协议默认值，模型候选清空。
   * 不同协议的模型名互不通用，保留旧勾选只会得到无法调用的条目；
   * 已入库配置沿用用户自定义的名称，草稿才跟着协议改名。
   */
  const changeProviderType = (type: AiProviderType) => {
    const defaults = providerDefaults[type];
    setDraftProvider((prev) => ({
      ...prev,
      provider_type: type,
      name: prev.id === 0 ? defaults.name : prev.name,
      api_base_url: defaults.baseUrl,
      api_path: defaults.path,
      enabled_model: null,
      enabled_models: [],
    }));
    setModels([]);
    hasUserPickedModelsRef.current = false;
  };

  /**
   * 保存草稿：新建走 createAiProvider 并自动选中，编辑走 updateAiProvider。
   * 只校验必填项（名称 / 地址 / Key 非空）；Key 是否有效交给"获取模型"或首次真实请求验证。
   * savingRef 挡住连点；写入成功后即使刷新列表失败，也不会把结果误报成"保存失败"。
   */
  const saveDraftProvider = async () => {
    if (savingRef.current) return;
    if (!draftProvider.name.trim()) {
      showToast("请输入提供商名称", "error");
      return null;
    }
    if (!draftProvider.api_base_url.trim()) {
      showToast("请输入 API Base URL", "error");
      return null;
    }
    if (!draftProvider.api_key.trim()) {
      showToast("请输入 API Key", "error");
      return null;
    }

    savingRef.current = true;
    setIsSaving(true);
    try {
      const checked = normalizeModelList(draftProvider);
      let savedId: number;
      if (draftProvider.id === 0) {
        // 新建：把已勾选的模型一起写库，避免"先保存才能获取模型"的顺序问题
        const created = await aiApi.createAiProvider(
          draftProvider.name,
          draftProvider.provider_type,
          draftProvider.api_base_url,
          draftProvider.api_key,
          draftProvider.api_path,
          checked,
        );
        savedId = created.id;
        onSelectedProviderChange(created.id);
        showToast("AI 配置已保存", "success");
      } else {
        await aiApi.updateAiProvider({ ...draftProvider, enabled_models: checked });
        savedId = draftProvider.id;
        showToast("AI 配置已更新", "success");
      }

      // 写入已成功，后续刷新失败不应再报"保存失败"
      let saved: AiProvider = { ...draftProvider, id: savedId, enabled_models: checked };
      try {
        const fresh = await reloadProviders();
        window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
        saved = fresh?.find((p) => p.id === savedId) ?? saved;
      } catch (refreshError) {
        console.error("保存后刷新配置列表失败:", refreshError);
      }

      setDraftProvider(saved);
      setEditingId(saved.id);
      setModels((prev) => mergeModelList(normalizeModelList(saved), prev));
      closeForm();

      return saved;
    } catch (error) {
      console.error("保存 AI 配置失败:", error);
      showToast(`保存 AI 配置失败：${formatError(error)}`, "error");
      return null;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  /**
   * 用表单当前连接信息直接拉取模型，无需先保存。
   * 两类失败分开提示：拉到的列表为空多为地址/Key 配错；请求本身报错则带上 Rust 返回的原因。
   * 首次获取且用户未手动选过时默认全选，让"获取 → 保存"即可直接对话。
   */
  const handleFetchModels = async () => {
    if (fetchingRef.current) return;
    if (!draftProvider.api_base_url.trim() || !draftProvider.api_key.trim()) {
      showToast("请先填写 API Base URL 与 API Key", "error");
      return;
    }
    fetchingRef.current = true;
    setIsFetchingModels(true);
    try {
      const fetchedModels = await aiApi.fetchAiModels(draftProvider);
      if (fetchedModels.length === 0) {
        showToast("没有获取到模型，请检查地址与密钥", "error");
        return;
      }
      // 并集：保留已勾选的模型，避免重新获取后勾选状态丢失
      setModels((prev) => mergeModelList(fetchedModels, prev));

      if (normalizeModelList(draftProvider).length === 0 && !hasUserPickedModelsRef.current) {
        // 首次获取且用户还没选过：默认全选，这样"获取 → 保存"即可直接使用
        const allChecked: AiProvider = {
          ...draftProvider,
          enabled_models: fetchedModels,
          enabled_model: fetchedModels[0] ?? null,
        };
        setDraftProvider(allChecked);
        if (allChecked.id !== 0) {
          try {
            await aiApi.updateAiProvider(allChecked);
            publishProviders(listProviders.map((p) => (p.id === allChecked.id ? allChecked : p)));
            window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
          } catch { /* 忽略：保存时仍会写入 */ }
        }
      }
      showToast(`已获取 ${fetchedModels.length} 个模型，可自行勾选需要的`, "success");
    } catch (error) {
      console.error("获取模型失败:", error);
      showToast(`获取模型失败：${formatError(error)}`, "error");
    } finally {
      fetchingRef.current = false;
      setIsFetchingModels(false);
    }
  };

  /** 勾选/取消勾选一个可用模型（多选），并立即持久化 */
  const handleToggleModel = async (model: string) => {
    hasUserPickedModelsRef.current = true;
    const checked = normalizeModelList(draftProvider);
    const nextList = checked.includes(model)
      ? checked.filter((m) => m !== model)
      : [...checked, model];

    // 当前对话模型被取消勾选时，自动回退到列表里的第一个，避免出现"已勾选但用不了"的状态
    const nextEnabledModel =
      draftProvider.enabled_model && nextList.includes(draftProvider.enabled_model)
        ? draftProvider.enabled_model
        : nextList[0] ?? null;

    const nextProvider: AiProvider = {
      ...draftProvider,
      enabled_models: nextList,
      enabled_model: nextEnabledModel,
    };
    setDraftProvider(nextProvider);
    // 新建未保存的配置：只更新草稿，等保存时一起写库
    if (nextProvider.id === 0) return;
    try {
      await aiApi.updateAiProvider(nextProvider);
      publishProviders(
        listProviders.map((p) => (p.id === nextProvider.id ? nextProvider : p)),
      );
      window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
    } catch {
      showToast("模型保存失败", "error");
    }
  };

  /**
   * 删除服务商：二次确认，连同本机保存的 API Key 一起移除。
   * 删的若是当前选中项，自动切到剩余第一条；没有剩余则置 0 表示"未选择"。
   */
  const handleDeleteProvider = async (provider: AiProvider) => {
    const p = provider;
    if (p.id === 0) {
      closeForm();
      return;
    }
    const ok = await confirm({
      title: "删除 AI 服务商",
      message: `确定删除「${p.name}」吗？该配置与本机保存的 API Key 会被移除，无法撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await aiApi.deleteAiProvider(p.id);
      const nextProviders = listProviders.filter((x) => x.id !== p.id);
      publishProviders(nextProviders);
      if (p.id === selectedProviderId) {
        onSelectedProviderChange(nextProviders.length > 0 ? nextProviders[0].id : 0);
      }
      closeForm();
      showToast("AI 配置已删除", "success");
    } catch {
      showToast("删除 AI 配置失败", "error");
    }
  };

  /** 选中服务商：收起表单，并广播事件让 AIChatPanel 切换到该配置并加载模型 */
  const handleSelectProvider = (id: number) => {
    onSelectedProviderChange(id);
    setShowForm(false);
    // 通知 AIChatPanel 更新当前选中的服务商并加载模型
    window.dispatchEvent(new CustomEvent('fastnote-provider-selected', { detail: { providerId: id } }));
  };

  const activeProvider = listProviders.find((p) => p.id === selectedProviderId);

  return (
    <div className="space-y-4 min-w-0">
        {/* 服务商列表 */}
        {!showForm && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-body flex-shrink-0">已配置的服务商</h3>
              <div className="flex gap-1.5 flex-wrap">
                {(["openai", "google", "claude"] as AiProviderType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => openCreate(type)}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors flex items-center gap-1"
                  >
                    <Icon name="provider-plus" className="w-3 h-3" />
                    {type === "openai" ? "OpenAI" : type === "google" ? "Google" : "Claude"}
                  </button>
                ))}
              </div>
            </div>

            {listProviders.length === 0 ? (
              <div className="py-10 text-center text-sm text-faint">
                暂无服务商配置，点击上方按钮添加
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[260px] overflow-y-auto chat-scrollbar pr-1 -mr-1">
                {listProviders.map((p) => (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-3 px-3.5 py-2.5 rounded-xl cursor-pointer transition-all ${
                      p.id === selectedProviderId
                        ? "bg-primary-50 border border-primary-200"
                        : "bg-surface border border-line-soft hover:border-line hover:shadow-sm"
                    }`}
                    onClick={() => handleSelectProvider(p.id)}
                  >
                    {/* 协议色块：O / G / C 对应 OpenAI / Google / Claude */}
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-on-accent flex-shrink-0 ${
                      p.provider_type === "openai" ? "bg-success" :
                      p.provider_type === "google" ? "bg-info" : "bg-warning"
                    }`}>
                      {p.provider_type === "openai" ? "O" : p.provider_type === "google" ? "G" : "C"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-body truncate">{p.name}</div>
                      <div className="text-xs text-faint truncate">
                        {p.enabled_model || "未选择模型"}
                        {normalizeModelList(p).length > 1 && `（共选 ${normalizeModelList(p).length} 个）`}
                        {" · "}
                        {p.api_base_url.replace(/^https?:\/\//, "").split("/")[0]}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); openEdit(p); }}
                        className="px-1.5 py-1 text-[11px] text-faint hover:text-primary-500 rounded-md hover:bg-primary-50 transition-colors"
                      >
                        编辑
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteProvider(p); }}
                        className="px-1.5 py-1 text-[11px] text-faint hover:text-danger rounded-md hover:bg-danger-soft transition-colors"
                      >
                        删除
                      </button>
                    </div>
                    {p.id === selectedProviderId && (
                      <div className="w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            )}

            {activeProvider && (
              <div className="text-center text-xs text-faint">
                当前使用：<span className="text-primary-500 font-medium">{activeProvider.name}</span>
                {activeProvider.enabled_model && ` · ${activeProvider.enabled_model}`}
                {normalizeModelList(activeProvider).length > 1 &&
                  `（已启用 ${normalizeModelList(activeProvider).length} 个模型）`}
              </div>
            )}
          </>
        )}

        {/* 新建 / 编辑表单 */}
        {showForm && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <button onClick={closeForm} className="p-1 rounded-lg hover:bg-surface-alt text-faint transition-colors">
                <Icon name="provider-back" className="w-4 h-4" />
              </button>
              <h3 className="text-sm font-semibold text-body">
                {editingId ? "编辑服务商" : "添加服务商"}
              </h3>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(["openai", "google", "claude"] as AiProviderType[]).map((type) => (
                <button
                  key={type}
                  onClick={() => changeProviderType(type)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    draftProvider.provider_type === type
                      ? "bg-primary-500 text-on-accent shadow-sm"
                      : "bg-surface-alt text-body hover:bg-surface-strong"
                  }`}
                >
                  {type === "openai" ? "OpenAI" : type === "google" ? "Google" : "Claude"}
                </button>
              ))}
            </div>

            <input
              value={draftProvider.name}
              onChange={(e) => updateDraft("name", e.target.value)}
              placeholder="提供商名称"
              className="w-full px-3 py-2 text-sm input-modern"
            />
            <input
              value={draftProvider.api_base_url}
              onChange={(e) => updateDraft("api_base_url", e.target.value)}
              placeholder="API Base URL"
              className="w-full px-3 py-2 text-sm input-modern"
            />
            {draftProvider.provider_type === "openai" && (
              <input
                value={draftProvider.api_path || ""}
                onChange={(e) => updateDraft("api_path", e.target.value || null)}
                placeholder="/v1/chat/completions"
                className="w-full px-3 py-2 text-sm input-modern"
              />
            )}
            <input
              value={draftProvider.api_key}
              type="password"
              onChange={(e) => updateDraft("api_key", e.target.value)}
              placeholder="API Key"
              className="w-full px-3 py-2 text-sm input-modern"
            />

            <div className="flex gap-2">
              {/* 操作顺序：获取模型 → 勾选 → 保存；未保存也能先获取，两个按钮互斥禁用 */}
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={isFetchingModels || isSaving}
                className="btn-primary flex-1 px-4 py-2 text-sm disabled:opacity-50"
              >
                {isFetchingModels ? "获取中..." : "获取模型"}
              </button>
              <button
                type="button"
                onClick={saveDraftProvider}
                disabled={isSaving || isFetchingModels}
                className="btn-ghost flex-1 px-4 py-2 text-sm bg-surface-alt disabled:opacity-50"
              >
                {isSaving ? "保存中..." : "保存配置"}
              </button>
              <button
                onClick={() => handleDeleteProvider(draftProvider)}
                className="px-4 py-2 text-sm rounded-xl text-danger bg-surface-alt hover:bg-danger-soft transition-colors"
              >
                删除
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-faint font-medium">
                  可用模型（可多选）
                </label>
                <span className="text-[11px] text-faint">
                  已选 {checkedModels.length}
                  {availableModels.length > 0 && ` / ${availableModels.length}`}
                </span>
              </div>

              {availableModels.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                  {isFetchingModels
                    ? "正在获取模型列表..."
                    : "还没有模型列表，点击上方「获取模型」后再勾选"}
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1.5">
                    <button
                      type="button"
                      onClick={() => handleCheckAllModels(true)}
                      className="text-[11px] px-2 py-0.5 rounded-md text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCheckAllModels(false)}
                      className="text-[11px] px-2 py-0.5 rounded-md text-muted bg-surface-alt hover:bg-surface-strong transition-colors"
                    >
                      清空
                    </button>
                  </div>

                  <div className="max-h-44 overflow-y-auto rounded-xl border border-line divide-y divide-line-soft">
                    {availableModels.map((model) => {
                      const checked = checkedModels.includes(model);
                      return (
                        <label
                          key={model}
                          className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer text-sm transition-colors ${
                            checked ? "bg-primary-50/60" : "hover:bg-app"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleToggleModel(model)}
                            className="w-4 h-4 rounded border-line-strong text-primary-500 focus:ring-primary-500/20"
                          />
                          <span className={`truncate min-w-0 ${checked ? "text-primary-700" : "text-body"}`}>
                            {model}
                          </span>
                          {draftProvider.enabled_model === model && (
                            <span className="ml-auto flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-primary-100 text-primary-600">
                              当前使用
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* 删除确认弹窗（列表行与编辑页共用） */}
        {confirmDialog}
      </div>
  );
};
