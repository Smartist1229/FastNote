/**
 * 对话输入框：contenteditable 的结构化输入，文本里可以夹「笔记引用块」。
 *
 * 为什么不用 textarea：块必须参与文本流（光标能停在块前后、退格能删整块、
 * 悬停出现 ×），textarea 只能渲染纯文本。块本身是 contenteditable=false 的
 * 内联元素，浏览器不会把光标放进去；插入与删除全部由这里接管，DOM 里永远只有
 * 文本节点、块和不可见占位符，序列化时再把块还原成 <note-ref>JSON</note-ref>。
 *
 * 受控方式：value 只在外来变更（发送后清空、切换草稿、↑ 召回、快捷短语）时回写
 * DOM；自己敲的字只往上 emit，不重建 DOM，否则中文输入法会被打断。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { useI18n } from "@/i18n";
import type { ChatNoteRef } from "@/interface/ai/aiChat";
import { parseNoteRef, refLabel, refRangeLabel, refTitle, serializeNoteRef, splitContent } from "@/lib/ai/aiParse/noteRef";

/** 块与文本之间不可见的占位符：保证块后面有可落脚的光标位置；序列化时丢弃 */
const ZWSP = "\u200B";

export interface ChatComposerHandle {
  /** 内容根节点：外部的高度计算 / 拖动调整直接操作它 */
  element: HTMLDivElement | null;
  focus: () => void;
  /** 在光标处插入一个引用块（没有光标时追加到末尾） */
  insertRef: (ref: ChatNoteRef) => void;
  /** 把一段文本追加到草稿末尾（空行分隔），用于选区工具条的提示词注入 */
  insertText: (text: string) => void;
}

interface ChatComposerProps {
  value: string;
  onChange: (content: string) => void;
  onSend: () => void;
  onStop: () => void;
  isSending: boolean;
  canRecall: boolean;
  onRecall: () => void;
  placeholder: string;
}

const isInvisible = (node: Node): boolean =>
  node.nodeType === Node.TEXT_NODE && (node.textContent || "").split(ZWSP).join("") === "";

/**
 * 把光标滚进输入框的可视区。
 *
 * 为什么必须手动做：用户打字时浏览器会自动保证光标可见，但我们插入内容是
 * `range.insertNode()` 直接改 DOM——那是程序化修改，浏览器不会跟滚。
 * 于是连按 Shift+Enter 时滚动条一直停最上面，光标却已经掉到下面看不见。
 */
const scrollCaretIntoView = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return;
  const caret = range.cloneRange();
  caret.collapse(true);
  const rect = caret.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  // 空行里拿不到光标矩形（行尾换行符之后）。只有光标确实位于内容末尾时才贴底，
  // 否则用户点中间某个空行也会被甩到底部。
  if (rect.width === 0 && rect.height === 0) {
    const tail = document.createRange();
    tail.selectNodeContents(root);
    tail.setStart(range.startContainer, range.startOffset);
    if (tail.toString().trim() === "") root.scrollTop = root.scrollHeight;
    return;
  }
  const pad = 6;
  if (rect.bottom > box.bottom - pad) {
    root.scrollTop += rect.bottom - (box.bottom - pad);
  } else if (rect.top < box.top + pad) {
    root.scrollTop -= box.top + pad - rect.top;
  }
};

/** DOM → 内容字符串；BR 是浏览器给空行塞的占位，不参与内容 */
const readContent = (root: HTMLElement): string => {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent || "").split(ZWSP).join("");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.noteRef) {
      const ref = parseNoteRef(node.dataset.noteRef);
      if (ref) out += serializeNoteRef(ref);
      return;
    }
    if (node.tagName === "BR") return;
    const block = node !== root && (node.tagName === "DIV" || node.tagName === "P");
    if (block && out && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
};

const placeCaret = (node: Node, offset: number) => {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const placeCaretAtEnd = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
};

