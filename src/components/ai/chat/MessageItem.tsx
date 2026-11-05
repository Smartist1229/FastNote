import { memo, useMemo } from "react";
import { Icon } from "@/components/common/Icon";
import { AiMarkdown } from "@/components/ai/AiMarkdown";
import { ChatNoteRefChip } from "@/components/ai/ChatNoteRefChip";
import { t as translate, useI18n } from "@/i18n";
import { estimateTokens } from "@/lib/ai/aiParse/context";
import { expandRefs, splitContent } from "@/lib/ai/aiParse/noteRef";
import { firstLine } from "@/lib/ai/aiParse/text";
import { toolDetail } from "@/lib/ai/tools";
import type { EditorSettings } from "@/interface/settings/settings";
import type { UiChatMessage } from "./types";
import { CONFIRM_CANCELLED, renderUiNotice } from "./utils";
import { ToolCallBlock } from "./ToolCallBlock";

/** 消息操作按钮：只有小图标、不带文字 */
const MSG_ACTION_BTN =
  "inline-flex items-center justify-center p-1 rounded-lg text-faint hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-95";

/** 复制图标 */
const CopyIcon = ({ className = "w-3.5 h-3.5" }: { className?: string }) => (
  <Icon name="ai-copy" className={className} />
);

/**
 * 一条消息占用的 token 估算。AI 回复把「思考过程 + 工具调用与结果」一并计入，
 * 因为它们同样要回传给模型、同样占上下文。
 * 复用上下文预算的同一套估算规则，保证两处口径一致。
 */
const msgTokens = (msg: UiChatMessage): number => {
  // 用户消息里的引用块按正文计（JSON 包装只是协议开销，不该算进"这条消息有多少字"）
  const parts = [msg.role === "user" ? expandRefs(msg.content || "") : msg.content || ""];
  if (msg.thinking) parts.push(msg.thinking);
  if (msg.tools?.length) parts.push(JSON.stringify(msg.tools));
  return estimateTokens(parts.join("\n"));
};

/** token 数展示：过千用 k，避免窄面板里挤出一长串数字 */
const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * 消息时间显示：今天只显示 时:分，昨天加"昨天"，更早带上日期。
 * 遇到非法/缺失的时间戳返回空串，绝不显示 NaN。
 */
