import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as api from "../api";
import { AiChatMessage, AiChatSession, AiProvider } from "../types";
import { useToast } from "./Toast";
import { MdPreview } from "md-editor-rt";
import "md-editor-rt/lib/style.css";

interface AIChatPanelProps { isOpen: boolean; noteTitle: string; noteContent: string; onInsertText: (text: string) => void; onReplaceContent: (text: string) => void; onOpenProviderSettings: () => void; }

const MIN_PANEL_WIDTH = 320; const MAX_PANEL_WIDTH = 640; const DEFAULT_PANEL_WIDTH = 400;

export const AIChatPanel: React.FC<AIChatPanelProps> = ({ isOpen, noteTitle, noteContent, onInsertText, onReplaceContent, onOpenProviderSettings }) => {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<number>(0);
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number>(0);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [models, setModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const { showToast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleGenRef = useRef(false);
  const abortRef = useRef(false);
  const activeProvider = useMemo(() => providers.find((p) => p.id === selectedProviderId) || null, [providers, selectedProviderId]);

  useEffect(() => { if (!isOpen) return; loadProviders(); loadSessions(); }, [isOpen]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, streamingContent]);
  useEffect(() => { if (sessions.length > 0 && !activeSessionId) { setActiveSessionId(sessions[0].id); loadSessionMessages(sessions[0].id); } }, [sessions]);
  useEffect(() => { if (!activeProvider) { setModels([]); return; } setIsFetchingModels(true); api.fetchAiModels(activeProvider).then(f => { if (f.length > 0) setModels(f); else if (activeProvider.enabled_model) setModels([activeProvider.enabled_model]); }).catch(() => { if (activeProvider.enabled_model) setModels([activeProvider.enabled_model]); }).finally(() => setIsFetchingModels(false)); }, [activeProvider]);

  const loadProviders = async () => { try { const list = await api.getAiProviders(); setProviders(list); if (list.length > 0 && !selectedProviderId) setSelectedProviderId(list[0].id); } catch {} };
  const loadSessions = async () => { try { setSessions(await api.getChatSessions()); } catch {} };
  const loadSessionMessages = async (sid: number) => { try { const m = await api.getChatMessages(sid); setMessages(m.map(x => ({ role: x.role as "user"|"assistant", content: x.content }))); } catch {} };
  const ensureSession = async (): Promise<number> => { if (activeSessionId) return activeSessionId; const s = await api.createChatSession("新对话", selectedProviderId, activeProvider?.enabled_model || ""); setSessions(p => [s, ...p]); setActiveSessionId(s.id); return s.id; };
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; setActiveSessionId(sid); setStreamingContent(""); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { const s = await api.createChatSession("新对话", selectedProviderId, activeProvider?.enabled_model || ""); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); setStreamingContent(""); titleGenRef.current = false; };
  const handleDeleteSession = async () => { if (!activeSessionId) return; try { await api.deleteChatSession(activeSessionId); setSessions(p => p.filter(x => x.id !== activeSessionId)); const r = sessions.filter(x => x.id !== activeSessionId); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = false; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } catch { showToast("删除失败", "error"); } };
  const genTitle = async (sid: number, up: string, ar: string) => { if (titleGenRef.current || !activeProvider) return; titleGenRef.current = true; try { const t = await api.sendAiChat(activeProvider.id, [{ role: "system", content: "概括对话主题，4-10字标题" }, { role: "user", content: up }, { role: "assistant", content: ar }], "", ""); const ct = t.replace(/["「」『』]/g, "").trim().slice(0, 30) || "新对话"; await api.updateChatSessionTitle(sid, ct); await loadSessions(); } catch {} };

  const handleRenameSession = async (sid: number) => { const title = editTitle.trim(); if (!title) return; try { await api.updateChatSessionTitle(sid, title); setEditingSessionId(null); setEditTitle(""); await loadSessions(); } catch { showToast("重命名失败", "error"); } };

  const handleStop = () => { abortRef.current = true; setMessages(m => [...m, { role: "assistant", content: "已停止" }]); setIsSending(false); setStreamingContent(""); };

  const handleSend = async () => { const prompt = input.trim(); if (!prompt || isSending) return; if (!activeProvider?.id || !activeProvider.enabled_model) { showToast("", "error"); return; } abortRef.current = false; const sid = await ensureSession(); const userMsg: AiChatMessage = { role: "user", content: prompt }; const nextMsgs = [...messages, userMsg]; setMessages(nextMsgs); setInput(""); setIsSending(true); setStreamingContent(""); try { await api.saveChatMessage(sid, "user", prompt); } catch {} try { const full = await api.sendAiChatStream(activeProvider.id, nextMsgs, noteTitle||"", noteContent, c => { if (!abortRef.current) setStreamingContent(c); }); if (abortRef.current) return; setMessages(m => [...m, { role: "assistant", content: full }]); setStreamingContent(""); try { await api.saveChatMessage(sid, "assistant", full); } catch {} if (nextMsgs.length <= 2 && !titleGenRef.current) genTitle(sid, prompt, full); await loadSessions(); } catch (e) { console.error(e); showToast(String(e||""), "error"); setStreamingContent(""); setMessages(messages); } finally { setIsSending(false); inputRef.current?.focus(); } };

  const onResize = useCallback(() => { dragRef.current = true; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; const mm = (e: MouseEvent) => { if (!dragRef.current) return; setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - e.clientX))); }; const mu = () => { dragRef.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); }; document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu); }, []);

  const activeModel = activeProvider?.enabled_model || "";
  if (!isOpen) return null;
  const allMsgs = streamingContent ? [...messages, { role: "assistant" as const, content: streamingContent }] : messages;

  return (<>
    <aside className="flex-shrink-0 border-l border-slate-200/80 bg-white flex flex-col h-full animate-slideInRight relative" style={{ width: panelWidth }}>
      <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-200/50 active:bg-primary-300/50 transition-colors z-10" onMouseDown={onResize}/>
      <div className="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <button onClick={() => { setShowSessionPicker(true); setEditingSessionId(null); setEditTitle(""); }} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 hover:border-slate-300 transition-colors max-w-[180px] truncate text-left flex items-center gap-1.5 flex-1">
            <svg className="w-3 h-3 flex-shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16"/></svg>
            <span className="truncate">{sessions.find(s => s.id === activeSessionId)?.title || "新对话"}</span>
          </button>
          <button onClick={handleNewSession} className="toolbar-btn !w-6 !h-6 flex-shrink-0" title=""><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg></button>
          {activeSessionId > 0 && (<button onClick={handleDeleteSession} className="toolbar-btn !w-6 !h-6 flex-shrink-0 hover:!text-red-500" title=""><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>)}
        </div>
        <button className="toolbar-btn !w-7 !h-7 flex-shrink-0" title="" onClick={onOpenProviderSettings}><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg></button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 chat-scrollbar">
        {!activeProvider ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div><p className="empty-state-title">暂无配置</p><p className="empty-state-desc">请先配置 AI 服务商</p><button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs">立即配置</button></div>
        ) : allMsgs.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg></div><p className="empty-state-title">{activeModel ? "开始对话" : "请选择模型"}</p><p className="empty-state-desc">{activeModel ? "输入你的问题" : "在配置中选择模型"}</p></div>
        ) : (allMsgs.map((msg, i) => {
          const isLast = isSending && i === allMsgs.length - 1;
          return (<div key={i} className={"flex items-end gap-2.5 animate-fade-in " + (msg.role === "user" ? "flex-row-reverse" : "flex-row")} style={{ animationDelay: (i * 30) + "ms" }}>
            {msg.role === "assistant" ? (
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center flex-shrink-0 shadow-sm mt-1"><svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div>
            ) : (
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center flex-shrink-0 shadow-sm mt-1"><svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg></div>
            )}
            <div className="flex flex-col max-w-[85%] min-w-0">
              {msg.role === "user" ? (
                <div className="rounded-2xl rounded-br-md px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-gradient-to-br from-primary-500 to-primary-600 text-white shadow-sm">{msg.content}</div>
              ) : (
                <div className="rounded-2xl rounded-bl-md px-3.5 py-2 bg-white border border-slate-200/70 text-slate-700 shadow-sm">
                  <div className="ai-markdown text-xs leading-relaxed">
                    <MdPreview modelValue={msg.content} theme="light" previewTheme="github" codeTheme="github" noMermaid={false} noKatex={false} noHighlight={false}/>
                  </div>
                  {msg.role === "assistant" && !isLast && (<div className="mt-2 pt-2 border-t border-slate-100 flex gap-1.5">
                    <button onClick={() => onInsertText(msg.content)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 bg-slate-50 hover:bg-primary-50 hover:text-primary-500 transition-colors active:scale-95"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>插入</button>
                    <button onClick={() => onReplaceContent(msg.content)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 bg-slate-50 hover:bg-amber-50 hover:text-amber-600 transition-colors active:scale-95"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>替换</button>
                  </div>)}
                </div>
              )}
            </div>
          </div>);
        }))}
        {isSending && !streamingContent && (<div className="flex justify-start"><div className="text-xs text-slate-400 px-3 py-2 bg-slate-50 rounded-xl inline-flex items-center gap-2"><span className="thinking-dots"><span/><span/><span/></span>思考中</div></div>)}
      </div>
      <div className="border-t border-slate-200/60 bg-white px-4 py-2.5 space-y-2 flex-shrink-0">
        <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) { const t = inputRef.current; if (t) { const s = t.selectionStart; setInput(input.slice(0, s) + "\n" + input.slice(t.selectionEnd)); } return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); isSending ? handleStop() : handleSend(); } }} placeholder="" rows={2} className="w-full resize-none px-3 py-2 text-xs input-modern bg-slate-50/50 focus:bg-white transition-colors" style={{ minHeight: "56px", maxHeight: "100px" }}/>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 flex-1">
            <button onClick={() => { setMessages([]); setStreamingContent(""); }} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" disabled={messages.length === 0}><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>清空</button>
          </div>
          <div className="relative">
            <select value={activeModel} onChange={e => { if (e.target.value && activeProvider) { const u = { ...activeProvider, enabled_model: e.target.value }; api.updateAiProvider(u).then(() => setProviders(p => p.map(x => x.id === u.id ? u : x))); } }} className="appearance-none bg-transparent text-xs text-slate-500 cursor-pointer min-w-[120px] max-w-[200px] pr-4 pl-1 py-1 truncate outline-none focus:outline-none focus:ring-0 ring-0 active:ring-0" disabled={!activeProvider || isFetchingModels} style={{ boxShadow: "none", WebkitBoxShadow: "none" }}>
              <option value="">{isFetchingModels ? "加载中..." : activeProvider ? activeModel || "选择模型" : "无可用模型"}</option>
              {models.map(m => (<option key={m} value={m}>{m}</option>))}
              {activeProvider?.enabled_model && !models.includes(activeProvider.enabled_model) && (<option value={activeProvider.enabled_model}>{activeProvider.enabled_model}</option>)}
            </select>
            <svg className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
          </div>
          {isSending ? (
            <button onClick={handleStop} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-white bg-red-500 hover:bg-red-600 shadow-sm transition-all active:scale-[0.97]"><svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>停止</button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim() || !activeProvider?.enabled_model} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium text-white bg-gradient-to-r from-primary-500 to-primary-600 shadow-md hover:shadow-lg hover:from-primary-600 hover:to-primary-700 transition-all active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>发送</button>
          )}
        </div>
      </div>
    </aside>
    {showSessionPicker && (<div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setShowSessionPicker(false)}>
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
      <div className="relative bg-white rounded-xl shadow-2xl border border-slate-200/80 w-72 max-h-[50vh] overflow-y-auto p-2 animate-fade-in" onClick={e => e.stopPropagation()}>
        {sessions.length === 0 ? (<div className="text-xs text-slate-400 text-center py-6">暂无对话</div>) : sessions.map(s => (
          <div key={s.id} className={"flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors " + (s.id === activeSessionId ? "bg-primary-50 text-primary-600" : "hover:bg-slate-50 text-slate-600")} onClick={() => { switchSession(s.id); setShowSessionPicker(false); }}>
            <div className="flex-1 min-w-0">
              {editingSessionId === s.id ? (
                <input autoFocus className="w-full border border-primary-300 rounded px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-primary-500/20" value={editTitle} onChange={e => setEditTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleRenameSession(s.id); if (e.key === "Escape") { setEditingSessionId(null); setEditTitle(""); } }} onBlur={() => { setEditingSessionId(null); setEditTitle(""); }}/>
              ) : (
                <span className="truncate block">{s.title || "新对话"}</span>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              <button onClick={e => { e.stopPropagation(); setEditingSessionId(s.id); setEditTitle(s.title); }} className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-primary-500 hover:bg-primary-50 transition-colors" title="重命名"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>
              <button onClick={async e => { e.stopPropagation(); try { await api.deleteChatSession(s.id); setSessions(p => p.filter(x => x.id !== s.id)); if (activeSessionId === s.id) { const r = sessions.filter(x => x.id !== s.id); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = false; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } } catch { showToast("删除失败", "error"); } }} className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="删除"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
            </div>
          </div>
        ))}
      </div>
    </div>)}
  </>);
};
