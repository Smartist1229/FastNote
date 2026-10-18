/**
 * 查找 / 替换悬浮框（Ctrl/⌘+F）。
 *
 * 交互对齐 VSCode：一行「折叠开关 + 输入框 + 计数 + 匹配模式 + 上/下/关闭」，
 * 展开后第二行是替换输入与「替换 / 全部替换」。
 *
 * 这里只负责 UI 与键盘，真正的匹配、跳转、改写都在上层（search.ts + MarkdownEditor），
 * 组件本身不持有文档内容，方便外部用 API 直接驱动。
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { MdeIcon } from "../icons";
import type { MarkdownEditorConfig, SearchOptions } from "../types";

export interface SearchBoxProps {
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  query: string;
  replaceText: string;
  options: SearchOptions;
  showReplace: boolean;
  /** 命中总数 */
  matchCount: number;
  /** 当前命中的下标（0 基） */
  matchIndex: number;
  readOnly: boolean;
  /** 每次打开自增，用来重新聚焦并全选输入框 */
  focusToken: number;
  onQueryChange: (value: string) => void;
  onReplaceChange: (value: string) => void;
  onOptionsChange: (options: SearchOptions) => void;
  onToggleReplace: () => void;
  onNext: () => void;
  onPrev: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export const SearchBox = ({
  config,
  labels,
  query,
  replaceText,
  options,
  showReplace,
  matchCount,
  matchIndex,
  readOnly,
  focusToken,
  onQueryChange,
  onReplaceChange,
  onOptionsChange,
  onToggleReplace,
  onNext,
  onPrev,
  onReplace,
  onReplaceAll,
  onClose,
}: SearchBoxProps) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const compact = config.toolbar.compact;

  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.focus();
    element.select();
  }, [focusToken]);

  const toggle = (key: keyof SearchOptions) => onOptionsChange({ ...options, [key]: !options[key] });

  /** Esc 关闭、Enter 下一个、Shift+Enter 上一个、Ctrl+Alt+Enter 全部替换 */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (mod && event.altKey) {
        if (!readOnly) onReplaceAll();
        return;
      }
      if (event.shiftKey) onPrev();
      else onNext();
    }
  };

  const countLabel = !query ? "" : matchCount === 0 ? labels.searchNoResult : `${Math.min(matchIndex + 1, matchCount)}/${matchCount}`;
  const hasMatch = matchCount > 0;

  return (
    <div
      className={`mde-search${compact ? " is-compact" : ""}`}
      role="search"
      aria-label={labels.searchPlaceholder}
      onKeyDown={handleKeyDown}
    >
      <div className="mde-search-row">
        <button
          type="button"
          className="mde-search-icon-btn is-fold"
          title={labels.searchToggleReplace}
          aria-label={labels.searchToggleReplace}
          aria-expanded={showReplace}
          onClick={onToggleReplace}
        >
          <MdeIcon name={showReplace ? "chevron-down" : "chevron-right"} size={14} />
        </button>

        <div className="mde-search-field">
          <input
            ref={inputRef}
            className={`mde-search-input${!query || hasMatch ? "" : " is-empty"}`}
            value={query}
            spellCheck={false}
            placeholder={labels.searchPlaceholder}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label={labels.searchPlaceholder}
          />
          <span className="mde-search-count">{countLabel}</span>
        </div>

        {/* 两个匹配模式开关跟在输入框后面（VSCode 顺序）：折叠 → 输入 → 计数 → 模式 → 上/下/关闭 */}
        <div className="mde-search-toggles">
          <button
            type="button"
            className={`mde-search-toggle-btn${options.caseSensitive ? " is-active" : ""}`}
            title={labels.searchCaseSensitive}
            aria-label={labels.searchCaseSensitive}
            aria-pressed={options.caseSensitive}
            onClick={() => toggle("caseSensitive")}
          >
            <MdeIcon name="case-sensitive" size={15} />
          </button>
          <button
            type="button"
            className={`mde-search-toggle-btn${options.regex ? " is-active" : ""}`}
            title={labels.searchRegex}
            aria-label={labels.searchRegex}
            aria-pressed={options.regex}
            onClick={() => toggle("regex")}
          >
            <MdeIcon name="regex" size={15} />
          </button>
        </div>

        <div className="mde-search-actions">
          <button
            type="button"
            className="mde-search-icon-btn"
            title={labels.searchPrev}
            aria-label={labels.searchPrev}
            disabled={!hasMatch}
            onClick={onPrev}
          >
            <MdeIcon name="chevron-up" size={14} />
          </button>
          <button
            type="button"
            className="mde-search-icon-btn"
            title={labels.searchNext}
            aria-label={labels.searchNext}
            disabled={!hasMatch}
            onClick={onNext}
          >
            <MdeIcon name="chevron-down" size={14} />
          </button>
          <button
            type="button"
            className="mde-search-icon-btn"
            title={labels.searchClose}
            aria-label={labels.searchClose}
            onClick={onClose}
          >
            <MdeIcon name="close" size={14} />
          </button>
        </div>
      </div>

      {showReplace && (
        <div className="mde-search-row">
          <span className="mde-search-spacer" aria-hidden="true" />
          <div className="mde-search-field">
            <input
              className="mde-search-input"
              value={replaceText}
              spellCheck={false}
              placeholder={labels.replacePlaceholder}
              onChange={(event) => onReplaceChange(event.target.value)}
              aria-label={labels.replacePlaceholder}
            />
          </div>
          <div className="mde-search-actions">
            <button
              type="button"
              className="mde-search-text-btn"
              title={labels.searchReplace}
              disabled={readOnly || !hasMatch}
              onClick={onReplace}
            >
              {labels.searchReplace}
            </button>
            <button
              type="button"
              className="mde-search-text-btn"
              title={`${labels.searchReplaceAll}（Ctrl/⌘+Alt+Enter）`}
              disabled={readOnly || !hasMatch}
              onClick={onReplaceAll}
            >
              {labels.searchReplaceAll}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

SearchBox.displayName = "SearchBox";
