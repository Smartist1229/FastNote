/**
 * 代码块渲染：语言标签、行号、复制、自动换行、Mermaid 分流。
 *
 * 行号用「每行一个 grid 行」而不是独立的行号列：这样长代码行自动换行时，
 * 行号与逻辑行仍然一一对齐，不会出现行号错位（独立列方案在这种场景必错）。
 *
 * Mermaid 渲染是异步的，失败时退回普通代码块，不让一句写错的图语句把整篇预览拖崩。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockNode, MarkdownEditorConfig } from "../types";
import { MdeIcon } from "../icons";
import { parseCodeMeta } from "./codeMeta";
import { escapeHtml, highlightCode, renderMermaid, splitHighlightedLines } from "./highlight";

type CodeNode = Extract<BlockNode, { type: "code" }>;

interface CodeBlockProps {
  node: CodeNode;
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
}

/**
 * 高亮任务串行化。
 *
 * 代码块随滚动进入预取范围时，多个任务会在同一轮微任务里一起开跑，
 * highlight.js 是同步的，几十个块叠在一起就是一次几十到上百毫秒的长任务，
 * 正好把滚动的帧顶掉。这里每次空闲（或下一轮宏任务）只放一个任务进去，
 * 单个块的耗时仍会体现在一帧里，但不会再堆成山。
 */
const highlightQueue: Array<() => void> = [];
let highlightScheduled = false;

const pumpHighlight = () => {
  highlightScheduled = false;
  const job = highlightQueue.shift();
  if (!job) return;
  job();
  if (highlightQueue.length) scheduleHighlight();
};

