/**
 * AST → React 渲染。
 *
 * 为什么用 React 元素而不是拼 HTML 字符串：
 * - 文本天然转义，只有显式 allowHtml 的节点才走 innerHTML；
 * - 任务勾选框、链接点击、TOC 跳转都需要真实事件，字符串方案得靠事件委托猜目标；
 * - 每个顶层块带 `data-line`，分栏滚动同步按编辑行映射，而不是按百分比糊弄。
 *
 * 每个顶层块保留原始偏移（data-offset），实时预览整块替换时用它切编辑区文本。
 */
import { createElement, Fragment, memo, useEffect, useMemo, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type {
  AlertKind,
  BlockNode,
  InlineNode,
  ListItemNode,
  MarkdownEditorConfig,
  ParsedDocument,
} from "../types";
import { MdeIcon } from "../icons";
import { OutlineCtx, PreviewCtx, useOutline, usePreview, type PreviewContextValue } from "./context";
import { CodeBlock } from "./CodeBlock";
import { MathBlock, MathInline } from "./MathNode";
import { sanitizeHtml } from "./sanitize";
import { ImageViewer } from "../components/overlays/ImageViewer";

const ALERT_LABEL_KEY: Record<AlertKind, string> = {
  note: "alertNote",
  tip: "alertTip",
  important: "alertImportant",
  warning: "alertWarning",
  caution: "alertCaution",
};

/**
 * 超过这个块数就给顶层块开 `content-visibility: auto`：
 * 让浏览器跳过屏外块的布局与绘制，长文档的首屏与滚动都因此轻一大截。
 * 短文档用不上这套（还会把分栏滚动同步的块高度读成占位值），所以按量开。
 */
const LARGE_DOC_BLOCKS = 240;

/**
 * 屏外分片的占位高度（每块）：只影响首次估算的滚动条总高，
 * 分片真正排过一次后浏览器会记住实测值（`contain-intrinsic-size: auto`）。
 * 96px 来自长文档实测的块均高，偏差在十几个百分点内。
 */
const CHUNK_BLOCK_ESTIMATE = 96;

/** `!!!` 提示块的图标：按类型区分，比纯色块更容易扫读 */
const CALLOUT_ICON: Record<AlertKind, string> = {
  note: "info",
  tip: "bulb",
  important: "info",
  warning: "alert",
  caution: "octagon",
};

/**
 * 顶层块的公共属性：滚动同步与实时预览定位。
 *
 * 注意 `data-offset` 是**解析时**的偏移：块被上层复用时（内容没变、但前面的文字增删过）
 * 它可能滞后若干字符，`data-line` 则随块一起校验过、始终对得上。
 * 要做整块替换请以 `data-line` 定位，别直接信 `data-offset`。
 */
const blockAttrs = (node: BlockNode, topLevel: boolean) =>
  topLevel ? { "data-line": node.line, "data-offset": node.start } : {};

/**
 * 行内标签的属性（`<u>` / `<font style="color:red">` 的开标签里那段）→ React props。
 *
 * 属性**不信 HTML 字符串**：自己解析一遍，只放行排版相关的几个，
 * 事件属性（`on*`）与危险协议一律丢弃——比先拼字符串再净化更不容易出漏子。
 *
 * 额外埋一个 CSS 变量 `--mde-ink`：这是「默认文字色」的逃生舱。
 * `.mde-mark`（`==高亮==`）自带深色字以便压在黄底上看清，但它同时也是 li-marker 之外的
 * 任何祖先的子元素 —— 一旦外层 `<font style="color:red">` 上了色，这份自带色就把用户的颜色顶掉。
 * 变量沿 DOM 继承下去，`.mde-mark` 改成 `color: var(--mde-ink, 默认值)`，
 * 于是「没指定色 → 用高亮自己的字色」「指定了色 → 跟随用户的颜色」，两个诉求不再打架。
 */
/** 允许透传的普通属性（其余一律丢弃） */
const PASSTHROUGH_ATTRS = new Set(["id", "title", "lang", "dir"]);
const DANGEROUS_VALUE = /expression\s*\(|javascript\s*:|vbscript\s*:/i;

/** `"color:#f00;background-color:#fff"` → React style 对象（顺便滤掉危险值） */
const parseInlineStyle = (style: string): CSSProperties => {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!name || DANGEROUS_VALUE.test(value)) continue;
    out[name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] = value;
  }
  return out as CSSProperties;
};

