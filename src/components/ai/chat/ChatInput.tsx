import type { RefObject } from "react";
import { Icon } from "@/components/common/Icon";
import { ChatComposer, type ChatComposerHandle } from "@/components/ai/ChatComposer";
import { AiConfirmCard } from "@/components/ai/AiConfirmCard";
import { useI18n } from "@/i18n";
import type { ToolCall } from "@/interface/ai/aiOutput";

export function ChatInput({
  pendingConfirm, confirmSummary, onConfirmRun, onConfirmCancel,
  composerDragging, onComposerResizeMouseDown, onComposerResizeDoubleClick,
  modelMenuOpen, modelMenuPos, modelMenuRef, models, activeModel, hasProvider,
  onSelectModel, onCloseModelMenu, onOpenProviderSettings, modelChipRef, onToggleModelMenu,
  input, onInputChange, onSend, onStop, isSending, canRecall, onRecall, placeholder,
  compact, showCount, inputLength, confirmMode, onToggleConfirmMode, attachNote, onToggleAttachNote,
  noteContent, noteTitle, currentLevel, aiAccessEnabled, messagesCount, onClear,
  inputRef,
}: {
  pendingConfirm: { call: ToolCall; index: number; total: number } | null;
  confirmSummary: string;
  onConfirmRun: () => void;
  onConfirmCancel: () => void;
  composerDragging: boolean;
  onComposerResizeMouseDown: (e: React.MouseEvent) => void;
  onComposerResizeDoubleClick: () => void;
  modelMenuOpen: boolean;
  modelMenuPos: { bottom: number; left: number; width: number } | null;
  modelMenuRef: RefObject<HTMLDivElement | null>;
  models: string[];
  activeModel: string;
  hasProvider: boolean;
  onSelectModel: (model: string) => void;
  onCloseModelMenu: () => void;
  onOpenProviderSettings: () => void;
  modelChipRef: RefObject<HTMLButtonElement | null>;
  onToggleModelMenu: () => void;
  input: string;
  onInputChange: (content: string) => void;
  onSend: () => void;
  onStop: () => void;
  isSending: boolean;
  canRecall: boolean;
  onRecall: () => void;
  placeholder: string;
  compact: boolean;
  showCount: boolean;
  inputLength: number;
  confirmMode: boolean;
  onToggleConfirmMode: () => void;
  attachNote: boolean;
  onToggleAttachNote: () => void;
  noteContent: string;
  noteTitle: string;
  currentLevel: number;
  aiAccessEnabled: boolean;
  messagesCount: number;
  onClear: () => void;
  inputRef: RefObject<ChatComposerHandle | null>;
}) {
  const { t } = useI18n();
  return (
    <div className={"composer-wrap relative flex-shrink-0" + (composerDragging ? " is-resizing" : "")}>
      {pendingConfirm && (
        <AiConfirmCard
          call={pendingConfirm.call}
          index={pendingConfirm.index}
          total={pendingConfirm.total}
          summary={confirmSummary}
          onRun={onConfirmRun}
          onCancel={onConfirmCancel}
        />
      )}
      <div
        className={"composer-resize" + (composerDragging ? " is-dragging" : "")}
        onMouseDown={onComposerResizeMouseDown}
        onDoubleClick={onComposerResizeDoubleClick}
        title={t("上下拖动调整输入框高度（双击恢复自动高度）")}
      />

      {/* 模型下拉：fixed 定位，紧贴在模型 chip 按钮上方 */}
      {modelMenuOpen && modelMenuPos && (
        <div
          className="fixed composer-menu chat-scrollbar"
          ref={modelMenuRef}
          style={{
            bottom: modelMenuPos.bottom,
            left: Math.max(8, modelMenuPos.left),
            minWidth: modelMenuPos.width,
            maxWidth: 280,
          }}
        >
          {models.length === 0 ? (
            <div className="px-3 py-2 text-[11.5px] text-faint">{t("还没有勾选可用模型")}</div>
          ) : models.map((m) => (
            <button
              key={m}
              className={"composer-menu-item" + (m === activeModel ? " is-active" : "")}
              onClick={() => onSelectModel(m)}
            >
              <Icon name="ai-check" className={"w-3 h-3 flex-shrink-0 " + (m === activeModel ? "opacity-100" : "opacity-0")} />
              <span className="truncate">{m}</span>
            </button>
          ))}
          <div className="composer-menu-sep" />
          <button className="composer-menu-item" onClick={() => { onCloseModelMenu(); onOpenProviderSettings(); }}>
            <Icon name="ai-settings-bold" className="w-3 h-3 flex-shrink-0" />
            <span>{t("管理模型 / 服务商…")}</span>
          </button>
        </div>
      )}

      <div className="composer-card">
        <ChatComposer
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          onStop={onStop}
          isSending={isSending}
          canRecall={canRecall}
          onRecall={onRecall}
          placeholder={placeholder}
        />
        <div className="composer-foot">
          {/* 左：模型 + 附加选项。整组可压缩、超出裁掉，绝不把右边的按钮顶出去 */}
          <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
            <button
              ref={modelChipRef}
              className={"composer-chip is-shrinkable" + (modelMenuOpen ? " is-on" : "")}
              onClick={onToggleModelMenu}
              disabled={!hasProvider}
              title={models.length === 0 ? t("尚未勾选模型，点开去设置") : t("当前模型：{model}（点击切换）", { model: activeModel || t("未选") })}
            >
              <Icon name="ai-monitor" className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{models.length === 0 ? (hasProvider ? t("未勾选模型") : t("无服务商")) : (activeModel || t("选择模型"))}</span>
              <Icon name="ai-chevron-up" className={"w-2.5 h-2.5 flex-shrink-0 transition-transform " + (modelMenuOpen ? "rotate-180" : "")} />
            </button>

            {models.length === 0 && hasProvider && (
              <button className="composer-chip is-warn" onClick={onOpenProviderSettings} title={t("尚未勾选模型，点击去设置")}>
                <Icon name="ai-alert-triangle" className="w-3 h-3 flex-shrink-0" />
                {!compact && <span>{t("去设置")}</span>}
              </button>
            )}

            <button
              className={"composer-chip" + (confirmMode ? " is-on" : "") + (compact ? " is-compact" : "")}
              onClick={onToggleConfirmMode}
              title={confirmMode ? t("写操作执行前需要确认（点击改为自动执行）") : t("写操作直接执行（点击改为需确认）")}
            >
              <Icon name="ai-shield-check" className="w-3 h-3 flex-shrink-0" />
              {!compact && <span>{confirmMode ? t("需确认") : t("自动")}</span>}
            </button>

            {noteContent ? (
              currentLevel === 0 ? (
                // 禁止档不提供"附笔记"开关：开关本身没有意义，只会误导用户以为点了就能附上
                <span
                  className={"composer-chip is-warn" + (compact ? " is-compact" : "")}
                  title={
                    aiAccessEnabled
                      ? t("当前笔记对 AI 禁止访问，正文不会作为上下文发送（可在「笔记属性」或设置 → AI 访问权限里改）")
                      : t("已关闭「允许 AI 访问笔记」，正文不会作为上下文发送（设置 → AI 访问权限）")
                  }
                >
                  <Icon name="ai-shield-check" className="w-3 h-3 flex-shrink-0" />
                  {!compact && <span>{t("未授权")}</span>}
                </span>
              ) : (
                <>
                  <button
                    className={"composer-chip" + (attachNote ? " is-on" : "") + (compact ? " is-compact" : "")}
                    onClick={onToggleAttachNote}
                    title={attachNote ? t("已附上当前笔记《{title}》作为上下文（点击取消）", { title: noteTitle || t("未命名") }) : t("不附上当前笔记（点击改为附上）")}
                  >
                    <Icon name="ai-file-text" className="w-3 h-3 flex-shrink-0" />
                    {!compact && <span>{t("附笔记")}</span>}
                  </button>
                  {/* 只读档：能读不能改，提前告知，省得模型反复尝试写入后失败 */}
                  {currentLevel === 1 && (
                    <span
                      className={"composer-chip is-warn" + (compact ? " is-compact" : "")}
                      title={t("当前笔记对 AI 只读：可以阅读和总结，但不会替用户修改（在「笔记属性」里可改为完全）")}
                    >
                      <Icon name="ai-shield-check" className="w-3 h-3 flex-shrink-0" />
                      {!compact && <span>{t("只读")}</span>}
                    </span>
                  )}
                </>
              )
            ) : null}
          </div>

          {/* 右：字数（够宽才显示）+ 清空 + 发送/停止。固定不压缩，保证永远点得到 */}
          {showCount && inputLength > 0 && (
            <span className={"text-[10.5px] tabular-nums flex-shrink-0 " + (inputLength > 2000 ? "text-warning" : "text-faint-soft")} title={inputLength > 2000 ? t("内容较长，发送前会先做瘦身") : ""}>
              {inputLength > 2000 ? t("{count} 字 · 较长", { count: inputLength }) : t("{count} 字", { count: inputLength })}
            </span>
          )}
          {messagesCount > 0 && !isSending && (
            <button
              className="p-1.5 rounded-lg text-faint-soft hover:text-danger hover:bg-danger-soft transition-colors"
              title={t("清空当前会话的显示内容")}
              onClick={onClear}
            >
              <Icon name="ai-trash" className="w-3.5 h-3.5" />
            </button>
          )}
          {isSending ? (
            <button className="composer-send composer-stop" onClick={onStop} title={t("停止生成（Esc）")} aria-label={t("停止生成")}>
              <Icon name="ai-stop" className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              className="composer-send"
              onClick={onSend}
              disabled={!input.trim() || !activeModel}
              title={!activeModel ? t("请先选择模型") : t("发送（Enter）")}
              aria-label={t("发送")}
            >
              <Icon name="ai-send" className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="composer-hint">
        {compact ? t("Enter 发送 · Shift+Enter 换行") : t("Enter 发送 · Shift+Enter 换行 · Esc {action} · ↑ 召回上一条 · 拖上边缘调高度（双击复位）", { action: isSending ? t("停止") : t("清空") })}
      </div>
    </div>
  );
}
