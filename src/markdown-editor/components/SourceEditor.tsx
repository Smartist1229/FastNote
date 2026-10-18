/**
 * 源码输入区（textarea）。
 *
 * 为什么不用 contenteditable：原生输入法、撤销、拼写检查、大文本性能都更可控，
 * 而且 Markdown 源码本身是纯文本，没必要引入富文本模型。
 *
 * 这里负责的只有「输入法友好」的本地行为：Tab 缩进、回车续写列表、括号配对、图片粘贴。
 * 格式命令、历史记录、快捷键都由上层统一处理，避免同一个按键出现两套逻辑。
 */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { MarkdownChangeSource, MarkdownEditorConfig } from "../types";
import { autoPairOnInput, continueMarkdownOnEnter, runCommand, type EditState } from "../editor/commands";
import type { SearchMatch } from "../editor/search";

export interface SourceEditorHandle {
  focus: () => void;
  blur: () => void;
  getElement: () => HTMLTextAreaElement | null;
  getState: () => EditState;
  /** 写入新值并指定选区（历史由上层记录） */
  apply: (next: EditState, source?: MarkdownChangeSource) => void;
  /**
   * 设置选区。`focus` 为 false 时只落选区、不抢焦点：
   * 查找跳转（连按 Enter 找下一个）必须用 false，否则焦点回到输入框之前，
   * 第二次 Enter 就变成在编辑器里换行。
   */
  setSelection: (start: number, end?: number, focus?: boolean) => void;
  /** 只排队选区：等下一次 value 更新后再落选区，用于撤销这类"先改值再定位"的场景 */
  queueSelection: (start: number, end?: number) => void;
  scrollToLine: (line: number) => void;
}

/**
 * 当前焦点能不能被编辑器拿走。
 *
 * 焦点在查找框里时不能拿：抢回来之后用户再按 Enter 就变成在编辑器里换行，
 * 而不是「找下一个」——查找框的 Enter 得一直归查找框。
 */
const canTakeFocus = (element: HTMLTextAreaElement): boolean => {
  const active = element.ownerDocument.activeElement as HTMLElement | null;
  return !active?.closest?.(".mde-search");
};