const scheduleHighlight = () => {
  if (highlightScheduled) return;
  highlightScheduled = true;
  const idle = (
    globalThis as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (idle) idle(pumpHighlight, { timeout: 120 });
  else globalThis.setTimeout(pumpHighlight, 16);
};

const enqueueHighlight = (job: () => void) => {
  highlightQueue.push(job);
  scheduleHighlight();
};

/** 内核：语法高亮 + 行号 + 复制 + 折叠 */
const PlainCodeBlock: React.FC<CodeBlockProps> = ({ node, config, labels }) => {
  /*
   * 首帧一律先放转义后的纯文本：高亮是异步的，代码原文绝不能直接进 innerHTML
   * （`<img onerror=…>` 这类片段会在高亮结果回来之前先执行一遍）。
   */
  const plain = useMemo(() => splitHighlightedLines(escapeHtml(node.code)), [node.code]);
  const codeKey = `${node.lang}\u0000${node.code}`;
  const [colored, setColored] = useState<{ key: string; lines: string[] } | null>(null);
  const lines = colored && colored.key === codeKey ? colored.lines : plain;
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const timer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const lineCount = node.code ? node.code.split("\n").length : 0;
  const meta = parseCodeMeta(node.meta);
  const overThreshold = lineCount > config.preview.codeCollapseThreshold;
  const canCollapse = config.preview.codeCollapsible && !meta.foldDisabled && (meta.collapse || meta.expand || overThreshold);
  const [collapsed, setCollapsed] = useState(
    () => canCollapse && (meta.collapse || (config.preview.codeCollapseDefault && !meta.expand)),
  );
  const highlightLines = new Set(config.preview.codeHighlightLines ? meta.highlight : []);
  // 行号显隐统一由配置决定（可用 lines / nolines 按块覆盖），
  // 不再因写了行高亮就强制开行号——否则同一篇文档里的代码块会出现两套观感
  const showNumbers = meta.lineNumbers ?? config.preview.showCodeLineNumbers;

  /*
   * 高亮推迟到代码块接近视口时再做。
   *
   * 百万字文档里可能有几千个代码块：挂载时全部丢给 highlight.js，主线程会被
   * 一口气占住好几秒（懒加载的 highlight.js 一到，所有等待中的任务同时开跑）。
   * 纯文本已经先画出来了，预取 800px 再上色，观感上没有空窗。
   */
  useEffect(() => {
    if (!config.preview.highlight) return;
    let alive = true;
    const run = () => {
      if (!alive) return;
      highlightCode(node.code, node.lang, true).then((html) => {
        if (alive) setColored({ key: codeKey, lines: splitHighlightedLines(html) });
      });
    };
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      enqueueHighlight(run);
      return () => {
        alive = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        enqueueHighlight(run);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [codeKey, node.code, node.lang, config.preview.highlight]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(node.code);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [node.code]);

  return (
    <div className={`mde-code${wrap ? " is-wrapped" : ""}`} data-lang={node.lang} ref={rootRef}>
      <div className="mde-code-head">
        {/* 折叠开关放在语言名前面：它对应的就是「这段代码」，读起来是「收起 · python」，比藏在右侧工具里直观 */}
        {canCollapse && (
          <button
            type="button"
            className={`mde-code-tool mde-code-fold${collapsed ? " is-collapsed" : ""}`}
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? labels.expandCode : labels.collapseCode}
            aria-label={collapsed ? labels.expandCode : labels.collapseCode}
            aria-expanded={!collapsed}
          >
            <MdeIcon name="chevron" size={13} />
          </button>
        )}
        <span className="mde-code-lang">
          {config.preview.showCodeLanguage ? node.lang || labels.code : ""}
        </span>
        <span className="mde-code-tools">
          {config.preview.codeActions.wrap && (
            <button
              type="button"
              className={`mde-code-tool${wrap ? " is-active" : ""}`}
              onClick={() => setWrap((v) => !v)}
              title={wrap ? "取消自动换行" : "自动换行"}
              aria-label={wrap ? "取消自动换行" : "自动换行"}
            >
              <MdeIcon name="wrap" size={13} />
            </button>
          )}
          {config.preview.codeActions.copy && (
            <button
              type="button"
              className="mde-code-tool"
              onClick={copy}
              title={copied ? labels.copySuccess : labels.copy}
              aria-label={labels.copy}
            >
              <MdeIcon name={copied ? "check" : "copy"} size={13} />
            </button>
          )}
        </span>
      </div>
      <div
        className={`mde-code-body${collapsed ? " is-collapsed" : ""}`}
        // 折叠态整块可点：没有「展开全部」按钮了，靠底部虚影暗示「下面还有」，
        // 但点击入口不能少——点空白处即展开，也可以点右上角的折叠开关
        onClick={collapsed ? () => setCollapsed(false) : undefined}
        title={collapsed ? labels.expandCode : undefined}
      >
        <div className={`mde-code-lines${showNumbers ? " with-numbers" : ""}`}>
          {lines.map((line, index) => (
            <div
              className={`mde-code-line${highlightLines.has(index + 1) ? " is-highlighted" : ""}`}
              key={index}
            >
              {showNumbers && <span className="mde-code-ln">{index + 1}</span>}
              <span className="mde-code-text" dangerouslySetInnerHTML={{ __html: line || " " }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/** Mermaid 图：渲染失败自动回退为代码块 */
const MermaidBlock: React.FC<CodeBlockProps> = (props) => {
  const { node, config } = props;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    setSvg(null);
    renderMermaid(node.code, config.preview.mermaidTheme).then((result) => {
      if (!alive) return;
      if (result) setSvg(result);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [node.code, config.preview.mermaidTheme]);

  if (failed) return <PlainCodeBlock {...props} />;

  if (!svg) {
    return (
      <div className="mde-mermaid mde-mermaid-loading" aria-busy="true">
        <span className="mde-mermaid-skeleton" />
      </div>
    );
  }

  return <div className="mde-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
};

export const CodeBlock: React.FC<CodeBlockProps> = (props) => {
  const { node, config } = props;
  if (node.lang === "mermaid" && config.preview.mermaid) return <MermaidBlock {...props} />;
  return <PlainCodeBlock {...props} />;
};