const parseTagAttrs = (attrString: string): Record<string, unknown> => {
  const props: Record<string, unknown> = {};
  const pairs = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pairs.exec(attrString))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name.startsWith("on")) continue;
    if (DANGEROUS_VALUE.test(value)) continue;
    if (name === "class") props.className = value;
    else if (name === "style") props.style = parseInlineStyle(value);
    else if (PASSTHROUGH_ATTRS.has(name)) props[name] = value;
  }
  return props;
};

/**
 * 行内节点渲染。
 *
 * `keyBase` 只用来保证兄弟之间不撞名，**绝不能掺进 `line` / `start` 这类编辑坐标**：
 * 每敲一个字，后面所有块的坐标都会平移一位，掺了坐标的 key 会跟着全部变化，
 * React 于是把整棵预览树 unmount 重挂一遍（DOM 全删全建，代码块的高亮 effect 也全部重跑）。
 * 这里统一用固定的族名 + 下标，坐标再怎么变 key 都不动。
 */
export const renderInline = (nodes: InlineNode[], ctx: PreviewContextValue, keyBase: string): ReactNode[] =>
  nodes.map((node, index) => renderInlineNode(node, ctx, `${keyBase}-${index}`));

const renderInlineNode = (node: InlineNode, ctx: PreviewContextValue, key: string): ReactNode => {
  switch (node.type) {
    case "text":
      return <Fragment key={key}>{node.value}</Fragment>;
    case "strong":
      return <strong key={key}>{renderInline(node.children, ctx, key)}</strong>;
    case "em":
      return <em key={key}>{renderInline(node.children, ctx, key)}</em>;
    case "del":
      return <del key={key}>{renderInline(node.children, ctx, key)}</del>;
    case "mark":
      return (
        <mark key={key} className="mde-mark">
          {renderInline(node.children, ctx, key)}
        </mark>
      );
    case "sup":
      return <sup key={key}>{renderInline(node.children, ctx, key)}</sup>;
    case "sub":
      return <sub key={key}>{renderInline(node.children, ctx, key)}</sub>;
    case "code":
      return (
        <code key={key} className="mde-inline-code">
          {node.value}
        </code>
      );
    case "math":
      return <MathInline key={key} code={node.value} enabled={ctx.config.preview.math} />;
    case "break":
      return node.hard ? <br key={key} /> : <Fragment key={key}> </Fragment>;
    case "link":
      return (
        <a
          key={key}
          href={node.href}
          title={node.title}
          className="mde-link"
          onClick={(event) => {
            const href = node.href;
            if (href.startsWith("#")) {
              // 页内锚点：留给浏览器/预览容器处理
              return;
            }
            const verdict = ctx.onLinkClick?.(href, event);
            if (verdict === false) {
              event.preventDefault();
              return;
            }
            if (!ctx.onLinkClick) {
              event.preventDefault();
              window.open(href, ctx.config.preview.linkTarget, "noopener,noreferrer");
            }
          }}
        >
          {renderInline(node.children, ctx, key)}
        </a>
      );
    case "image":
      return (
        <img
          key={key}
          src={node.src}
          alt={node.alt}
          title={node.title}
          className={`mde-image${ctx.config.preview.imagePreview ? " is-zoomable" : ""}`}
          loading="lazy"
          draggable={false}
          onClick={
            ctx.config.preview.imagePreview
              ? () => {
                  // 宿主传了 onImageClick 就完全交给它（例如换成自己的灯箱）
                  if (ctx.onImageClick) ctx.onImageClick(node.src, node.alt);
                  else ctx.showImage?.(node.src, node.alt);
                }
              : undefined
          }
        />
      );
    case "footnoteRef":
      return (
        <sup key={key} className="mde-fn-ref">
          <a href={`#mde-fn-${node.index}`} id={`mde-fnref-${node.index}`}>
            {node.index}
          </a>
        </sup>
      );
    case "html": {
      if (!ctx.config.preview.allowHtml) return <Fragment key={key}>{node.value}</Fragment>;
      const html = ctx.config.preview.sanitizeHtml ? sanitizeHtml(node.value) : node.value;
      return <span key={key} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    /**
     * 成对标签：内部 Markdown 已由解析器展开成 children，这里照常递归渲染。
     *
     * 优先级落在 CSS 自己的层叠上：`<font style="color:red">**粗体**</font>` 里色在祖先、
     * 粗细在子，天然不打架；`==高亮==` 的黄底同理（底色由上色的祖先给，mark 只管自己的一块）。
     * 唯一需要人工干预的是 mark 自带的那份字色 —— 靠 `--mde-ink` 变量让位，见 parseTagAttrs。
     */
    case "htmlInline": {
      const attrs = parseTagAttrs(node.attrs) as Record<string, unknown>;
      const style = (attrs.style ?? {}) as Record<string, string>;
      if (typeof style.color === "string") attrs.style = { ...style, "--mde-ink": style.color };
      return createElement(node.tag, { key, ...attrs }, renderInline(node.children, ctx, key));
    }
    default:
      return null;
  }
};

/** 列表项内容：紧凑列表不包 <p>，避免行距被段间距撑开 */
const renderListItemContent = (item: ListItemNode, ctx: PreviewContextValue, key: string): ReactNode[] => {
  return item.children.map((child, index) => {
    const childKey = `${key}-${index}`;
    if (child.type === "paragraph") {
      return <Fragment key={childKey}>{renderInline(child.children, ctx, childKey)}</Fragment>;
    }
    return <BlockView key={childKey} node={child} />;
  });
};

interface BlockViewProps {
  node: BlockNode;
  /** 顶层块才输出 data-line / data-offset */
  topLevel?: boolean;
}

/** TOC 正文：只有它订阅大纲，避免大纲变化惊动整篇块 */
const TocBody: React.FC = () => {
  const ctx = usePreview();
  const outline = useOutline();
  const items = outline.filter((item) => item.level <= ctx.config.outline.maxDepth);
  if (!items.length) return <div className="mde-toc-empty">{ctx.labels.outlineEmpty}</div>;
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id} style={{ paddingLeft: (item.level - 1) * 14 }}>
          <a href={`#${item.id}`}>{item.text}</a>
        </li>
      ))}
    </ul>
  );
};

