/**
 * 查找 / 替换悬浮框（Ctrl/⌘+F）。
 *
 * 交互对齐 VSCode：一行「折叠开关 + 输入框 + 计数 + 匹配模式 + 上/下/关闭」，
 * 展开后第二行是替换输入与「替换 / 全部替换」。
 *
 * 两行是同一个网格的三列（`.mde-search` 里定义）：`22px | 输入框 | 按钮组`。
 * 所以两个输入框的左右边缘天然对齐，右边按钮多少、多宽都不会把输入框挤歪；
 * 右侧两组按钮各包一层 `.mde-search-tail`，整体靠右，多出来的宽度只留在按钮组左边。
 *
 * 这里只负责 UI 与键盘，真正的匹配、跳转、改写都在上层（search.ts + MarkdownEditor），
 * 组件本身不持有文档内容，方便外部用 API 直接驱动。
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { MdeIcon } from "../../icons";
import { buildSearchRegExp } from "../../editor/search";
import type { MarkdownEditorConfig, SearchOptions } from "../../types";

export interface SearchBoxProps {
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  query: string;
  replaceText: string;
  options: SearchOptions;
  /**
   * 这一侧能不能替换（阅读模式为 false）。
   *
   * 关掉之后折叠箭头也不给——点它只会展开一行点了没反应的输入框。
   */
  allowReplace: boolean;
  showReplace: boolean;
  /** 命中总数 */
  matchCount: number;
  /** 命中数被上限截断了（计数后面加 +，避免把"2000 个"当成真的总数） */
  matchCapped?: boolean;
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
  allowReplace,
  showReplace,
  matchCount,
  matchCapped = false,
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

  const invalidRegex = Boolean(query && options.regex && !buildSearchRegExp(query, options));
  const countLabel = !query
    ? ""
    : invalidRegex
      ? labels.searchInvalidRegex
      : matchCount === 0
        ? labels.searchNoResult
        : `${Math.min(matchIndex + 1, matchCount)}/${matchCount}${matchCapped ? "+" : ""}`;
  const hasMatch = matchCount > 0;
  /** 替换串的模式开关只在查找本身是正则时才有意义 */
  const replaceMode = options.regex && options.regexReplace;

  return (
    <div
      className={`mde-search${compact ? " is-compact" : ""}`}
      role="search"
      aria-label={labels.searchPlaceholder}
      onKeyDown={handleKeyDown}
    >
      <div className="mde-search-row">
        {allowReplace ? (
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
        ) : (
          /* 不能替换时这一列用空占位顶着，输入框的起点才和有没有箭头时一致 */
          <span className="mde-search-spacer" aria-hidden="true" />
        )}

        {/* 计数叠在输入框右端（绝对定位）：输入框的盒子才是这一列的整宽，两行才对得上 */}
        <div className="mde-search-field is-counted">
          <input
            ref={inputRef}
            className={`mde-search-input${!query || hasMatch ? "" : " is-empty"}`}
            value={query}
            spellCheck={false}
            placeholder={labels.searchPlaceholder}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label={labels.searchPlaceholder}
            aria-invalid={invalidRegex || undefined}
            title={invalidRegex ? labels.searchInvalidRegex : undefined}
          />
          <span className="mde-search-count" role="status">{countLabel}</span>
        </div>

        <div className="mde-search-tail">
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
      </div>

      {allowReplace && showReplace && (
        <div className="mde-search-row">
          {/* 空占位：第一列留给折叠开关的位置，两行的输入框起点才一致 */}
          <span className="mde-search-spacer" aria-hidden="true" />
          <div className="mde-search-field">
            <input
              className="mde-search-input"
              value={replaceText}
              spellCheck={false}
              placeholder={labels.replacePlaceholder}
              /*
               * 正则模式下替换串会被展开（VSCode 语义）：$1~$99 捕获组、$& 整个命中、
               * $<name> 命名组、$$ 字面美元符，以及 \n \t \r \\ 转义。
               * 再打开右侧的「正则」模式后，替换串里照抄的查找正则也算「整个命中」的占位符。
               */
              title={
                !options.regex
                  ? undefined
                  : options.regexReplace
                    ? labels.searchReplaceRegexHint
                    : labels.searchReplaceLiteralHint
              }
              onChange={(event) => onReplaceChange(event.target.value)}
              aria-label={labels.replacePlaceholder}
            />
          </div>
          <div className="mde-search-tail">
            {/* 替换串的两种解释方式：字面贴入 ↔ 按正则展开（查找正则 = 整个命中） */}
            <button
              type="button"
              /* 查找不是正则时这个开关无从生效：按「字面」显示并禁用，避免看着是开了却没作用 */
              className={`mde-search-text-btn is-mode${replaceMode ? " is-active" : ""}`}
              title={
                options.regex
                  ? options.regexReplace
                    ? labels.searchReplaceRegexHint
                    : labels.searchReplaceLiteralHint
                  : labels.searchReplaceModeLocked
              }
              aria-label={labels.searchReplaceMode}
              aria-pressed={replaceMode}
              disabled={!options.regex}
              onClick={() => toggle("regexReplace")}
            >
              {replaceMode ? labels.searchReplaceRegex : labels.searchReplaceLiteral}
            </button>
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
                title={`${labels.searchReplaceAll} (Ctrl/⌘+Alt+Enter)`}
                disabled={readOnly || !hasMatch}
                onClick={onReplaceAll}
              >
                {labels.searchReplaceAll}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

SearchBox.displayName = "SearchBox";
