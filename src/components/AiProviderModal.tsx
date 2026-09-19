import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { AiProvider, AiProviderType } from "../types";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

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

/** 把（Tauri 返回的）错误转成可读文案，避免只显示"失败"而丢掉了原因 */
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

/** 统一取"已勾选模型"：优先新字段，兼容只有 enabled_model 的旧数据 */
const normalizeModelList = (provider: AiProvider): string[] => {
  const list = (provider.enabled_models || []).filter((m) => m && m.trim());
  if (list.length > 0) return [...new Set(list)];
  return provider.enabled_model ? [provider.enabled_model] : [];
};

/** 列表并集：已获取的模型 ∪ 已勾选的模型 ∪ 当前使用模型 */
const mergeModelList = (...lists: string[][]): string[] => [
  ...new Set(lists.flat().filter((m) => m && m.trim())),
];

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

interface AiProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: AiProvider[];
  selectedProviderId: number;
  onProvidersChange: (providers: AiProvider[]) => void;
  onSelectedProviderChange: (id: number) => void;
}

export const AiProviderModal: React.FC<AiProviderModalProps> = ({
  isOpen,
  onClose,
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
  /** 用户是否手动调过勾选（手动清空后，重新获取模型不应再自动全选） */
  const hasUserPickedModelsRef = useRef(false);
  /** 同步守卫：state 更新是异步的，连点会穿透并写入多条记录 */
  const savingRef = useRef(false);
  const fetchingRef = useRef(false);

  /**
   * 弹窗自己持有列表：每次"打开弹窗"和"任何写入之后"都直接从数据库重读。
   * 只依赖父组件传入的 providers，出现过"写库成功但列表显示为空"的同步缺口。
   */
  const [ownProviders, setOwnProviders] = useState<AiProvider[]>([]);
  /** 是否已成功从数据库读取过（区分"未加载"与"加载后确实为空"） */
  const [isListLoaded, setIsListLoaded] = useState(false);
  const listProviders = isListLoaded ? ownProviders : providers;

  /** 同时更新弹窗内部列表与父级列表，避免两边不同步 */
  const publishProviders = useCallback((list: AiProvider[]) => {
    setOwnProviders(list);
    setIsListLoaded(true);
    onProvidersChange(list);
  }, [onProvidersChange]);

  const reloadProviders = useCallback(async () => {
    try {
      const list = await api.getAiProviders();
      setOwnProviders(list);
      setIsListLoaded(true);
      onProvidersChange(list);
      return list;
    } catch (error) {
      console.error("读取 AI 服务商列表失败:", error);
      return null;
    }
  }, [onProvidersChange]);

  // 每次打开弹窗都重新读取，保证显示的是库里的最新状态
  useEffect(() => {
    if (!isOpen) return;
    reloadProviders();
  }, [isOpen, reloadProviders]);

  /* ─── 打开编辑表单 ─── */
  const openEdit = (provider: AiProvider) => {
    const checked = normalizeModelList(provider);
    setDraftProvider({ ...provider, enabled_models: checked });
    setModels(checked);
    hasUserPickedModelsRef.current = false;
    setEditingId(provider.id);
    setShowForm(true);
  };

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
      await api.updateAiProvider(nextProvider);
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
        const created = await api.createAiProvider(
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
        await api.updateAiProvider({ ...draftProvider, enabled_models: checked });
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

  /** 用表单里当前的连接信息直接获取模型，无需先保存 */
  const handleFetchModels = async () => {
    if (fetchingRef.current) return;
    if (!draftProvider.api_base_url.trim() || !draftProvider.api_key.trim()) {
      showToast("请先填写 API Base URL 与 API Key", "error");
      return;
    }
    fetchingRef.current = true;
    setIsFetchingModels(true);
    try {
      const fetchedModels = await api.fetchAiModels(draftProvider);
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
            await api.updateAiProvider(allChecked);
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
      await api.updateAiProvider(nextProvider);
      publishProviders(
        listProviders.map((p) => (p.id === nextProvider.id ? nextProvider : p)),
      );
      window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
    } catch {
      showToast("模型保存失败", "error");
    }
  };

  const handleDeleteProvider = async () => {
    const p = draftProvider;
    if (p.id === 0) {
      closeForm();
      return;
    }
    try {
      await api.deleteAiProvider(p.id);
      const nextProviders = listProviders.filter((x) => x.id !== p.id);
      publishProviders(nextProviders);
      if (editingId === selectedProviderId) {
        onSelectedProviderChange(nextProviders.length > 0 ? nextProviders[0].id : 0);
      }
      closeForm();
      showToast("AI 配置已删除", "success");
    } catch {
      showToast("删除 AI 配置失败", "error");
    }
  };

  const handleSelectProvider = (id: number) => {
    onSelectedProviderChange(id);
    setShowForm(false);
    // 通知 AIChatPanel 更新当前选中的服务商并加载模型
    window.dispatchEvent(new CustomEvent('fastnote-provider-selected', { detail: { providerId: id } }));
  };

  const activeProvider = listProviders.find((p) => p.id === selectedProviderId);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="AI 服务商配置">
      <div className="space-y-4 min-w-[420px]">
        {/* Provider list */}
        {!showForm && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">已配置的服务商</h3>
              <div className="flex gap-1.5">
                {(["openai", "google", "claude"] as AiProviderType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => openCreate(type)}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                    </svg>
                    {type === "openai" ? "OpenAI" : type === "google" ? "Google" : "Claude"}
                  </button>
                ))}
              </div>
            </div>

            {listProviders.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-400">
                暂无服务商配置，点击上方按钮添加
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
                {listProviders.map((p) => (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-3 px-3.5 py-2.5 rounded-xl cursor-pointer transition-all ${
                      p.id === selectedProviderId
                        ? "bg-primary-50 border border-primary-200"
                        : "bg-white border border-slate-100 hover:border-slate-200 hover:shadow-sm"
                    }`}
                    onClick={() => handleSelectProvider(p.id)}
                  >
                    {/* Type icon */}
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0 ${
                      p.provider_type === "openai" ? "bg-emerald-500" :
                      p.provider_type === "google" ? "bg-blue-500" : "bg-amber-500"
                    }`}>
                      {p.provider_type === "openai" ? "O" : p.provider_type === "google" ? "G" : "C"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-700 truncate">{p.name}</div>
                      <div className="text-xs text-slate-400 truncate">
                        {p.enabled_model || "未选择模型"}
                        {normalizeModelList(p).length > 1 && `（共选 ${normalizeModelList(p).length} 个）`}
                        {" · "}
                        {p.api_base_url.replace(/^https?:\/\//, "").split("/")[0]}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(p); }}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-primary-500 hover:bg-primary-50 transition-all"
                      title="编辑"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    {p.id === selectedProviderId && (
                      <div className="w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            )}

            {activeProvider && (
              <div className="text-center text-xs text-slate-400">
                当前使用：<span className="text-primary-500 font-medium">{activeProvider.name}</span>
                {activeProvider.enabled_model && ` · ${activeProvider.enabled_model}`}
                {normalizeModelList(activeProvider).length > 1 &&
                  `（已启用 ${normalizeModelList(activeProvider).length} 个模型）`}
              </div>
            )}
          </>
        )}

        {/* Edit/Create form */}
        {showForm && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <button onClick={closeForm} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h3 className="text-sm font-semibold text-slate-700">
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
                      ? "bg-primary-500 text-white shadow-sm"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
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
              {/* 顺序：获取模型 → 勾选 → 保存配置；未保存也能直接获取 */}
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
                className="btn-ghost flex-1 px-4 py-2 text-sm bg-slate-100 disabled:opacity-50"
              >
                {isSaving ? "保存中..." : "保存配置"}
              </button>
              <button
                onClick={handleDeleteProvider}
                className="px-4 py-2 text-sm rounded-xl text-red-500 bg-slate-100 hover:bg-red-50 transition-colors"
              >
                删除
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-slate-400 font-medium">
                  可用模型（可多选）
                </label>
                <span className="text-[11px] text-slate-400">
                  已选 {checkedModels.length}
                  {availableModels.length > 0 && ` / ${availableModels.length}`}
                </span>
              </div>

              {availableModels.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
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
                      className="text-[11px] px-2 py-0.5 rounded-md text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors"
                    >
                      清空
                    </button>
                  </div>

                  <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
                    {availableModels.map((model) => {
                      const checked = checkedModels.includes(model);
                      return (
                        <label
                          key={model}
                          className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer text-sm transition-colors ${
                            checked ? "bg-primary-50/60" : "hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleToggleModel(model)}
                            className="w-4 h-4 rounded border-slate-300 text-primary-500 focus:ring-primary-500/20"
                          />
                          <span className={`truncate min-w-0 ${checked ? "text-primary-700" : "text-slate-600"}`}>
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
      </div>
    </Modal>
  );
};