interface SourceEditorProps {
  value: string;
  onChange: (next: EditState, source: MarkdownChangeSource) => void;
  onSelectionChange?: (start: number, end: number) => void;
  config: MarkdownEditorConfig;
  readOnly: boolean;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
  /** 返回 true 表示快捷键已处理（上层负责 preventDefault） */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 粘贴/拖入图片 */
  onImageFile?: (file: File) => void;
  /** 拿到真实 DOM，供滚动同步绑定 */
  onElement?: (element: HTMLTextAreaElement | null) => void;
  /** 查找命中：会在 textarea 下面铺一层高亮，不需要时传空数组 */
  matches?: SearchMatch[];
  /** 当前命中的下标 */
  matchIndex?: number;
  /** 只高亮当前命中（关闭时高亮全部） */
  highlightOnlyCurrent?: boolean;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  (
    {
      value,
      onChange,
      onSelectionChange,
      config,
      readOnly,
      placeholder,
      autoFocus,
      className,
      onKeyDown,
      onImageFile,
      onElement,
      matches,
      matchIndex = -1,
      highlightOnlyCurrent = false,
    },
    ref,
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const pendingSelection = useRef<[number, number] | null>(null);
    const composing = useRef(false);

    const setElement = useCallback(
      (element: HTMLTextAreaElement | null) => {
        textareaRef.current = element;
        onElement?.(element);
      },
      [onElement],
    );

    // 值更新后统一落选区：命令、撤销、外部 setValue 都走这条路径
    useLayoutEffect(() => {
      const element = textareaRef.current;
      const selection = pendingSelection.current;
      if (!element || !selection) return;
      pendingSelection.current = null;
      if (document.activeElement !== element && canTakeFocus(element)) element.focus({ preventScroll: true });
      element.setSelectionRange(selection[0], selection[1]);
    }, [value]);

    const emit = useCallback(
      (next: EditState, source: MarkdownChangeSource) => {
        pendingSelection.current = [next.start, next.end];
        onChange(next, source);
      },
      [onChange],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        blur: () => textareaRef.current?.blur(),
        getElement: () => textareaRef.current,
        getState: () => {
          const element = textareaRef.current;
          if (!element) return { text: value, start: 0, end: 0 };
          return { text: element.value, start: element.selectionStart, end: element.selectionEnd };
        },
        apply: (next, source = "toolbar") => emit(next, source),
        setSelection: (start, end = start, focus = true) => {
          const element = textareaRef.current;
          if (!element) return;
          if (focus && canTakeFocus(element)) element.focus({ preventScroll: true });
          element.setSelectionRange(start, end);
          onSelectionChange?.(start, end);
        },
        queueSelection: (start, end = start) => {
          pendingSelection.current = [start, end];
        },
        scrollToLine: (line) => {
          const element = textareaRef.current;
          if (!element) return;
          const height = parseFloat(getComputedStyle(element).lineHeight) || 24;
          element.scrollTop = Math.max(0, (line - 3) * height);
        },
      }),
      [emit, onSelectionChange, value],
    );

    const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const element = event.target;
      onChange({ text: element.value, start: element.selectionStart, end: element.selectionEnd }, "input");
    };

    const handleSelect = () => {
      const element = textareaRef.current;
      if (!element) return;
      onSelectionChange?.(element.selectionStart, element.selectionEnd);
    };

    /** 图片文件统一交给上层（返回 URL 由上层插入） */
    const pickImage = (files: FileList | null) => {
      if (!files || !onImageFile) return false;
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          onImageFile(file);
          return true;
        }
      }
      return false;
    };

    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (pickImage(event.clipboardData?.files ?? null)) event.preventDefault();
    };

    const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
      if (pickImage(event.dataTransfer?.files ?? null)) event.preventDefault();
    };

    /** 自动配对：只处理单字符输入，输入法组合期间完全放行 */
    const handleBeforeInput = (event: FormEvent<HTMLTextAreaElement>) => {
      if (composing.current || readOnly) return;
      const native = event.nativeEvent as InputEvent;
      if (native.inputType !== "insertText" || !native.data || native.data.length !== 1) return;
      const element = textareaRef.current;
      if (!element) return;
      const result = autoPairOnInput(
        element.value,
        element.selectionStart,
        native.data,
        config.editor.autoPair,
      );
      if (!result) return;
      event.preventDefault();
      emit({ text: result.text, start: result.caret, end: result.caret }, "input");
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (onKeyDown?.(event)) return;
      if (composing.current) return;

      const element = textareaRef.current;
      if (!element) return;

      if (event.key === "Escape") {
        element.blur();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (!config.editor.continueMarkdownOnEnter || readOnly) return;
        const result = continueMarkdownOnEnter(element.value, element.selectionStart, config.editor.tabSize);
        if (!result) return;
        event.preventDefault();
        emit({ text: result.text, start: result.caret, end: result.caret }, "input");
        return;
      }

      if (event.key === "Tab" && config.editor.tabKey !== "none") {
        event.preventDefault();
        const state: EditState = {
          text: element.value,
          start: element.selectionStart,
          end: element.selectionEnd,
        };
        if (event.shiftKey) {
          const next = runCommand(state, "outdent", { tabSize: config.editor.tabSize, labels: {} });
          if (next) emit(next, "format");
          return;
        }
        // 有选区时缩进整行；折叠光标时插入空格
        if (state.start !== state.end) {
          const next = runCommand(state, "indent", { tabSize: config.editor.tabSize, labels: {} });
          if (next) emit(next, "format");
          return;
        }
        const spaces = " ".repeat(config.editor.tabSize);
        emit(
          {
            text: state.text.slice(0, state.start) + spaces + state.text.slice(state.end),
            start: state.start + spaces.length,
            end: state.start + spaces.length,
          },
          "input",
        );
      }
    };

    /** 点击行号：选中整行文本，方便整行删除/替换 */
    const selectLineAt = (lineIndex: number) => {
      const element = textareaRef.current;
      if (!element || !config.editor.gutterClickSelectsLine) return;
      const lines = element.value.split("\n");
      const index = Math.max(0, Math.min(lines.length - 1, lineIndex));
      let start = 0;
      for (let i = 0; i < index; i++) start += lines[i].length + 1;
      const end = start + lines[index].length;
      element.focus({ preventScroll: true });
      element.setSelectionRange(start, end);
      onSelectionChange?.(start, end);
    };

    const lineHeight = config.editor.fontSize * config.editor.lineHeight;
    const showGutter = config.editor.lineNumbers;

    /**
     * 命中高亮层：与 textarea 用同一份字体/行高/内边距，铺在它下面只画底色。
     * 文字本身保持透明，看到的仍是 textarea 的字，因此不会出现两层字错位。
     */
    const textStyle: CSSProperties = {
      fontFamily: config.editor.fontFamily,
      fontSize: `${config.editor.fontSize}px`,
      lineHeight: config.editor.lineHeight,
      tabSize: config.editor.tabSize,
      paddingBottom: config.editor.scrollPaddingBottom,
    };

    const renderFindLayer = (): ReactNode => {
      if (!matches || !matches.length || matchIndex < -1) return null;
      const nodes: ReactNode[] = [];
      let cursor = 0;
      matches.forEach((match, index) => {
        if (match.start > cursor) nodes.push(value.slice(cursor, match.start));
        const slice = value.slice(match.start, match.end);
        const isCurrent = index === matchIndex;
        nodes.push(
          isCurrent || !highlightOnlyCurrent ? (
            <mark key={match.start} className={`mde-find-hit${isCurrent ? " is-current" : ""}`}>
              {slice}
            </mark>
          ) : (
            slice
          ),
        );
        cursor = match.end;
      });
      if (cursor < value.length) nodes.push(value.slice(cursor));
      return (
        <div
          className={`mde-find-layer${config.editor.wrap ? "" : " is-nowrap"}`}
          ref={layerRef}
          aria-hidden="true"
          style={textStyle}
        >
          {nodes}
        </div>
      );
    };

    return (
      <div className={`mde-source${className ? ` ${className}` : ""}${showGutter ? " has-gutter" : ""}`}>
        {showGutter && (
          <div className="mde-gutter" aria-hidden="true">
            <div className="mde-gutter-inner" style={{ lineHeight: `${lineHeight}px` }}>
              {Array.from({ length: Math.max(1, value.split("\n").length) }, (_, index) => (
                <button
                  type="button"
                  className="mde-gutter-line"
                  key={index}
                  tabIndex={-1}
                  title={`选中第 ${index + 1} 行`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectLineAt(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mde-source-main">
        {renderFindLayer()}
        <textarea
          ref={setElement}
          className={`mde-textarea${config.editor.wrap ? "" : " is-nowrap"}`}
          value={value}
          onChange={handleChange}
          onSelect={handleSelect}
          onKeyDown={handleKeyDown}
          onBeforeInput={handleBeforeInput}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onScroll={(event) => {
            const element = event.currentTarget;
            const gutter = element.closest(".mde-source")?.querySelector(".mde-gutter-inner");
            if (gutter instanceof HTMLElement) gutter.style.transform = `translateY(${-element.scrollTop}px)`;
            const layer = layerRef.current;
            if (layer) {
              layer.scrollTop = element.scrollTop;
              layer.scrollLeft = element.scrollLeft;
            }
          }}
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={config.editor.spellCheck}
          autoFocus={autoFocus}
          wrap={config.editor.wrap ? "soft" : "off"}
          style={textStyle}
          aria-label={placeholder}
        />
        </div>
      </div>
    );
  },
);

SourceEditor.displayName = "SourceEditor";