const formatMessageTime = (at: number | undefined, t: typeof translate): string => {
  if (!at || Number.isNaN(at)) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (dayDiff <= 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return t("昨天 {time}", { time: `${hh}:${mm}` });
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${md} ${hh}:${mm}`;
  return `${d.getFullYear()}-${md} ${hh}:${mm}`;
};

/**
 * 单条消息：用户消息用浅色气泡右对齐，AI 回复无气泡、正文直接铺在面板上。
 * memo 是性能关键——流式输出时 streamingContent 每 50ms 变一次，若父组件重渲染穿透下来，
 * 历史消息里每条 AI 回复都要重新解析 markdown，滚动就会卡。
 * 因此父组件传入的回调都做了稳定化，工具展开状态也按行拆分（toolOpen）。
 */
export const ChatMessageRow = memo(function ChatMessageRow({
  msg, index, expanded, thoughtOpen, toolOpen, live, isSending, showToolTrace, editorSettings, onToggleGroup, onToggleThought, onToggleTool, onInsertText, onReplaceContent, onCopyText, onOpenInEditor,
}: {
  msg: UiChatMessage;
  index: number;
  /** 「深度思考」父折叠是否展开（思考中默认展开，回答结束后默认收起） */
  expanded: boolean;
  /** 父折叠里的「思考」子折叠是否展开（默认收起） */
  thoughtOpen: boolean;
  /** 这一行自己的工具展开状态（按行传入，切换某一行不会让整列重渲染） */
  toolOpen: Record<string, boolean>;
  /** 这一行是否正处在"思考/执行中"，用于父折叠上的状态提示 */
  live: boolean;
  isSending: boolean;
  /** 是否显示工具执行轨迹（设置里可关） */
  showToolTrace: boolean;
  /** 「编辑器」分区的设置：传给 AiMarkdown，让代码块外观与笔记一致 */
  editorSettings?: EditorSettings;
  onToggleGroup: (i: number, open: boolean) => void;
  onToggleThought: (i: number) => void;
  onToggleTool: (key: string) => void;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
  onCopyText: (text: string) => void;
  /** 在编辑器里临时打开这条 AI 回复 */
  onOpenInEditor: (content: string) => void;
}) {
  const { t } = useI18n();
  const msgThinking = msg.thinking;
  const msgTools = msg.tools;
  const content = useMemo(() => msg.role === "assistant" && msg.uiNotice
    ? renderUiNotice(msg.uiNotice, msgTools, t)
    : msg.content, [msg.role, msg.uiNotice, msgTools, msg.content, t]);
  const delay = `${Math.min(index, 5) * 15}ms`;
  /** 实际展示的工具轨迹（设置里关掉就当作没有） */
  const traceTools = useMemo(() => showToolTrace && msgTools
    ? msgTools.map(tool => ({ ...tool, detail: tool.result === CONFIRM_CANCELLED
      ? t("用户已取消")
      : toolDetail(tool.name, tool.args ?? {}, tool.result, t) }))
    : [], [showToolTrace, msgTools, t]);
  /** 还有工具没跑完：父折叠上直接标"执行中…" */
  const toolRunning = traceTools.some((t) => t.ok === null || t.ok === undefined);
  /** 只要思考或工具轨迹存在，就把它们统一收进一个「深度思考」父折叠 */
  const hasTrace = !!msgThinking || traceTools.length > 0;
  /** 底部元信息：时间 · 用时 · token（AI 回复的 token 含思考过程与工具调用） */
  const metaText = [
    msg.at ? formatMessageTime(msg.at, t) : "",
    msg.thinkMs ? t("用时 {seconds}s", { seconds: (msg.thinkMs / 1000).toFixed(1) }) : "",
    `${formatTokens(msgTokens(msg))} tok`,
  ].filter(Boolean).join(" · ");

  if (msg.role === 'user') {
    // 用户消息里可能有引用块：按块还原显示，复制时展开成正文
    const segments = splitContent(msg.content);
    return (
      <div data-chat-anchor="true" className="group/msg flex flex-col items-end animate-fade-in" style={{ animationDelay: delay }}>
        <div className="selectable rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap bg-surface-alt text-body max-w-[85%]">
          {segments.map((segment, i) => (
            segment.kind === "text"
              ? <span key={i}>{segment.text}</span>
              : <ChatNoteRefChip key={i} noteRef={segment.ref} />
          ))}
        </div>
        <div className="mt-0.5 mr-1 flex items-center gap-0.5">
          <span className="inline-flex h-[22px] items-center text-[10.5px] leading-none text-faint-soft tabular-nums select-none" title={t("整条消息的估算 token")}>{msg.at ? `${formatMessageTime(msg.at, t)} · ` : ""}{formatTokens(msgTokens(msg))} tok</span>
          <button
            onClick={() => onCopyText(expandRefs(msg.content))}
            className={MSG_ACTION_BTN}
            title={t("复制消息")}
          >
            <CopyIcon />
          </button>
        </div>
      </div>
    );
  }

  // AI 回复不画气泡、头像和名字，正文直接铺开（对齐主流编程 Agent 的视觉）
  return (
    <div className="group/msg animate-fade-in space-y-0.5" style={{ animationDelay: delay }}>
      {hasTrace ? (
        <div className="group/depth">
          {/* 父折叠：思考 + 所有工具调用统一收在这里，思考时展开、回答结束后收起 */}
          <button
            onClick={() => onToggleGroup(index, !expanded)}
            className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-faint hover:text-body transition-colors py-0.5"
            title={expanded ? t("收起思考与工具调用") : t("展开思考与工具调用")}
          >
            <Icon name="ai-lightbulb" className="w-3 h-3 flex-shrink-0" />
            <span className="flex-shrink-0">{t("分析")}</span>
            {/* 父折叠只留标题，不带思考预览：过程内容都在展开后的子折叠里 */}
            <span className="min-w-0 flex-1" />
            {live || toolRunning ? (
              <span className="flex-shrink-0 text-[10.5px] text-primary-400">{toolRunning ? t("执行中…") : t("思考中…")}</span>
            ) : null}
            <span className="flex-shrink-0 text-[10.5px] text-faint-soft opacity-0 group-hover/depth:opacity-100 transition-opacity">
              {expanded ? t("收起") : t("展开")}
            </span>
            <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 transition-transform " + (expanded ? "rotate-90" : "")} />
          </button>
          {expanded && (
            <div className="mt-0.5 ml-[18px] pl-2 border-l border-line-soft space-y-0.5">
              {/* 子折叠 1：思考正文，默认不展开 */}
              {msgThinking ? (
                <div className="group/thinking">
                  <button
                    onClick={() => onToggleThought(index)}
                    className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-faint hover:text-body transition-colors py-0.5"
                    title={thoughtOpen ? t("收起思考过程") : t("展开思考过程")}
                  >
                    <Icon name="ai-lightbulb" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
                    <span className="flex-shrink-0">{t("思考")}</span>
                    {/* 预览始终保留：展开/收起只靠右侧箭头旋转表示，不要把内容换成"收起"两个字 */}
                    <span className="text-faint-soft flex-shrink-0">·</span>
                    <span className="min-w-0 flex-1 truncate">{firstLine(msgThinking)}</span>
                    <span className="flex-shrink-0 text-[10.5px] text-faint-soft opacity-0 group-hover/thinking:opacity-100 transition-opacity">
                      {thoughtOpen ? t("收起") : t("展开")}
                    </span>
                    <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 transition-transform " + (thoughtOpen ? "rotate-90" : "")} />
                  </button>
                  {thoughtOpen && (<div className="thinking-body chat-scrollbar mt-0.5 px-3 py-2 bg-app rounded-lg text-xs text-muted leading-relaxed whitespace-pre-wrap border border-line-soft">{msgThinking}</div>)}
                </div>
              ) : null}
              {/* 子折叠 2…N：每次工具调用一条，默认不展开，点击可看调用 JSON 与执行结果 */}
              {traceTools.map((tool, ti) => {
                const traceKey = `${index}-${ti}`;
                return (
                  <ToolCallBlock
                    key={traceKey}
                    tool={tool}
                    open={!!toolOpen[traceKey]}
                    onToggle={() => onToggleTool(traceKey)}
                  />
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {msg.content ? (
        <div className="text-[13px] leading-[1.75] text-body">
          <AiMarkdown content={content} editorSettings={editorSettings} />
        </div>
      ) : null}
      {/* 时间 + 操作按钮：同一行固定展示（与用户消息对称，AI 这条在左下角） */}
      {(msg.content || msg.at || msg.thinkMs) ? (
        <div className="pt-0.5 flex items-center gap-0.5">
          {msg.content && !isSending && (
            <>
              <button onClick={() => onInsertText(content)} className={MSG_ACTION_BTN} title={t("将内容插入到光标处")}><Icon name="ai-plus" className="w-3.5 h-3.5" /></button>
              <button onClick={() => onReplaceContent(content)} className={`${MSG_ACTION_BTN} hover:text-warning! hover:bg-warning-soft!`} title={t("覆盖当前打开的笔记")}><Icon name="ai-replace" className="w-3.5 h-3.5" /></button>
              <button onClick={() => onCopyText(content)} className={MSG_ACTION_BTN} title={t("复制消息")}><CopyIcon /></button>
              <button onClick={() => onOpenInEditor(content)} className={`${MSG_ACTION_BTN} hover:text-info! hover:bg-info-soft!`} title={t("在编辑器中打开（临时预览，不会保存为笔记）")}><Icon name="open-in-editor" className="w-3.5 h-3.5" /></button>
            </>
          )}
          <span className="inline-flex h-[22px] items-center text-[10.5px] leading-none text-faint-soft tabular-nums select-none" title={t("整条回复的估算 token（含思考过程与工具调用）")}>{metaText}</span>
        </div>
      ) : null}
    </div>
  );
});
