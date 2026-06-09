import * as fs from "fs";

// Fix AIChatPanel.tsx
let c = fs.readFileSync("src/components/AIChatPanel.tsx", "utf8");

// 1. Fix handleSend context - pass full message history
c = c.replace(
  "await agentLoop(sid, [userMsg], prompt); await loadSessions(); try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); } catch {}",
  "await agentLoop(sid, [...messages, userMsg], prompt); await loadSessions(); try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); } catch {}"
);

// 2. Fix AI message rendering - skip FastNote label for consecutive assistant msgs
// Find the FastNote label div and wrap it with a condition
c = c.replace(
  'return (<div key={i} className="animate-fade-in" style={{ animationDelay: (i * 30) + "ms" }}>\n            <div className="flex items-center gap-1.5 mb-1">\n              <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div>\n              <span className="text-xs font-medium text-slate-500">FastNote 助手</span>\n            </div>',
  'return (<div key={i} className="animate-fade-in" style={{ animationDelay: (i * 30) + "ms" }}>\n            {(!allMsgs[i-1] || allMsgs[i-1].role !== "assistant") && (<div className="flex items-center gap-1.5 mb-1">\n              <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div>\n              <span className="text-xs font-medium text-slate-500">FastNote 助手</span>\n            </div>)}'
);

// 3. Fix handleStop - ensure it adds "已停止" message
c = c.replace(
  "const handleStop = () => { abortRef.current = true; setMessages(m => [...m, { role: 'assistant', content: '已停止' }]); setIsSending(false); setStreamingContent(''); };",
  "const handleStop = () => { abortRef.current = true; setMessages(m => [...m, { role: 'assistant', content: '已停止' }]); setIsSending(false); setStreamingContent(''); if (activeSessionId) api.saveChatMessage(activeSessionId, 'assistant', '已停止').catch(()=>{}); };"
);

fs.writeFileSync("src/components/AIChatPanel.tsx", c, "utf8");
console.log("AIChatPanel.tsx patched: " + c.length + " bytes");

// Fix App.tsx - add event listener for fastnote-data-changed
let a = fs.readFileSync("src/App.tsx", "utf8");

// Add listener after the contextmenu listener cleanup section
// Find the useEffect that sets up contextmenu listener
a = a.replace(
  '    document.addEventListener("contextmenu", handleContextMenu);\n    return () => document.removeEventListener("contextmenu", handleContextMenu);\n  }, []);',
  '    document.addEventListener("contextmenu", handleContextMenu);\n    return () => document.removeEventListener("contextmenu", handleContextMenu);\n  }, []);\n\n  useEffect(() => {\n    const handler = () => loadData();\n    window.addEventListener("fastnote-data-changed", handler);\n    return () => window.removeEventListener("fastnote-data-changed", handler);\n  }, [loadData]);'
);

fs.writeFileSync("src/App.tsx", a, "utf8");
console.log("App.tsx patched: " + a.length + " bytes");
