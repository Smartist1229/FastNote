/**
 * AST → React 渲染。
 *
 * 为什么用 React 元素而不是拼 HTML 字符串：
 * - 文本天然转义，只有显式 allowHtml 的节点才走 innerHTML；
 * - 任务勾选框、链接点击、TOC 跳转都需要真实事件，字符串方案得靠事件委托猜目标；
 * - 每个顶层块带 `data-line`，分栏滚动同步按源码行映射，而不是按百分比糊弄。
 *
 * 每个顶层块保留原始偏移（data-offset），实时预览整块替换时用它切源码。
 */
import { createElement, Fragment } from "react";
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
import { PreviewCtx, usePreview, type PreviewContextValue } from "./context";
import { CodeBlock } from "./CodeBlock";
import { MathBlock, MathInline } from "./MathNode";
import { sanitizeHtml } from "./sanitize";

const ALERT_LABEL_KEY: Record<AlertKind, string> = {
  note: "alertNote",
  tip: "alertTip",
  important: "alertImportant",
  warning: "alertWarning",
  caution: "alertCaution",
};

/** `!!!` 提示块的图标：按类型区分，比纯色块更容易扫读 */
const CALLOUT_ICON: Record<AlertKind, string> = {
  note: "info",
  tip: "bulb",
  important: "info",
  warning: "alert",
  caution: "octagon",
};

/** 顶层块的公共属性：滚动同步与实时预览定位 */
const blockAttrs = (node: BlockNode, topLevel: boolean) =>
  topLevel ? { "data-line": node.line, "data-offset": node.start } : {};

/** 行内节点渲染 */
export const renderInline = (nodes: InlineNode[], ctx: PreviewContextValue, keyBase: string): ReactNode[] =>
  nodes.map((node, index) => {
    const key = `${keyBase}-${index}`;
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
            className="mde-image"
            loading="lazy"
            draggable={false}
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
      default:
        return null;
    }
  });

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

/** 单个块渲染：实时预览复用它渲染每个可编辑块 */
export const BlockView: React.FC<BlockViewProps> = ({ node, topLevel = false }) => {
  const ctx = usePreview();
  const { config, labels } = ctx;
  const attrs = blockAttrs(node, topLevel);

  switch (node.type) {
    case "heading": {
      const tag = `h${node.level}` as "h1";
      return createElement(
        tag,
        { ...attrs, id: node.id, className: `mde-h mde-h${node.level}` },
        renderInline(node.children, ctx, `h${node.line}`),
      );
    }
    case "paragraph":
      return <p {...attrs}>{renderInline(node.children, ctx, `p${node.line}`)}</p>;
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
    case "toc": {
      const items = ctx.doc.outline.filter((item) => item.level <= config.outline.maxDepth);
      return (
        <nav {...attrs} className="mde-toc-block" aria-label={labels.tocTitle}>
          <div className="mde-toc-title">{labels.tocTitle}</div>
          {items.length === 0 ? (
            <div className="mde-toc-empty">{labels.outlineEmpty}</div>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id} style={{ paddingLeft: (item.level - 1) * 14 }}>
                  <a href={`#${item.id}`}>{item.text}</a>
                </li>
              ))}
            </ul>
          )}
        </nav>
      );
    }
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
              {renderListItemContent(item, ctx, `li${node.line}-${index}`)}
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
                    {renderInline(cell, ctx, `th${node.line}-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: node.align[cellIndex] ?? undefined }}>
                      {renderInline(cell, ctx, `td${node.line}-${rowIndex}-${cellIndex}`)}
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
  onLinkClick?: (href: string, event: ReactMouseEvent) => boolean | void;
  onTaskToggle?: (taskOffset: number, checked: boolean) => void;
}

/** 只读渲染整篇文档 */
export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
  doc,
  config,
  labels,
  readOnly = false,
  className,
  style,
  onLinkClick,
  onTaskToggle,
}) => {
  const hasFrontmatter = config.preview.showFrontmatter && doc.frontmatter;
  return (
    <PreviewCtx.Provider value={{ config, labels, doc, readOnly, onLinkClick, onTaskToggle }}>
      <div className={`mde-preview${className ? ` ${className}` : ""}`} style={style}>
        <div className="mde-preview-content">
          {hasFrontmatter && <FrontmatterCard doc={doc} labels={labels} />}
          {doc.blocks.length === 0 ? (
            <div className="mde-preview-empty">{config.preview.emptyText || labels.empty}</div>
          ) : (
            doc.blocks.map((node) => <BlockView key={`${node.type}-${node.start}`} node={node} topLevel />)
          )}
          {config.preview.showFootnotes && <Footnotes doc={doc} labels={labels} />}
        </div>
      </div>
    </PreviewCtx.Provider>
  );
};

/** 供实时预览渲染单个块时复用上下文 */
export const PreviewProvider = PreviewCtx.Provider;