/** 从 node 往前找紧邻的块，中间只允许不可见占位 */
const previousChip = (node: Node): HTMLElement | null => {
  let cursor: Node | null = node.previousSibling;
  while (cursor) {
    if (isInvisible(cursor)) {
      cursor = cursor.previousSibling;
      continue;
    }
    return cursor instanceof HTMLElement && cursor.dataset.noteRef ? cursor : null;
  }
  return null;
};

/** 光标紧跟在块后面时返回那个块（退格删整块的判定） */
const chipBeforeCaret = (): HTMLElement | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const { startContainer: node, startOffset: offset } = selection.getRangeAt(0);
  if (node.nodeType === Node.TEXT_NODE) {
    const before = (node.textContent || "").slice(0, offset).split(ZWSP).join("");
    // 用户自己敲的空格不算"紧邻"：先删空格更符合直觉
    return before === "" ? previousChip(node) : null;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const children = (node as Element).childNodes;
    for (let i = offset - 1; i >= 0; i--) {
      const child = children[i];
      if (isInvisible(child)) continue;
      return child instanceof HTMLElement && child.dataset.noteRef ? child : null;
    }
  }
  return null;
};

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { value, onChange, onSend, onStop, isSending, canRecall, onRecall, placeholder },
  ref,
) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  /** 最后一次自己 emit 出去的内容：value 与它相同说明是回流，不回写 DOM */
  const lastEmittedRef = useRef<string | null>(null);

  const emit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const content = readContent(root);
    lastEmittedRef.current = content;
    /*
     * 判"有没有内容"用 length 而不是 trim：
     * 用户敲了空格（或先按了换行）就该让占位提示消失——提示是绝对定位盖在上面的，
     * 不消失会一直压在光标和空格前面，看起来像输入没生效。
     * 是否为空（能不能发送）由 AIChatPanel 的 prompt.trim() 决定，这里只管展示。
     */
    const hasContent = content.length > 0 || !!root.querySelector("[data-note-ref]");
    root.dataset.empty = hasContent ? "false" : "true";
    onChange(content);
  }, [onChange]);

  const removeChip = useCallback((chip: HTMLElement) => {
    const spacer = chip.nextSibling;
    chip.remove();
    // 块后面那枚占位符一并清掉，否则会残留一个看不见的光标陷阱
    if (spacer && isInvisible(spacer)) spacer.parentNode?.removeChild(spacer);
    rootRef.current?.focus();
    emit();
  }, [emit]);

  const buildChip = useCallback((noteRef: ChatNoteRef): HTMLElement => {
    const chip = document.createElement("span");
    chip.className = "chat-note-ref is-removable";
    chip.contentEditable = "false";
    chip.dataset.noteRef = JSON.stringify(noteRef);
    chip.title = refTitle(noteRef);
    const label = document.createElement("span");
    label.className = "chat-note-ref-label";
    label.textContent = refLabel(noteRef);
    const range = document.createElement("span");
    range.className = "chat-note-ref-range";
    range.textContent = refRangeLabel(noteRef);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chat-note-ref-x";
    remove.textContent = "×";
    remove.tabIndex = -1;
    remove.title = t("删除引用");
    remove.setAttribute("aria-label", t("删除引用"));
    // 不让点 × 抢走光标，否则删完还得再点一次输入框
    remove.addEventListener("mousedown", (event) => event.preventDefault());
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeChip(chip);
    });
    chip.append(label, range, remove);
    return chip;
  }, [removeChip, t]);

  /** 用内容字符串重建 DOM（外来写入：清空、切草稿、召回、注入） */
  const renderContent = useCallback((content: string) => {
    const root = rootRef.current;
    if (!root) return;
    const fragment = document.createDocumentFragment();
    let hasRef = false;
    for (const segment of splitContent(content)) {
      if (segment.kind === "text") {
        if (segment.text) fragment.appendChild(document.createTextNode(segment.text));
      } else {
        hasRef = true;
        fragment.appendChild(buildChip(segment.ref));
      }
    }
    root.replaceChildren(fragment);
    root.dataset.empty = content.length > 0 || hasRef ? "false" : "true";
  }, [buildChip]);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    renderContent(value);
    lastEmittedRef.current = value;
    const root = rootRef.current;
    if (root && document.activeElement === root) placeCaretAtEnd(root);
  }, [value, renderContent]);

  /*
   * 光标跟随：内容一变就把光标滚进视野。
   *
   * 同时观察 root 的 style：外层（AIChatPanel 的自动长高）每次把 height 从 auto 压回
   * 封顶值，浏览器都会把 scrollTop 清零——不盯着这次改动的话，
   * 我们刚滚下去的位置会立刻被打回第一行，这正是"滚动条始终在最上面"的来源。
   *
   * 滚动本身不产生 DOM 变更，所以不会自激。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const el = rootRef.current;
        if (el) scrollCaretIntoView(el);
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  /** 在光标处插入纯文本（换行、粘贴都走这里，DOM 里只留文本节点） */
  const insertPlainText = useCallback((text: string) => {
    const root = rootRef.current;
    if (!root) return;
    const selection = window.getSelection();
    let range: Range;
    if (selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).startContainer)) {
      range = selection.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    placeCaret(node, text.length);
    emit();
  }, [emit]);

  const insertRef = useCallback((noteRef: ChatNoteRef) => {
    const root = rootRef.current;
    if (!root) return;
    root.focus();
    // 追加到草稿末尾：点「添加到对话」时焦点多半还在编辑器里，光标位置不可信，
    // 而且这与提示词注入的追加语义保持一致。空草稿里浏览器可能留了个 <br>，先清掉。
    const current = readContent(root);
    if (!current.trim()) root.replaceChildren();
    else if (!/\s$/.test(current)) root.appendChild(document.createTextNode(" "));
    const chip = buildChip(noteRef);
    const spacer = document.createTextNode(ZWSP);
    root.append(chip, spacer);
    placeCaret(spacer, 1);
    emit();
  }, [buildChip, emit]);

  const insertText = useCallback((text: string) => {
    const root = rootRef.current;
    if (!root) return;
    // 与原来的 textarea 注入保持一致：追加到草稿末尾，空行分隔
    const current = readContent(root);
    const next = current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
    renderContent(next);
    lastEmittedRef.current = next;
    root.focus();
    placeCaretAtEnd(root);
    onChange(next);
  }, [onChange, renderContent]);

  useImperativeHandle(ref, () => ({
    get element() { return rootRef.current; },
    focus: () => rootRef.current?.focus(),
    insertRef,
    insertText,
  }), [insertRef, insertText]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const root = rootRef.current;
    if (!root) return;
    const raw = readContent(root);
    const empty = !raw.trim();
    if (event.key === "Escape") {
      if (isSending) { event.preventDefault(); onStop(); }
      // 只有空格/换行时也算"有东西"，Esc 要能清掉——否则占位提示已消失、内容却删不干净
      else if (raw.length > 0) {
        event.preventDefault();
        renderContent("");
        lastEmittedRef.current = "";
        root.dataset.empty = "true";
        onChange("");
      }
      return;
    }
    if (event.key === "ArrowUp" && empty && canRecall) {
      event.preventDefault();
      onRecall();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!event.shiftKey || event.ctrlKey || event.metaKey) {
        if (isSending) onStop();
        else onSend();
        return;
      }
      insertPlainText("\n");
      return;
    }
    if (event.key === "Backspace") {
      const chip = chipBeforeCaret();
      if (chip) {
        event.preventDefault();
        removeChip(chip);
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className="composer-input chat-scrollbar"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      data-empty="true"
      spellCheck={false}
      onInput={emit}
      onKeyDown={handleKeyDown}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
        if (text) insertPlainText(text);
      }}
      onDrop={(event) => event.preventDefault()}
      onBeforeInput={(event) => {
        // 只许纯文本：加粗/斜体等格式化命令直接从源头挡掉
        const type = (event.nativeEvent as InputEvent).inputType;
        if (type.startsWith("format") || type === "insertFromDrop") event.preventDefault();
      }}
    />
  );
});