/**
 * 单个块渲染：实时预览复用它渲染每个可编辑块。
 *
 * memo 是这里的命门：打字时整篇解析会为每一个块造新对象，
 * 没有这层的话 2800 个块连同子树会被全量重渲染。
 * 上层按「文本变化区间」把没被碰到的块换回旧对象，这层就能把它们整个跳过。
 */
/**
 * 块内容是否相同（忽略 start / end）。
 *
 * 增量解析为了维持正确的绝对偏移，会把尾部块的 start/end 平移后生成新对象；
 * 换行时还会一起平移 line。只要内容与 line 没变就不该重画——`data-offset`
 * 允许滞后（见 blockAttrs 的说明），而 `data-line` 是滚动同步的锚点，变了必须重画。
 * 任务项的 taskOffset 会随平移变化，`items` 数组引用因此不同，会正常触发重画。
 */
const sameBlockNode = (a: BlockNode, b: BlockNode): boolean => {
  if (a === b) return true;
  if (a.type !== b.type || a.line !== b.line) return false;
  switch (a.type) {
    case "heading": {
      const prev = a;
      const next = b as typeof prev;
      return prev.level === next.level && prev.id === next.id && prev.children === next.children;
    }
    case "paragraph": {
      const next = b as typeof a;
      return a.children === next.children;
    }
    case "code": {
      const next = b as typeof a;
      return a.lang === next.lang && a.meta === next.meta && a.code === next.code && a.fence === next.fence;
    }
    case "math":
      return a.code === (b as typeof a).code;
    case "blockquote": {
      const next = b as typeof a;
      return a.alert === next.alert && a.children === next.children;
    }
    case "callout": {
      const next = b as typeof a;
      return (
        a.kind === next.kind &&
        a.title === next.title &&
        a.fold === next.fold &&
        a.open === next.open &&
        a.children === next.children
      );
    }
    case "list": {
      const next = b as typeof a;
      return (
        a.ordered === next.ordered &&
        a.startNumber === next.startNumber &&
        a.tight === next.tight &&
        a.items === next.items
      );
    }
    case "table": {
      const next = b as typeof a;
      return a.align === next.align && a.header === next.header && a.rows === next.rows;
    }
    case "html":
      return a.raw === (b as typeof a).raw;
    default:
      return true;
  }
};

