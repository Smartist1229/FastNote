import { useState } from "react";
import { Modal } from "./Modal";
import { AiProviderSettings } from "./AiProviderModal";
import { AiProvider, AiSettings, DEFAULT_AI_SETTINGS } from "../types";

interface AiSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: AiProvider[];
  selectedProviderId: number;
  onProvidersChange: (providers: AiProvider[]) => void;
  onSelectedProviderChange: (id: number) => void;
  settings: AiSettings;
  onSettingsChange: (next: AiSettings) => void;
  /** 记忆/前置提示词条数，仅用于在"记忆"页显示状态 */
  promptCount: number;
  enabledPromptCount: number;
  onOpenMemory: () => void;
}

type TabKey = "provider" | "chat" | "context" | "memory";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "provider", label: "服务商", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" /> },
  { key: "chat", label: "对话行为", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-4 4v-4z" /> },
  { key: "context", label: "上下文", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2 1.5 3 4 3h8c2.5 0 4-1 4-3V7c0-2-1.5-3-4-3H8C5.5 4 4 5 4 7zm0 5h16M9 4v6" /> },
  { key: "memory", label: "记忆", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /> },
];

/** 一行开关 */
const ToggleRow: React.FC<{ title: string; desc: string; value: boolean; onChange: (v: boolean) => void }> = ({ title, desc, value, onChange }) => (
  <div className="flex items-start justify-between gap-4 py-2.5">
    <div className="min-w-0">
      <div className="text-xs font-medium text-slate-700">{title}</div>
      <div className="text-[11px] text-slate-400 leading-relaxed mt-0.5">{desc}</div>
    </div>
    <button
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      className={`mt-0.5 w-9 h-5 rounded-full flex-shrink-0 transition-colors relative ${value ? "bg-primary-500" : "bg-slate-300"}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${value ? "left-[18px]" : "left-0.5"}`} />
    </button>
  </div>
);

/** 一行数字输入 */
const NumberRow: React.FC<{ title: string; desc: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }> = ({ title, desc, value, min, max, step = 1, unit, onChange }) => (
  <div className="flex items-start justify-between gap-4 py-2.5">
    <div className="min-w-0">
      <div className="text-xs font-medium text-slate-700">{title}</div>
      <div className="text-[11px] text-slate-400 leading-relaxed mt-0.5">{desc}</div>
    </div>
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-20 px-2 py-1 text-xs text-right input-modern bg-slate-50/60 focus:bg-white transition-colors"
      />
      {unit ? <span className="text-[11px] text-slate-400">{unit}</span> : null}
    </div>
  </div>
);

/**
 * 统一的「AI 设置」窗口。
 * 所有 AI 相关设置都收敛在这里：服务商 / 对话行为 / 上下文 / 记忆入口。
 * 记忆列表本身仍由独立的 💡 弹窗编辑（这里只显示状态并提供入口）。
 */
export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({
  isOpen, onClose, providers, selectedProviderId, onProvidersChange, onSelectedProviderChange,
  settings, onSettingsChange, promptCount, enabledPromptCount, onOpenMemory,
}) => {
  const [tab, setTab] = useState<TabKey>("provider");
  const set = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => onSettingsChange({ ...settings, [key]: value });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="AI 设置" size="2xl">
      <div className="flex gap-4">
        {/* 左侧标签 */}
        <div className="w-24 flex-shrink-0 space-y-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                tab === t.key ? "bg-primary-50 text-primary-600" : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">{t.icon}</svg>
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 min-w-0 max-h-[60vh] overflow-y-auto overflow-x-hidden chat-scrollbar pr-1">
          {tab === "provider" && (
            <AiProviderSettings
              isOpen={isOpen}
              onClose={onClose}
              providers={providers}
              selectedProviderId={selectedProviderId}
              onProvidersChange={onProvidersChange}
              onSelectedProviderChange={onSelectedProviderChange}
            />
          )}

          {tab === "chat" && (
            <div className="divide-y divide-slate-100">
              <NumberRow title="深度思考最少字数" desc="低于这个字数会提醒模型重新深入思考（0 表示不限制）" value={settings.minThinkingLen} min={0} max={1000} step={10} unit="字" onChange={(v) => set("minThinkingLen", v)} />
              <NumberRow title="最多工具轮数" desc="一次提问里模型最多连续调用几轮工具；填 0 表示不限制（连续两轮毫无进展时会自动停下）" value={settings.maxRounds} min={0} max={200} unit="轮" onChange={(v) => set("maxRounds", v)} />
              <NumberRow title="最大输出长度" desc="单次回复最多生成多少 token；调大能明显减少「长文被截断」，调小更省额度" value={settings.maxTokens} min={256} max={32000} step={512} unit="token" onChange={(v) => set("maxTokens", v)} />
              <ToggleRow title="思考过浅时重来一次" desc="关闭后直接采纳模型给出的回答，不再要求重写（响应更快）" value={settings.retryShallowThinking} onChange={(v) => set("retryShallowThinking", v)} />
              <ToggleRow title="流式输出" desc="边生成边显示；关闭后等整段生成完再一次性显示（个别服务商流式不稳定时可关掉）" value={settings.streaming} onChange={(v) => set("streaming", v)} />
              <ToggleRow title="自动生成会话标题" desc="首轮对话后自动用一句话概括，关闭后标题保持「新对话」" value={settings.autoTitle} onChange={(v) => set("autoTitle", v)} />
              <ToggleRow title="默认开启操作确认" desc="创建/修改/删除等写操作执行前先弹确认框（面板里仍可临时切换）" value={settings.confirmByDefault} onChange={(v) => set("confirmByDefault", v)} />
              <ToggleRow title="显示工具执行轨迹" desc="在回复上方逐条显示执行过的工具，可展开查看调用参数与结果" value={settings.showToolTrace} onChange={(v) => set("showToolTrace", v)} />
            </div>
          )}

          {tab === "context" && (
            <div className="divide-y divide-slate-100">
              <NumberRow title="上下文预算" desc="历史超过这个规模就把更早的对话压成摘要，避免上下文太长导致模型乱答" value={settings.contextBudget} min={2000} max={200000} step={1000} unit="token" onChange={(v) => set("contextBudget", v)} />
              <NumberRow title="始终保留最近消息" desc="无论上下文多长，最近这么多条消息都完整保留" value={settings.keepRecent} min={2} max={50} unit="条" onChange={(v) => set("keepRecent", v)} />
              <NumberRow title="工具结果注入上限" desc="单个工具结果最多带多少字进上下文，超出只保留开头并提示按范围重读" value={settings.toolResultChars} min={200} max={20000} step={100} unit="字" onChange={(v) => set("toolResultChars", v)} />
              <div className="pt-3">
                <button onClick={() => onSettingsChange({ ...DEFAULT_AI_SETTINGS })} className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
                  恢复全部默认值
                </button>
              </div>
            </div>
          )}

          {tab === "memory" && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs font-medium text-slate-700 mb-1">前置提示词 / 长期记忆</div>
                <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                  共 {promptCount} 条，启用 {enabledPromptCount} 条。启用的内容会加在每次请求的系统提示词末尾，
                  既可作为默认要求，也可以当作长期记忆。
                </p>
                <button onClick={() => { onClose(); onOpenMemory(); }} className="px-3 py-1.5 text-xs font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors">
                  打开记忆设置
                </button>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                提示：适合放进来的内容有「回答先给结论」「始终用简体中文」「我是前端开发者」「大纲用三级标题」等稳定偏好；
                一次性的要求直接写在对话里即可。
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
