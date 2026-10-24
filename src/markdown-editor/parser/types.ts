/**
 * Markdown AST 类型定义。
 *
 * 设计原则：
 * - 块级节点带 `start` / `end`（相对原始字符串的绝对偏移）与 `line`（1 起算的行号），
 *   实时预览的块级就地编辑、滚动同步、任务勾选改写正文都依赖这三个字段；
 * - 行内节点只保留语义，不保留来源位置——行内改写走“整块替换”，不需要逐字符定位；
 * - 所有扩展语法（高亮 ==x==、上下标、Alert、TOC、脚注）都是可选的，解析时无开关，
 *   渲染时由配置决定是否生效，保证 AST 与视图解耦。
 */

/** 块级节点公共字段 */
interface BlockBase {
  /** 编辑区起始偏移 */
  start: number;
  /** 编辑区结束偏移（不含），用于整块替换 */
  end: number;
  /** 编辑区行号，1 起算 */
  line: number;
}

/** 行内节点 */
export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "del"; children: InlineNode[] }
  | { type: "mark"; children: InlineNode[] }
  | { type: "sup"; children: InlineNode[] }
  | { type: "sub"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; title?: string; children: InlineNode[] }
  | { type: "image"; src: string; title?: string; alt: string }
  | { type: "math"; value: string }
  | { type: "break"; hard: boolean }
  /**
   * 落单的行内标签（找不到配对、或本来就不需要配对的自闭合标签）。
   * 只有闭标签、半句话刚打完 `<u>` 这类中间态都落到这里。
   */
  | { type: "html"; value: string }
  /**
   * 成对的行内标签：`<u>…</u>`、`<font style="color:red">…</font>`。
   *
   * 配对待打交道的是「嵌套」——所以必须在**解析期**就做成树：
   * 渲染期只能看到自己那一层的兄弟节点，`==<font …>x</font>==` 这种跨节点包夹
   * 根本配不上（此前就是这么丢色的）。`tag` 小写、`attrs` 是开标签里除标签名以外的原文。
   */
  | { type: "htmlInline"; tag: string; attrs: string; raw: string; children: InlineNode[] }
  | { type: "footnoteRef"; id: string; index: number };

/** 任务列表勾选状态：null = 普通列表项 */
export type TaskState = boolean | null;

/** 列表项 */
export interface ListItemNode {
  children: BlockNode[];
  task: TaskState;
  /** 任务勾选框 `[ ]` 中间的字符在编辑区中的偏移；非任务项为 -1 */
  taskOffset: number;
  line: number;
}

/** 表格对齐 */
export type TableAlign = "left" | "center" | "right" | null;

/** GFM 提示块类型 */
export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

/** 块级节点 */
export type BlockNode =
  | (BlockBase & { type: "paragraph"; children: InlineNode[] })
  | (BlockBase & { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; id: string; children: InlineNode[] })
  | (BlockBase & { type: "code"; lang: string; meta: string; code: string; fence: string })
  | (BlockBase & { type: "math"; code: string })
  | (BlockBase & { type: "blockquote"; children: BlockNode[]; alert: AlertKind | null })
  | (BlockBase & {
      type: "callout";
      kind: AlertKind;
      title: string;
      /** 可折叠（`???` / `???+` 语法） */
      fold: boolean;
      /** 折叠块的初始状态（`???+` 为 true） */
      open: boolean;
      children: BlockNode[];
    })
  | (BlockBase & {
      type: "list";
      ordered: boolean;
      /** 有序列表起始序号（无序列表恒为 1） */
      startNumber: number;
      tight: boolean;
      items: ListItemNode[];
    })
  | (BlockBase & {
      type: "table";
      align: TableAlign[];
      header: InlineNode[][];
      rows: InlineNode[][][];
    })
  | (BlockBase & { type: "hr" })
  | (BlockBase & { type: "html"; raw: string })
  | (BlockBase & { type: "toc" });

/** 脚注定义（按首次引用顺序输出） */
export interface FootnoteItem {
  id: string;
  label: string;
  children: BlockNode[];
  /** 渲染锚点用的序号，1 起算 */
  index: number;
}

/** 文档级解析结果 */
export interface ParsedDocument {
  /** 顶层块；块内的 start/end 只对顶层有实际意义（嵌套块为容器内的相对偏移） */
  blocks: BlockNode[];
  /** YAML front matter（存在时从正文中剥离） */
  frontmatter: { raw: string; data: Record<string, string> } | null;
  /** 标题大纲（只取顶层标题） */
  outline: OutlineItem[];
  /** 脚注，按首次引用排序；未被引用的定义排在最后 */
  footnotes: FootnoteItem[];
  /** 引用式链接定义表 */
  links: Map<string, { href: string; title?: string }>;
}

export interface OutlineItem {
  id: string;
  text: string;
  level: number;
  line: number;
}

/** 行内解析上下文：引用式链接、脚注序号都需要跨块共享 */
export interface InlineContext {
  links: Map<string, { href: string; title?: string }>;
  /** 脚注 id → 序号（首次引用时分配） */
  footnoteIndex: Map<string, number>;
  /** 已引用的脚注顺序 */
  footnoteOrder: string[];
  allowHtml: boolean;
  /** 单个换行（GFM breaks）：`\n` 直接算硬换行，而不是靠行尾两个空格 */
  breaks: boolean;
}
