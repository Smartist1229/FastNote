import { useState } from "react";
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

  /* ─── 打开编辑表单 ─── */
  const openEdit = (provider: AiProvider) => {
    setDraftProvider({ ...provider });
    setModels(provider.enabled_model ? [provider.enabled_model] : []);
    setEditingId(provider.id);
    setShowForm(true);
  };

  const openCreate = (type: AiProviderType = "openai") => {
    setDraftProvider(emptyProvider(type));
    setModels([]);
    setEditingId(null);
    setShowForm(true);
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
    }));
    setModels([]);
  };

  const saveDraftProvider = async () => {
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

    setIsSaving(true);
    try {
      let saved: AiProvider;
      if (draftProvider.id === 0) {
        saved = await api.createAiProvider(
          draftProvider.name,
          draftProvider.provider_type,
          draftProvider.api_base_url,
          draftProvider.api_key,
          draftProvider.api_path,
        );
        const updated = [saved, ...providers];
        onProvidersChange(updated);
        onSelectedProviderChange(saved.id);
        closeForm();
        showToast("AI 配置已保存", "success");
      } else {
        await api.updateAiProvider(draftProvider);
        saved = draftProvider;
        const updated = providers.map((p) => (p.id === draftProvider.id ? draftProvider : p));
        onProvidersChange(updated);
        closeForm();
        showToast("AI 配置已更新", "success");
      }

      setDraftProvider(saved);
      setEditingId(saved.id);

      // Auto-fetch models
      setIsFetchingModels(true);
      try {
        const fetchedModels = await api.fetchAiModels(saved);
        if (fetchedModels.length > 0) setModels(fetchedModels);
      } catch { /* silent */ }
      finally { setIsFetchingModels(false); }

      return saved;
    } catch (error) {
      console.error("保存 AI 配置失败:", error);
      showToast("保存 AI 配置失败", "error");
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const handleFetchModels = async () => {
    if (draftProvider.id === 0) {
      showToast("请先保存配置", "error");
      return;
    }
    setIsFetchingModels(true);
    try {
      const fetchedModels = await api.fetchAiModels(draftProvider);
      setModels(fetchedModels);
      showToast("模型列表已获取", "success");
    } catch (error) {
      showToast(String(error || "获取模型失败"), "error");
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleSelectModel = async (model: string) => {
    const nextProvider = { ...draftProvider, enabled_model: model };
    setDraftProvider(nextProvider);
    if (nextProvider.id === 0) return;
    try {
      await api.updateAiProvider(nextProvider);
      onProvidersChange(
        providers.map((p) => (p.id === nextProvider.id ? nextProvider : p)),
      );
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
      const nextProviders = providers.filter((x) => x.id !== p.id);
      onProvidersChange(nextProviders);
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

  const activeProvider = providers.find((p) => p.id === selectedProviderId);

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

            {providers.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-400">
                暂无服务商配置，点击上方按钮添加
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
                {providers.map((p) => (
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
                        {p.enabled_model || "未选择模型"} · {p.api_base_url.replace(/^https?:\/\//, "").split("/")[0]}
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
              <button
                onClick={saveDraftProvider}
                disabled={isSaving}
                className="btn-primary flex-1 px-4 py-2 text-sm disabled:opacity-50"
              >
                {isSaving ? "保存中..." : "保存配置"}
              </button>
              <button
                onClick={handleFetchModels}
                disabled={isFetchingModels || draftProvider.id === 0}
                className="btn-ghost flex-1 px-4 py-2 text-sm bg-slate-100 disabled:opacity-50"
              >
                {isFetchingModels ? "获取中..." : "获取模型"}
              </button>
              <button
                onClick={handleDeleteProvider}
                className="px-4 py-2 text-sm rounded-xl text-red-500 bg-slate-100 hover:bg-red-50 transition-colors"
              >
                删除
              </button>
            </div>

            <div>
              <label className="text-xs text-slate-400 font-medium mb-1.5 block">选择启用模型</label>
              <select
                value={draftProvider.enabled_model || ""}
                onChange={(e) => handleSelectModel(e.target.value)}
                className="w-full px-3 py-2 text-sm input-modern"
              >
                <option value="">{isFetchingModels ? "加载模型中..." : "选择启用模型"}</option>
                {models.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
                {draftProvider.enabled_model && !models.includes(draftProvider.enabled_model) && (
                  <option value={draftProvider.enabled_model}>{draftProvider.enabled_model}</option>
                )}
              </select>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
