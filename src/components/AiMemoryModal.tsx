import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { AiPromptEntry } from "../types";

interface AiMemoryModalProps {
  isOpen: boolean;
  entries: AiPromptEntry[];
  onChange: (next: AiPromptEntry[]) => void;
  onClose: () => void;
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * 「AI 记忆 / 前置提示词」设置。
 * 每条启用中的内容都会追加在系统提示词末尾，因此它同时承担两个作用：
 *   1. 默认前置要求（例如"永远用中文、回答先给结论"）；
 *   2. 长期记忆（例如"我叫小李，常写技术笔记；项目代号 FastNote"）。
 * 数据存在本机（localStorage），由 App 统一持有。
 */
export const AiMemoryModal: React.FC<AiMemoryModalProps> = ({ isOpen, entries, onChange, onClose }) => {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) { setDraft(""); setEditingId(null); }
  }, [isOpen]);

  const addEntry = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...entries, { id: newId(), text, enabled: true }]);
    setDraft("");
    inputRef.current?.focus();
  };

  const toggle = (id: string) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)));

  const remove = (id: string) => onChange(entries.filter((e) => e.id !== id));

  const startEdit = (entry: AiPromptEntry) => { setEditingId(entry.id); setEditText(entry.text); };

  const saveEdit = () => {
    const text = editText.trim();
    if (!text) { setEditingId(null); return; }
    onChange(entries.map((e) => (e.id === editingId ? { ...e, text } : e)));
    setEditingId(null);
  };

  const enabledCount = entries.filter((e) => e.enabled).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="AI 记忆 / 前置提示词">
      <div className="space-y-4">
        <p className="text-xs text-slate-500 leading-relaxed">
          启用中的每一条都会加在<strong className="text-slate-600">每次请求</strong>的系统提示词末尾。
          既可以用作默认要求（例如"回答先给结论""始终用简体中文"），也可以当作长期记忆
          （例如"我是前端开发者，常写技术笔记"）。
        </p>

        {/* 新增 */}
        <div className="space-y-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addEntry(); }
            }}
            rows={2}
            placeholder="输入一条要求或记忆，回车添加（Shift+回车换行）"
            className="w-full resize-none px-3 py-2 text-xs input-modern bg-slate-50/50 focus:bg-white transition-colors"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">回车即可添加</span>
            <button
              onClick={addEntry}
              disabled={!draft.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              添加
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div className="max-h-[46vh] overflow-y-auto chat-scrollbar -mx-1 px-1 space-y-2">
          {entries.length === 0 && (
            <div className="py-6 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl">
              还没有内容。添加一条试试，例如「回答尽量简短，先给结论」。
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`group rounded-xl border px-3 py-2 transition-colors ${
                entry.enabled ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/60"
              }`}
            >
              {editingId === entry.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    rows={2}
                    autoFocus
                    className="w-full resize-none px-2.5 py-1.5 text-xs input-modern bg-white"
                  />
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => setEditingId(null)} className="px-2.5 py-1 text-[11px] text-slate-500 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">取消</button>
                    <button onClick={saveEdit} className="px-2.5 py-1 text-[11px] text-white bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors">保存</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <button
                    onClick={() => toggle(entry.id)}
                    title={entry.enabled ? "已启用，点击停用" : "已停用，点击启用"}
                    aria-pressed={entry.enabled}
                    className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${
                      entry.enabled ? "bg-primary-500 border-primary-500 text-white" : "bg-white border-slate-300"
                    }`}
                  >
                    {entry.enabled && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    )}
                  </button>
                  <p className={`flex-1 min-w-0 text-xs leading-relaxed whitespace-pre-wrap break-words ${entry.enabled ? "text-slate-700" : "text-slate-400"}`}>
                    {entry.text}
                  </p>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(entry)} className="px-1.5 py-1 text-[11px] text-slate-400 hover:text-primary-500 rounded-md hover:bg-primary-50 transition-colors">编辑</button>
                    <button onClick={() => remove(entry.id)} className="px-1.5 py-1 text-[11px] text-slate-400 hover:text-red-500 rounded-md hover:bg-red-50 transition-colors">删除</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-slate-100">
          <span className="text-[11px] text-slate-400">
            共 {entries.length} 条，其中 <strong className="text-slate-600">{enabledCount}</strong> 条已启用
          </span>
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
            完成
          </button>
        </div>
      </div>
    </Modal>
  );
};