const BlockViewBase: React.FC<BlockViewProps> = ({ node, topLevel = false }) => {
  const ctx = usePreview();
  const { config, labels } = ctx;
  const attrs = blockAttrs(node, topLevel);

  switch (node.type) {
    case "heading": {
      const tag = `h${node.level}` as "h1";
      return createElement(
        tag,
        { ...attrs, id: node.id, className: `mde-h mde-h${node.level}` },
        renderInline(node.children, ctx, "h"),
      );
    }
    case "paragraph":
      return <p {...attrs}>{renderInline(node.children, ctx, "p")}</p>;
    case "code":
      return (
        <div {...attrs} className="mde-code-wrap">
          <CodeBlock node={node} config={config} labels={labels} />
        </div>
      );
    case "math":
      return (
        <div {...attrs}>
          <MathBlock code={node.code} enabled={config.preview.math} />
        </div>
      );
    case "hr":
      return <hr {...attrs} className="mde-hr" />;
    case "toc":
      // TOC 单独订阅大纲：其它块不订阅，打字时才不会被大纲数组的变化带起来
      return (
        <nav {...attrs} className="mde-toc-block" aria-label={labels.tocTitle}>
          <div className="mde-toc-title">{labels.tocTitle}</div>
          <TocBody />
        </nav>
      );
    case "html": {
      if (!config.preview.allowHtml) return <p {...attrs}>{node.raw}</p>;
      const html = config.preview.sanitizeHtml ? sanitizeHtml(node.raw) : node.raw;
      return <div {...attrs} className="mde-html-block" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    case "callout": {
      const head = (
        <>
          <MdeIcon name={CALLOUT_ICON[node.kind]} size={14} />
          <span>{node.title || labels[ALERT_LABEL_KEY[node.kind]]}</span>
        </>
      );
      const body = (
        <div className="mde-callout-body">
          {node.children.map((child, index) => (
            <BlockView key={index} node={child} />
          ))}
        </div>
      );
      // `???` / `???+` 语法：渲染成可折叠的 <details>；config 关掉折叠则退回常驻块
      if (node.fold && config.preview.calloutCollapsible) {
        return (
          <details {...attrs} className={`mde-callout is-fold is-${node.kind}`} open={node.open}>
            <summary className="mde-callout-head" aria-label={node.title || labels[ALERT_LABEL_KEY[node.kind]]}>
              {head}
              <MdeIcon name="chevron" size={12} className="mde-callout-caret" />
            </summary>
            {body}
          </details>
        );
      }
      return (
        <div {...attrs} className={`mde-callout is-${node.kind}`}>
          <div className="mde-callout-head">{head}</div>
          {body}
        </div>
      );
    }
    case "blockquote": {
      const alert = node.alert;
      return (
        <blockquote
          {...attrs}
          className={`mde-quote${alert ? ` mde-alert mde-alert-${alert}` : ""}`}
        >
          {alert && <div className="mde-alert-title">{labels[ALERT_LABEL_KEY[alert]]}</div>}
          {node.children.map((child, index) => (
            <BlockView key={index} node={child} />
          ))}
        </blockquote>
      );
    }
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      return createElement(
        tag,
        {
          ...attrs,
          className: `mde-list${node.tight ? " is-tight" : ""}${node.items.some((i) => i.task !== null) ? " has-task" : ""}`,
          ...(node.ordered && node.startNumber !== 1 ? { start: node.startNumber } : {}),
        },
        node.items.map((item, index) => (
          <li key={index} className={item.task !== null ? "mde-task-item" : undefined}>
            {item.task !== null && (
              <input
                type="checkbox"
                className="mde-task-checkbox"
                checked={item.task}
                disabled={!config.preview.taskInteractive || ctx.readOnly}
                onChange={(event) => ctx.onTaskToggle?.(item.taskOffset, event.target.checked)}
                aria-label={labels.taskList}
              />
            )}
            <span className="mde-li-content">
              {renderListItemContent(item, ctx, `li${index}`)}
            </span>
          </li>
        )),
      );
    }
    case "table": {
      const { striped, bordered, compact, fullWidth } = config.preview.tables;
      return (
        <div {...attrs} className="mde-table-wrap">
          <table
            className={`mde-table${striped ? " is-striped" : ""}${bordered ? " is-bordered" : ""}${
              compact ? " is-compact" : ""
            }${fullWidth ? " is-full" : ""}`}
          >
            <thead>
              <tr>
                {node.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: node.align[index] ?? undefined }}>
                    {renderInline(cell, ctx, `th${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: node.align[cellIndex] ?? undefined }}>
                      {renderInline(cell, ctx, `td${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
};

export const BlockView = memo(
  BlockViewBase,
  (prev, next) => prev.topLevel === next.topLevel && sameBlockNode(prev.node, next.node),
);

/** front matter 元信息卡 */
export const FrontmatterCard: React.FC<{ doc: ParsedDocument; labels: Record<string, string> }> = ({ doc, labels }) => {
  if (!doc.frontmatter || Object.keys(doc.frontmatter.data).length === 0) return null;
  return (
    <section className="mde-frontmatter">
      <div className="mde-frontmatter-title">{labels.frontmatter}</div>
      <dl>
        {Object.entries(doc.frontmatter.data).map(([key, value]) => (
          <div className="mde-frontmatter-row" key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

/** 脚注区 */
export const Footnotes: React.FC<{ doc: ParsedDocument; labels: Record<string, string> }> = ({ doc, labels }) => {
  if (!doc.footnotes.length) return null;
  return (
    <section className="mde-footnotes" aria-label={labels.footnotes}>
      <div className="mde-footnotes-title">{labels.footnotes}</div>
      <ol>
        {doc.footnotes.map((item) => (
          <li key={item.id} id={`mde-fn-${item.index}`}>
            {item.children.map((child, index) => (
              <BlockView key={index} node={child} />
            ))}
            <a className="mde-fn-back" href={`#mde-fnref-${item.index}`} aria-label="返回正文">
              ↩
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
};

export interface MarkdownPreviewProps {
  doc: ParsedDocument;
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  readOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  /** 主题变量：图片放大浮层 portal 到 body 后需要它来继承配色 */
  themeVars?: Record<string, string>;
  /**
   * 整篇替换的代次：换笔记 / 整篇粘贴 / 首次挂载时变化，普通打字保持不变。
   * 变化就意味着「这一整篇 DOM 都要重造」，预览据此分批铺（见 `useProgressiveBlocks`）。
   */
  generation?: number;
  onLinkClick?: (href: string, event: ReactMouseEvent) => boolean | void;
  onTaskToggle?: (taskOffset: number, checked: boolean) => void;
  onImageClick?: (src: string, alt: string) => boolean | void;
}

/** 首批铺多少块：够盖住两三屏，再多半点意义都没有 */
const FIRST_PAINT_BLOCKS = 320;
/** 空闲帧里每批补多少块 */
const FILL_STEP_BLOCKS = 512;

/**
 * 分批把顶层块铺进 DOM，返回这一趟要铺的块数。
 *
 * 长文档的预览是整篇 DOM：一次性提交七千多个块在中低端机器上就是两秒多的白屏，
 * 而这期间用户什么也看不到。这里先只铺够盖住一屏的量，剩下的交给空闲帧补齐——
 * 屏外分片本来就带 `content-visibility`，补进来也不排版，滚动条高度由
 * `contain-intrinsic-size` 先顶着，所以补齐过程中画面不会跳。
 *
 * 只有 `generation` 变化（整篇替换）才重新计数：打字时块对象本来就被复用，
 * 一次提交只动真正改过的那一两块，分批反而会让人看着正文一段段长出来。
 */
const useProgressiveBlocks = (total: number, generation: number): number => {
  const [shown, setShown] = useState(() =>
    total > LARGE_DOC_BLOCKS ? Math.min(total, FIRST_PAINT_BLOCKS) : total,
  );
  const [seen, setSeen] = useState(generation);
  // 渲染期同步把计数压回首批：等 effect 再压的话，这一帧已经把整篇铺完了
  if (generation !== seen) {
    setSeen(generation);
    setShown(total > LARGE_DOC_BLOCKS ? Math.min(total, FIRST_PAINT_BLOCKS) : total);
  }
  useEffect(() => {
    if (shown >= total) return;
    const idle = (
      globalThis as unknown as {
        requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
      }
    ).requestIdleCallback;
    const cancel = (
      globalThis as unknown as { cancelIdleCallback?: (handle: number) => void }
    ).cancelIdleCallback;
    const pump = () => setShown((value) => Math.min(total, value + FILL_STEP_BLOCKS));
    const handle = idle ? idle(pump, { timeout: 200 }) : globalThis.setTimeout(pump, 16);
    return () => {
      if (idle && cancel) cancel(handle);
      else globalThis.clearTimeout(handle);
    };
  }, [shown, total]);
  return Math.min(shown, total);
};

/**
 * 顶层块按固定大小分片。
 *
 * 分片是为了挡住「一个块变了、一万个块跟着重渲染」：分片自身是 memo 的，
 * 只要这一片里的块对象都没变，React 就不必往下走那 128 个 BlockView。
 * 解析复用块对象（见 MarkdownEditor 的 shareBlocks / 增量解析）时，
 * 一次按键只有真正动过的那一片会重建。
 *
 * 片内 key 仍用全文下标：增删块会让后续分片整体错位再重建，
 * 但这只发生在换行/删除整块时，且 DOM 结果与不下标 key 的旧行为一致。
 */
const BLOCK_CHUNK = 128;

const BlockChunk = memo(
  function BlockChunk({
    blocks,
    start,
    topLevel,
    contained,
  }: {
    blocks: BlockNode[];
    start: number;
    topLevel: boolean;
    /** 长文档：整片作为一个 `content-visibility` 容器，屏外时整片跳过排版 */
    contained: boolean;
  }) {
    const body = blocks.map((node, index) => (
      <BlockView key={start + index} node={node} topLevel={topLevel} />
    ));
    if (!contained) return <>{body}</>;
    /*
     * 包一层而不是给每个块都开 `content-visibility`：后者会让浏览器在每次滚动时
     * 对上万个块逐个做「是否接近视口」的判定，百万字文档上一滚一个几百毫秒的长任务。
     * 按分片包起来后判定对象只剩一百多个，屏外照旧跳过排版，DOM 却完整保留
     * ——框选、复制、页内查找都还是整篇。
     */
    return (
      <div
        className="mde-chunk"
        data-line={blocks[0]?.line}
        style={{ containIntrinsicSize: `auto ${blocks.length * CHUNK_BLOCK_ESTIMATE}px` }}
      >
        {body}
      </div>
    );
  },
  (prev, next) => {
    if (prev.topLevel !== next.topLevel || prev.start !== next.start) return false;
    if (prev.contained !== next.contained) return false;
    if (prev.blocks.length !== next.blocks.length) return false;
    for (let index = 0; index < prev.blocks.length; index += 1) {
      if (!sameBlockNode(prev.blocks[index], next.blocks[index])) return false;
    }
    return true;
  },
);

/**
 * 顶层块列表：按片渲染，未变的分片整片跳过。
 *
 * 不能用 `node.start` 当 key——打字会让后面每一块的 start 平移，
 * 于是整篇块被判定成「换了一批元素」而全部重挂。用下标则打字时 key 纹丝不动，
 * 只有真正增删块时尾部才会重建，这在文档里是少数情况。
 */
const BlockList: React.FC<{ doc: ParsedDocument; contained: boolean; limit: number }> = ({
  doc,
  contained,
  limit,
}) => {
  const total = Math.min(doc.blocks.length, limit);
  if (!total) return null;
  const chunks = [];
  for (let index = 0; index < total; index += BLOCK_CHUNK) {
    const end = Math.min(total, index + BLOCK_CHUNK);
    chunks.push(
      <BlockChunk
        key={index}
        blocks={doc.blocks.slice(index, end)}
        start={index}
        topLevel
        contained={contained}
      />,
    );
  }
  return <>{chunks}</>;
};

/** 只读渲染整篇文档（memo：doc / 配置不变时整棵预览直接跳过） */
const MarkdownPreviewBase: React.FC<MarkdownPreviewProps> = ({
  doc,
  config,
  labels,
  readOnly = false,
  className,
  style,
  themeVars,
  generation = 0,
  onLinkClick,
  onTaskToggle,
  onImageClick,
}) => {
  const hasFrontmatter = config.preview.showFrontmatter && doc.frontmatter;
  const large = doc.blocks.length > LARGE_DOC_BLOCKS;
  const shown = useProgressiveBlocks(doc.blocks.length, generation);
  const empty = config.preview.emptyText || labels.empty;
  /*
   * 宿主没接管图片点击时，预览自己弹放大浮层。
   * 浮层状态放在这里（而不是每一张图各自持有），同一时刻只会有一层。
   */
  const [viewing, setViewing] = useState<{ src: string; alt: string } | null>(null);
  /*
   * 这里刻意不把 doc 放进上下文。
   *
   * doc 每次解析都是新对象，放进去了就会把整篇块的订阅者全部唤醒，
   * 块级 memo 直接失效——2800 个块又变成每次按键全量重渲染。
   * 真正依赖 doc 的只有 TOC 与大纲，它们走各自的 context / props。
   */
  const ctx = useMemo(
    () => ({
      config,
      labels,
      readOnly,
      onLinkClick,
      onTaskToggle,
      onImageClick,
      showImage: (src: string, alt: string) => setViewing({ src, alt }),
    }),
    [config, labels, readOnly, onLinkClick, onTaskToggle, onImageClick],
  );
  return (
    <PreviewCtx.Provider value={ctx}>
      <OutlineCtx.Provider value={doc.outline}>
        <div
          className={`mde-preview${large ? " is-large" : ""}${
            className ? ` ${className}` : ""
          }`}
          style={style}
        >
          <div className="mde-preview-content">
            {hasFrontmatter && <FrontmatterCard doc={doc} labels={labels} />}
            {doc.blocks.length === 0 ? (
              <div className="mde-preview-empty">{empty}</div>
            ) : (
              <BlockList doc={doc} contained={large} limit={shown} />
            )}
            {config.preview.showFootnotes && <Footnotes doc={doc} labels={labels} />}
          </div>
        </div>
        {viewing && !onImageClick && (
          <ImageViewer
            src={viewing.src}
            alt={viewing.alt}
            config={config.preview.imageZoom}
            themeVars={themeVars}
            onClose={() => setViewing(null)}
          />
        )}
      </OutlineCtx.Provider>
    </PreviewCtx.Provider>
  );
};

export const MarkdownPreview = memo(MarkdownPreviewBase);

/** 供实时预览渲染单个块时复用上下文 */
export const PreviewProvider = PreviewCtx.Provider;
