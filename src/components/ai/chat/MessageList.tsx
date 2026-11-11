import type { RefObject } from "react";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";
import type { EditorSettings } from "@/interface/settings/settings";
import type { UiChatMessage } from "./types";
import { ChatMessageRow } from "./MessageItem";
import { AnchorRail } from "./AnchorRail";

/** 空对象常量：给"这一行没有展开任何工具"的行用，保证 props 引用稳定、memo 不失效 */
const NO_OPEN_TOOLS: Record<string, boolean> = {};

export function MessageList({
  messagesAreaRef, scrollRef, scrollContentRef, onScroll, onReleaseJumpTarget,
  hasProvider, enableAI, isExternalFile, activeModel, onOpenProviderSettings, onPickSuggestion,
  allMsgs, groupOpen, thoughtOpen, toolOpenByRow, liveRowIndex, isSending, showToolTrace, editorSettings,
  onToggleGroup, onToggleThought, onToggleTool, onInsertText, onReplaceContent, onCopyText, onOpenInEditor,
  streamingReply, elapsedSec, userAnchors, visibleAnchors, activeDotIndex, railGap, onJump, onHover, onLeave,
  anchorTip, atBottom, onJumpLatest,
}: {
  messagesAreaRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollContentRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onReleaseJumpTarget: () => void;
  hasProvider: boolean;
  enableAI?: boolean;
  isExternalFile?: boolean;
  activeModel: string;
  onOpenProviderSettings: () => void;
  onPickSuggestion: (source: string) => void;
  allMsgs: UiChatMessage[];
  groupOpen: Record<number, boolean>;
  thoughtOpen: Record<number, boolean>;
  toolOpenByRow: Record<number, Record<string, boolean>>;
  liveRowIndex: number;
  isSending: boolean;
  showToolTrace: boolean;
  editorSettings?: EditorSettings;
  onToggleGroup: (i: number, open: boolean) => void;
  onToggleThought: (i: number) => void;
  onToggleTool: (key: string) => void;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
  onCopyText: (text: string) => void;
  onOpenInEditor: (content: string) => void;
  streamingReply?: string;
  elapsedSec: number;
  userAnchors: { index: number; preview: string }[];
  visibleAnchors: { index: number; preview: string }[];
  activeDotIndex: number;
  railGap: number;
  onJump: (originalIndex: number) => void;
  onHover: (originalIndex: number, el: HTMLElement) => void;
  onLeave: () => void;
  anchorTip: { index: number; top: number; visible: boolean };
  atBottom: boolean;
  onJumpLatest: () => void;
}) {
  const { t } = useI18n();
  return (
    <div ref={messagesAreaRef} className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onReleaseJumpTarget}
        onTouchStart={onReleaseJumpTarget}
        className="flex-1 min-h-0 overflow-y-auto pl-3 py-3 pr-9 chat-scrollbar [overflow-anchor:none]"
      >
        {/* 内容包裹层：给它挂 ResizeObserver，任何"之后再长高"都能重新贴底 */}
        <div ref={scrollContentRef} className="space-y-4">
          {!hasProvider ? (
            <div className="ai-empty">
              <div className="ai-empty-icon"><Icon name="ai-bolt" className="w-5 h-5" /></div>
              <p className="ai-empty-title">{t("还没有可用的 AI 服务商")}</p>
              <p className="ai-empty-desc">{t("填一个 API Key 就能用：支持 OpenAI 兼容 / Claude / Gemini 协议。")}</p>
              <button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs mt-3">{t("去配置服务商")}</button>
            </div>
          ) : enableAI && isExternalFile ? (
            <div className="ai-empty">
              <div className="ai-empty-icon"><Icon name="ai-file-text" className="w-5 h-5" /></div>
              <p className="ai-empty-title">{t("AI 无法读取内容")}</p>
              <p className="ai-empty-desc">
                {t("请先保存该文件到分组，再使用 AI 功能。")}
              </p>
            </div>
          ) : allMsgs.length === 0 ? (
            <div className="ai-empty">
              <div className="ai-empty-icon"><Icon name="ai-sparkles" className="w-5 h-5" /></div>
              <p className="ai-empty-title">{activeModel ? t("开始对话") : t("还没有勾选模型")}</p>
              <p className="ai-empty-desc">
                {activeModel
                  ? t("可以让它整理笔记、改写润色、查找内容，也可以直接问问题。")
                  : t("在设置里获取并勾选一个模型即可开始。")}
              </p>
              {activeModel ? (
                <div className="ai-empty-chips">
                  {["总结当前这篇笔记", "把这篇文章扩写", "新建一篇读书笔记", "我的笔记都写了什么"].map((source) => (
                    <button key={source} className="ai-empty-chip" onClick={() => onPickSuggestion(source)}>{t(source)}</button>
                  ))}
                </div>
              ) : (
                <button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs mt-3">{t("打开设置")}</button>
              )}
            </div>
          ) : (allMsgs.map((msg, i) => (
            <ChatMessageRow
              key={i}
              msg={msg}
              index={i}
              expanded={groupOpen[i] ?? (i === liveRowIndex)}
              thoughtOpen={!!thoughtOpen[i]}
              toolOpen={toolOpenByRow[i] || NO_OPEN_TOOLS}
              live={i === liveRowIndex}
              isSending={isSending}
              showToolTrace={showToolTrace}
              editorSettings={editorSettings}
              onToggleGroup={onToggleGroup}
              onToggleThought={onToggleThought}
              onToggleTool={onToggleTool}
              onInsertText={onInsertText}
              onReplaceContent={onReplaceContent}
              onCopyText={onCopyText}
              onOpenInEditor={onOpenInEditor}
            />
          )))}
          {isSending && (
            <div className="ai-thinking-live">
              <span className="thinking-dots"><span /><span /><span /></span>
              <span>{streamingReply ? t("生成中") : t("思考中")}</span>
              {elapsedSec > 0 && <span className="elapsed">{elapsedSec}s</span>}
            </div>
          )}
        </div>
      </div>

      {/* 右侧垂直居中的历史锚点：一眼看出发过几次提问，点一下跳到那次提问 */}
      {userAnchors.length >= 2 && (
        <>
          <AnchorRail
            anchors={visibleAnchors}
            activeOriginal={activeDotIndex}
            gap={railGap}
            onJump={onJump}
            onHover={onHover}
            onLeave={onLeave}
            onScroll={onLeave}
          />
          {/* 悬浮气泡：放在导轨外面，否则会被导轨的滚动容器裁掉 */}
          <div
            className={"chat-anchor-tip-floating" + (anchorTip.visible ? " is-visible" : "")}
            style={{ top: anchorTip.top }}
            aria-hidden="true"
          >
            {userAnchors[Math.min(anchorTip.index, userAnchors.length - 1)]?.preview}
          </div>
        </>
      )}

      {/* 滚轮上滑查看历史时出现：一键回到最新回复并恢复自动跟随 */}
      {!atBottom && allMsgs.length > 0 && (
        <button
          type="button"
          className="chat-jump-latest absolute right-8 bottom-3 z-20"
          onClick={onJumpLatest}
          title={t("回到最新回复")}
          aria-label={t("回到最新回复")}
        >
          <Icon name="ai-arrow-down" className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
