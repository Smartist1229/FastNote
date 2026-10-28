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

interface PlainCodeBlockProps extends CodeBlockProps {
  /** 实际用于高亮与展示的语言：用户在预览里临时切换后与 node.lang 不同 */
  lang: string;
  onLangChange: (lang: string) => void;
}

/**
 * 预览里的语言切换项。只影响这一块的渲染，不改写文档里的围栏标记——
 * 用户点错了刷新即恢复，也不会因为一次误触改写源文件。
 */
const LANG_OPTIONS: { value: string; label: string }[] = [
  { value: "plaintext", label: "Plain text" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "tsx", label: "TSX" },
  { value: "jsx", label: "JSX" },
  { value: "json", label: "JSON" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "rust", label: "Rust" },
  { value: "go", label: "Go" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "sql", label: "SQL" },
  { value: "bash", label: "Bash" },
  { value: "powershell", label: "PowerShell" },
  { value: "yaml", label: "YAML" },
  { value: "toml", label: "TOML" },
  { value: "ini", label: "INI" },
  { value: "markdown", label: "Markdown" },
  { value: "xml", label: "XML" },
  { value: "diff", label: "Diff" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "mermaid", label: "Mermaid" },
];

/** 视口内定位：贴在语言按钮下方，越界时上翻 / 夹进左右边界 */
const LangMenu: React.FC<{
  anchor: DOMRect;
  current: string;
  labels: Record<string, string>;
  onSelect: (lang: string) => void;
  onClose: () => void;
}> = ({ anchor, current, labels, onSelect, onClose }) => {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 编辑器自己也有 Esc 处理（关搜索 / 退出预览）：先吃掉，避免连带触发
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const width = 164;
  const maxHeight = 264;
  const left = Math.min(
    Math.max(8, anchor.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  const below = anchor.bottom + 4;
  const top =
    below + maxHeight > window.innerHeight ? Math.max(8, anchor.top - maxHeight - 4) : below;

  return (
    <div
      ref={ref}
      className="mde-code-lang-menu"
      role="menu"
      style={{ left, top, width, maxHeight }}
    >
      {LANG_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={option.value === current}
          className={option.value === current ? "is-active" : undefined}
          onClick={() => onSelect(option.value)}
        >
          <span>{option.value === "plaintext" ? labels.codeLangPlain : option.label}</span>
          {option.value === current && <MdeIcon name="check" size={12} />}
        </button>
      ))}
    </div>
  );
};

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
const PlainCodeBlock: React.FC<PlainCodeBlockProps> = ({ node, config, labels, lang, onLangChange }) => {
  /*
   * 首帧一律先放转义后的纯文本：高亮是异步的，代码原文绝不能直接进 innerHTML
   * （`<img onerror=…>` 这类片段会在高亮结果回来之前先执行一遍）。
   */
  const plain = useMemo(() => splitHighlightedLines(escapeHtml(node.code)), [node.code]);
  const codeKey = `${lang}\u0000${node.code}`;
  const [colored, setColored] = useState<{ key: string; lines: string[] } | null>(null);
  const lines = colored && colored.key === codeKey ? colored.lines : plain;
  const [copyStatus, setCopyStatus] = useState<"copySuccess" | "copyFailed" | null>(null);
  const [wrap, setWrap] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const langRef = useRef<HTMLButtonElement | null>(null);

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
      highlightCode(node.code, lang, true).then((html) => {
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
  }, [codeKey, node.code, lang, config.preview.highlight]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(node.code);
      setCopyStatus("copySuccess");
    } catch {
      setCopyStatus("copyFailed");
    } finally {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopyStatus(null), 1600);
    }
  }, [node.code]);

  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  /** 每次打开都重新量一次位置：代码块可能刚滚动过，旧矩形已经失效 */
  const toggleMenu = () => {
    if (menuAnchor) {
      setMenuAnchor(null);
      return;
    }
    const rect = langRef.current?.getBoundingClientRect();
    if (rect) setMenuAnchor(rect);
  };

  const selectLang = (next: string) => {
    setMenuAnchor(null);
    if (next !== lang) onLangChange(next);
  };

  return (
    <div className={`mde-code${wrap ? " is-wrapped" : ""}`} data-lang={lang} ref={rootRef}>
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
        {config.preview.showCodeLanguage ? (
          /*
           * 语言名兼作切换入口：只改预览的高亮语言，不回写围栏标记。
           * 单独放一个按钮在工具区反而会让「当前语言」和「换语言」分成两处。
           */
          <button
            type="button"
            ref={langRef}
            className={`mde-code-lang${menuAnchor ? " is-open" : ""}`}
            onClick={toggleMenu}
            title={labels.codeLangMenu}
            aria-label={labels.codeLangMenu}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
          >
            <span>{lang || labels.code}</span>
            <MdeIcon name="chevron" size={11} />
          </button>
        ) : (
          // 关掉语言标签时留一个占位，右对齐的工具区才不会塌到左边
          <span className="mde-code-lang" />
        )}
        <span className="mde-code-tools">
          {copyStatus && <span role="status">{labels[copyStatus]}</span>}
          {config.preview.codeActions.wrap && (
            <button
              type="button"
              className={`mde-code-tool${wrap ? " is-active" : ""}`}
              onClick={() => setWrap((v) => !v)}
              title={wrap ? labels.codeWrapOff : labels.codeWrapOn}
              aria-label={wrap ? labels.codeWrapOff : labels.codeWrapOn}
            >
              <MdeIcon name="wrap" size={13} />
            </button>
          )}
          {config.preview.codeActions.copy && (
            <button
              type="button"
              className="mde-code-tool"
              onClick={copy}
              title={copyStatus ? labels[copyStatus] : labels.copyCode}
              aria-label={copyStatus ? labels[copyStatus] : labels.copyCode}
            >
              <MdeIcon name={copyStatus === "copySuccess" ? "check" : "copy"} size={13} />
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
      {menuAnchor && (
        <LangMenu
          anchor={menuAnchor}
          current={lang}
          labels={labels}
          onSelect={selectLang}
          onClose={closeMenu}
        />
      )}
    </div>
  );
};

/** Mermaid 图：渲染失败自动回退为代码块 */
const MermaidBlock: React.FC<PlainCodeBlockProps> = (props) => {
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

  if (failed) return <div title={props.labels.mermaidRenderFailed}><PlainCodeBlock {...props} /></div>;

  if (!svg) {
    return (
      <div className="mde-mermaid mde-mermaid-loading" aria-busy="true" aria-label={props.labels.mermaidLoading}>
        <span className="mde-mermaid-skeleton" />
      </div>
    );
  }

  return <div className="mde-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
};

export const CodeBlock: React.FC<CodeBlockProps> = (props) => {
  const { node, config } = props;
  /*
   * 语言覆盖放在最外层：切到 / 切离 mermaid 要走不同的渲染分支，
   * 状态若留在 PlainCodeBlock 里，外层就看不到新语言。
   */
  const [overrideLang, setOverrideLang] = useState<string | null>(null);
  const lang = overrideLang ?? node.lang;
  const inner = { ...props, lang, onLangChange: setOverrideLang };
  if (lang === "mermaid" && config.preview.mermaid) return <MermaidBlock {...inner} />;
  return <PlainCodeBlock {...inner} />;
};
