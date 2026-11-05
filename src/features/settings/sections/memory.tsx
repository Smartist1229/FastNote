/* AI 记忆 / 前置提示词：启用项由 buildMemoryBlock 拼进每次请求的系统提示词。 */

import { useState } from "react";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";
import type { SettingsSectionContext } from "../context";

/** 生成提示词条目的唯一 id：时间戳 + 随机后缀，避免同一毫秒内连续添加时撞号 */
const newPromptId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const MemorySection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => {
  const { t } = useI18n();
  const { aiPrompts, onAiPromptsChange, flashSaved } = ctx;

  /* 记忆编辑的本地草稿：未点「添加」前不写库 */
  const [memoryDraft, setMemoryDraft] = useState("");
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [editingPromptText, setEditingPromptText] = useState("");

  /** 底部统计用：启用中的记忆/提示词条数 */
  const enabledPromptCount = aiPrompts.filter((p) => p.enabled).length;

  /* 记忆：增删改都立即上抛新数组，写库与生效由 App 负责 */
  const addPrompt = () => {
    const text = memoryDraft.trim();
    if (!text) return;
    onAiPromptsChange([...aiPrompts, { id: newPromptId(), text, enabled: true }]);
    setMemoryDraft("");
    flashSaved();
  };

  const togglePrompt = (id: string) => {
    onAiPromptsChange(aiPrompts.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)));
    flashSaved();
  };

  const removePrompt = (id: string) => {
    onAiPromptsChange(aiPrompts.filter((e) => e.id !== id));
    flashSaved();
  };

  const savePromptEdit = () => {
    const text = editingPromptText.trim();
    if (!text) {
      setEditingPromptId(null);
      return;
    }
    onAiPromptsChange(aiPrompts.map((e) => (e.id === editingPromptId ? { ...e, text } : e)));
    setEditingPromptId(null);
    flashSaved();
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-faint leading-relaxed">{t("启用中的每一条都会加在每次请求的系统提示词末尾，既可作默认要求（如「回答先给结论」），也可当作长期记忆。")}</p>

      <div className="space-y-2">
        {/* 中文输入法组字期间的回车是选词，isComposing / keyCode 229 时不能当提交 */}
        <textarea
          value={memoryDraft}
          onChange={(e) => setMemoryDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              addPrompt();
            }
          }}
          rows={2}
          placeholder={t("输入一条要求或记忆，回车添加（Shift+回车换行）")}
          className="w-full resize-none px-3 py-2 text-xs input-modern bg-app/50 focus:bg-surface transition-colors"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-faint">{t("回车即可添加")}</span>
          <button
            onClick={addPrompt}
            disabled={!memoryDraft.trim()}
            className="px-3 py-1.5 text-xs font-medium text-on-accent bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >{t("添加")}</button>
        </div>
      </div>

      {/* 条目多了就内部滚动，避免把整页设置撑得特别长 */}
      <div className="space-y-2 max-h-[260px] overflow-y-auto chat-scrollbar pr-1 -mr-1">
        {aiPrompts.length === 0 && (
          <div className="py-6 text-center text-xs text-faint border border-dashed border-line rounded-xl">{t("还没有内容。添加一条试试，例如「回答尽量简短，先给结论」。")}</div>
        )}
        {aiPrompts.map((entry) => (
          <div
            key={entry.id}
            className={`group rounded-xl border px-3 py-2 transition-colors ${
              entry.enabled ? "border-line bg-surface" : "border-line-soft bg-app/60"
            }`}
          >
            {editingPromptId === entry.id ? (
              <div className="space-y-2">
                <textarea
                  value={editingPromptText}
                  onChange={(e) => setEditingPromptText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      savePromptEdit();
                    }
                    if (e.key === "Escape") setEditingPromptId(null);
                  }}
                  rows={2}
                  autoFocus
                  className="w-full resize-none px-2.5 py-1.5 text-xs input-modern bg-surface"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => setEditingPromptId(null)}
                    className="px-2.5 py-1 text-[11px] text-muted bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors"
                  >{t("取消")}</button>
                  <button
                    onClick={savePromptEdit}
                    className="px-2.5 py-1 text-[11px] text-on-accent bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors"
                  >{t("保存")}</button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <button
                  onClick={() => togglePrompt(entry.id)}
                  title={entry.enabled ? t("已启用，点击停用") : t("已停用，点击启用")}
                  aria-pressed={entry.enabled}
                  className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${
                    entry.enabled
                      ? "bg-primary-500 border-primary-500 text-on-accent"
                      : "bg-surface border-line-strong"
                  }`}
                >
                  {entry.enabled && <Icon name="memory-check" className="w-3 h-3" />}
                </button>
                <p
                  className={`flex-1 min-w-0 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                    entry.enabled ? "text-body" : "text-faint"
                  }`}
                >
                  {entry.text}
                </p>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button
                    onClick={() => {
                      setEditingPromptId(entry.id);
                      setEditingPromptText(entry.text);
                    }}
                    className="px-1.5 py-1 text-[11px] text-faint hover:text-primary-500 rounded-md hover:bg-primary-50 transition-colors"
                  >{t("编辑")}</button>
                  <button
                    onClick={() => removePrompt(entry.id)}
                    className="px-1.5 py-1 text-[11px] text-faint hover:text-danger rounded-md hover:bg-danger-soft transition-colors"
                  >{t("删除")}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-[11px] text-faint">{t("共 {count} 条，其中 {enabled} 条已启用", { count: aiPrompts.length, enabled: enabledPromptCount })}</p>
    </div>
  );
};
