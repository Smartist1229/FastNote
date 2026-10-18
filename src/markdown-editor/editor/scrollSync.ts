/**
 * 分栏滚动同步。
 *
 * 不用「百分比对百分比」的原因：源码行数与渲染高度不成正比（一个代码块可能占 20 行源码
 * 但只有 3 屏高），按比例同步会在长文档里越滚越偏。
 *
 * 这里按源码行做锚点插值：
 * - 每个顶层块带 `data-line`，用它建立「行号 → 预览垂直位置」的锚点表；
 * - 滚动时取当前行落在哪两个锚点之间，做线性插值；
 * - 两个方向都驱动，并用锁 + rAF 防止互相触发形成抖动。
 *
 * 已知限制：编辑区自动换行时长行占多行，行高换算会略偏，所以锚点插值仍以真实行号为准，
 * 误差在可接受范围内；需要绝对精确可改用关闭换行 + 等宽字体。
 */

interface Anchor {
  line: number;
  top: number;
}

/** 收集预览区的行锚点（相对内容顶部的偏移） */
const collectAnchors = (preview: HTMLElement): Anchor[] => {
  const nodes = preview.querySelectorAll<HTMLElement>("[data-line]");
  const previewTop = preview.getBoundingClientRect().top - preview.scrollTop;
  const anchors: Anchor[] = [];
  nodes.forEach((node) => {
    const line = Number(node.dataset.line);
    if (!Number.isFinite(line)) return;
    const top = node.getBoundingClientRect().top - previewTop;
    const last = anchors[anchors.length - 1];
    // 同一行只保留第一个块，避免块内嵌套元素干扰
    if (last && last.line === line) return;
    anchors.push({ line, top });
  });
  return anchors;
};

/** 在锚点表中插值：给定行号返回预览偏移 */
const offsetForLine = (anchors: Anchor[], line: number, preview: HTMLElement): number => {
  if (!anchors.length) return 0;
  if (line <= anchors[0].line) return 0;
  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i];
    if (current.line === line) return current.top;
    const next = anchors[i + 1];
    if (next && line > current.line && line <= next.line) {
      const ratio = (line - current.line) / Math.max(1, next.line - current.line);
      return current.top + (next.top - current.top) * ratio;
    }
  }
  return preview.scrollHeight - preview.clientHeight;
};

/** 预览偏移 → 行号 */
const lineForOffset = (anchors: Anchor[], top: number): number => {
  if (!anchors.length) return 1;
  if (top <= anchors[0].top) return anchors[0].line;
  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i];
    const next = anchors[i + 1];
    if (next && top >= current.top && top <= next.top) {
      const ratio = (top - current.top) / Math.max(1, next.top - current.top);
      return current.line + (next.line - current.line) * ratio;
    }
  }
  return anchors[anchors.length - 1].line;
};

export interface ScrollSyncOptions {
  editor: HTMLElement;
  preview: HTMLElement;
  /** 编辑区一个逻辑行的高度（px） */
  lineHeight: number;
  mode: "anchor" | "ratio";
}

/** 建立双向同步，返回解绑函数 */
export const bindScrollSync = ({ editor, preview, lineHeight, mode }: ScrollSyncOptions): (() => void) => {
  let locked = false;
  let frame = 0;
  let anchors: Anchor[] = [];
  let anchorsDirty = true;

  const refresh = () => {
    anchors = mode === "anchor" ? collectAnchors(preview) : [];
  };

  const fromEditor = () => {
    if (locked) return;
    locked = true;
    if (anchorsDirty) {
      refresh();
      anchorsDirty = false;
    }
    const maxEditor = Math.max(1, editor.scrollHeight - editor.clientHeight);
    const maxPreview = Math.max(1, preview.scrollHeight - preview.clientHeight);
    if (mode === "ratio") {
      preview.scrollTop = (editor.scrollTop / maxEditor) * maxPreview;
    } else {
      const line = editor.scrollTop / Math.max(1, lineHeight) + 1;
      const target = offsetForLine(anchors, line, preview);
      preview.scrollTop = Math.min(maxPreview, Math.max(0, target));
    }
    window.setTimeout(() => {
      locked = false;
    }, 40);
  };

  const fromPreview = () => {
    if (locked) return;
    locked = true;
    if (anchorsDirty) {
      refresh();
      anchorsDirty = false;
    }
    const maxEditor = Math.max(1, editor.scrollHeight - editor.clientHeight);
    const maxPreview = Math.max(1, preview.scrollHeight - preview.clientHeight);
    if (mode === "ratio") {
      editor.scrollTop = (preview.scrollTop / maxPreview) * maxEditor;
    } else {
      const line = lineForOffset(anchors, preview.scrollTop);
      editor.scrollTop = Math.min(maxEditor, Math.max(0, (line - 1) * lineHeight));
    }
    window.setTimeout(() => {
      locked = false;
    }, 40);
  };

  const onEditorScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fromEditor);
  };
  const onPreviewScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fromPreview);
  };
  // 内容变化后锚点表失效（预览高度变了）
  const markDirty = () => {
    anchorsDirty = true;
  };

  editor.addEventListener("scroll", onEditorScroll, { passive: true });
  preview.addEventListener("scroll", onPreviewScroll, { passive: true });
  const observer = new MutationObserver(markDirty);
  observer.observe(preview, { childList: true, subtree: true, characterData: true });

  return () => {
    cancelAnimationFrame(frame);
    editor.removeEventListener("scroll", onEditorScroll);
    preview.removeEventListener("scroll", onPreviewScroll);
    observer.disconnect();
  };
};
