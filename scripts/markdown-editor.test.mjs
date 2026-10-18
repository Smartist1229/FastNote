/**
 * Markdown 解析器回归测试。
 *
 * 覆盖：标题（ATX/Setext）、段落与硬换行、行内格式（粗斜体/删除线/高亮/上下标/代码/链接/图片/
 * 自动链接/公式/脚注）、引用与 GFM Alert、列表（含嵌套/任务/有序起始）、表格对齐、围栏代码、
 * 缩进代码、分割线、HTML 块、front matter、TOC 占位。
 *
 * 断言方式：把 AST 压成可读的一行字符串（`类型|关键字段|子节点`），逐项比对。
 * 这样改解析器时，任何结构变化都会以可读 diff 暴露出来，而不是"渲染出来看着还行"。
 */
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown-editor/parser/block.ts";
import { inlineToText } from "../src/markdown-editor/parser/inline.ts";
import {
  applyCallout,
  applyHeading,
  autoPairOnInput,
  computeStats,
  continueMarkdownOnEnter,
  detectFormats,
  runCommand,
} from "../src/markdown-editor/editor/commands.ts";
import { resolveConfig } from "../src/markdown-editor/defaults.ts";
import { parseCodeMeta, parseLineRanges } from "../src/markdown-editor/render/codeMeta.ts";
import {
  expandReplacement,
  findMatches,
  nextMatchIndex,
  offsetToLine,
  prevMatchIndex,
  replaceAllMatches,
  replaceMatch,
} from "../src/markdown-editor/editor/search.ts";

/** 行内节点 → 紧凑字符串，便于断言 */
const inline = (nodes) =>
  nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "break":
          return n.hard ? "\\n" : " ";
        case "code":
          return `code(${n.value})`;
        case "math":
          return `math(${n.value})`;
        case "link":
          return `link(${n.href})[${inline(n.children)}]`;
        case "image":
          return `img(${n.src})[${n.alt}]`;
        case "footnoteRef":
          return `fn(${n.id}:${n.index})`;
        case "html":
          return `html(${n.value})`;
        default:
          return `${n.type}(${inline(n.children)})`;
      }
    })
    .join("");

const block = (node) => {
  switch (node.type) {
    case "heading":
      return `h${node.level}(${inline(node.children)})`;
    case "paragraph":
      return `p(${inline(node.children)})`;
    case "code":
      return `code[${node.lang}](${node.code})`;
    case "math":
      return `math(${node.code})`;
    case "hr":
      return "hr";
    case "toc":
      return "toc";
    case "html":
      return `html(${node.raw.replace(/\n/g, "\\n")})`;
    case "blockquote":
      return `quote${node.alert ? `:${node.alert}` : ""}(${node.children.map(block).join("; ")})`;
    case "callout":
      return `callout:${node.kind}${node.title ? `[${node.title}]` : ""}${node.fold ? (node.open ? "(fold+)" : "(fold)") : ""}(${node.children
        .map(block)
        .join("; ")})`;
    case "list":
      return `${node.ordered ? `ol:${node.startNumber}` : "ul"}${node.tight ? "" : ":loose"}(${node.items
        .map((item) => `${item.task === null ? "-" : item.task ? "x" : " "}:${item.children.map(block).join(" + ")}`)
        .join("; ")})`;
    case "table":
      return `table[${node.align.map((a) => a ?? "none").join(",")}](${node.header.map(inline).join("|")} // ${node.rows
        .map((row) => row.map(inline).join("|"))
        .join(" / ")})`;
    default:
      return "?";
  }
};

const dump = (src) => {
  const doc = parseMarkdown(src);
  return doc.blocks.map(block).join("\n");
};

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/* ---------------- 标题 ---------------- */
test("ATX 标题 1-6 与闭合井号", () => {
  assert.equal(dump("# 一级"), "h1(一级)");
  assert.equal(dump("###### 六级 ######"), "h6(六级)");
  assert.equal(dump("#无空格"), "p(#无空格)");
  assert.equal(dump("####### 七个井号"), "p(####### 七个井号)");
});

test("Setext 标题", () => {
  assert.equal(dump("标题\n==="), "h1(标题)");
  assert.equal(dump("标题\n---"), "h2(标题)");
});

test("标题锚点与大纲去重", () => {
  const doc = parseMarkdown("# 重复\n\n# 重复\n\n## 重复");
  assert.deepEqual(
    doc.outline.map((o) => o.id),
    ["重复", "重复-1", "重复-2"],
  );
  assert.deepEqual(
    doc.outline.map((o) => o.level),
    [1, 1, 2],
  );
});

/* ---------------- 段落与换行 ---------------- */
test("段落合并与软换行", () => {
  assert.equal(dump("第一行\n第二行"), "p(第一行 第二行)");
});

test("硬换行（两个空格 / 反斜杠）", () => {
  assert.equal(dump("第一行  \n第二行"), "p(第一行\\n第二行)");
  assert.equal(dump("第一行\\\n第二行"), "p(第一行\\n第二行)");
});

test("空行分段", () => {
  assert.equal(dump("A\n\nB"), "p(A)\np(B)");
});

/* ---------------- 行内格式 ---------------- */
test("粗体 / 斜体 / 粗斜体", () => {
  assert.equal(dump("**粗**"), "p(strong(粗))");
  assert.equal(dump("__粗__"), "p(strong(粗))");
  assert.equal(dump("*斜*"), "p(em(斜))");
  assert.equal(dump("_斜_"), "p(em(斜))");
  assert.equal(dump("***粗斜***"), "p(strong(em(粗斜)))");
});

test("嵌套强调", () => {
  assert.equal(dump("**粗 *斜* 粗**"), "p(strong(粗 em(斜) 粗))");
  assert.equal(dump("*斜 **粗** 斜*"), "p(em(斜 strong(粗) 斜))");
});

test("snake_case 不被当成强调", () => {
  assert.equal(dump("foo_bar_baz"), "p(foo_bar_baz)");
});

test("删除线 / 高亮 / 上下标", () => {
  assert.equal(dump("~~删除~~"), "p(del(删除))");
  assert.equal(dump("==高亮=="), "p(mark(高亮))");
  assert.equal(dump("x^2^"), "p(xsup(2))");
  assert.equal(dump("H~2~O"), "p(Hsub(2)O)");
});

test("行内代码优先于其它定界符", () => {
  assert.equal(dump("`a**b**c`"), "p(code(a**b**c))");
  assert.equal(dump("``code with ` tick``"), "p(code(code with ` tick))");
});

test("转义字符", () => {
  assert.equal(dump("\\*不是斜体\\*"), "p(*不是斜体*)");
  assert.equal(dump("\\_x\\_"), "p(_x_)");
});

test("链接：行内 / 标题 / 引用式 / 自动链接", () => {
  assert.equal(dump("[文本](https://a.com)"), "p(link(https://a.com)[文本])");
  assert.equal(dump('[文本](https://a.com "标题")'), "p(link(https://a.com)[文本])");
  assert.equal(dump("[引用][id]\n\n[id]: https://b.com"), "p(link(https://b.com)[引用])");
  assert.equal(dump("[id][]\n\n[id]: https://b.com"), "p(link(https://b.com)[id])");
  assert.equal(dump("<https://c.com/x>"), "p(link(https://c.com/x)[https://c.com/x])");
  assert.equal(dump("裸链接 https://d.com/a."), "p(裸链接 link(https://d.com/a)[https://d.com/a].)");
});

test("图片（行内 / 引用式 / 带标题）", () => {
  assert.equal(dump("![图](a.png)"), "p(img(a.png)[图])");
  assert.equal(dump('![图](a.png "标题")'), "p(img(a.png)[图])");
  assert.equal(dump("![图][pic]\n\n[pic]: b.png"), "p(img(b.png)[图])");
});

test("数学公式：行内与块级", () => {
  assert.equal(dump("$a^2+b^2$"), "p(math(a^2+b^2))");
  assert.equal(dump("$$\nE=mc^2\n$$"), "math(E=mc^2)");
  assert.equal(dump("$$x+y$$"), "math(x+y)");
});

test("行内 HTML 与 HTML 块", () => {
  assert.equal(dump("前 <kbd>Ctrl</kbd> 后"), "p(前 html(<kbd>)Ctrlhtml(</kbd>) 后)");
  assert.equal(dump("<div>\n块内容\n</div>"), "html(<div>\\n块内容\\n</div>)");
});

/* ---------------- 引用 / Alert ---------------- */
test("引用与嵌套引用", () => {
  assert.equal(dump("> 一级"), "quote(p(一级))");
  assert.equal(dump("> > 二级"), "quote(quote(p(二级)))");
  assert.equal(dump("> 第一段\n>\n> 第二段"), "quote(p(第一段); p(第二段))");
});

test("引用内列表", () => {
  assert.equal(dump("> - a\n> - b"), "quote(ul(-:p(a); -:p(b)))");
});

test("GFM Alert", () => {
  assert.equal(dump("> [!NOTE]\n> 内容"), "quote:note(p(内容))");
  assert.equal(dump("> [!WARNING]\n> 小心"), "quote:warning(p(小心))");
});

/* ---------------- 列表 ---------------- */
test("无序列表与松散列表", () => {
  assert.equal(dump("- a\n- b"), "ul(-:p(a); -:p(b))");
  assert.equal(dump("- a\n\n- b"), "ul:loose(-:p(a); -:p(b))");
});

test("有序列表起始序号", () => {
  assert.equal(dump("3. a\n4. b"), "ol:3(-:p(a); -:p(b))");
});

test("嵌套列表", () => {
  const out = dump("- a\n  - b\n  - c\n- d");
  assert.equal(out, "ul(-:p(a) + ul(-:p(b); -:p(c)); -:p(d))");
});

test("任务列表", () => {
  assert.equal(dump("- [ ] 未完成\n- [x] 已完成"), "ul( :p(未完成); x:p(已完成))");
  const doc = parseMarkdown("- [ ] 任务");
  const item = doc.blocks[0].items[0];
  assert.equal(item.task, false);
  // 源码里 `[ ]` 中间的空格位置，用于勾选改写
  assert.equal("- [ ] 任务".slice(item.taskOffset, item.taskOffset + 1), " ");
});

test("列表项多段落", () => {
  assert.equal(dump("- 第一段\n\n  第二段"), "ul:loose(-:p(第一段) + p(第二段))");
});

/* ---------------- 表格 ---------------- */
test("表格与对齐", () => {
  const out = dump("| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
  assert.equal(out, "table[left,center,right](A|B|C // 1|2|3)");
});

test("表格内行内代码含竖线", () => {
  const out = dump("| A | B |\n| --- | --- |\n| `x|y` | 2 |");
  assert.equal(out, "table[none,none](A|B // code(x|y)|2)");
});

test("表格单元格内强调与链接", () => {
  const out = dump("| A |\n| --- |\n| **粗** |");
  assert.equal(out, "table[none](A // strong(粗))");
});

/* ---------------- 代码 ---------------- */
test("围栏代码块：语言、内容、闭合", () => {
  assert.equal(dump("```js\nconst a = 1;\n```"), "code[js](const a = 1;)");
  assert.equal(dump("~~~python\nprint(1)\n~~~"), "code[python](print(1))");
  assert.equal(dump("```\n```"), "code[]()");
});

test("代码块内不解析 Markdown", () => {
  assert.equal(dump("```md\n# 不是标题\n```"), "code[md](# 不是标题)");
});

test("缩进代码块", () => {
  assert.equal(dump("    indented\n    code"), "code[](indented\ncode)");
});

test("围栏代码块未闭合时吞到文末", () => {
  assert.equal(dump("```js\nlet a = 1"), "code[js](let a = 1)");
});

/* ---------------- 其它块 ---------------- */
test("分割线", () => {
  assert.equal(dump("---"), "hr");
  assert.equal(dump("***"), "hr");
  assert.equal(dump("___"), "hr");
});

test("TOC 占位", () => {
  assert.equal(dump("[TOC]"), "toc");
  assert.equal(dump("[[toc]]"), "toc");
});

test("front matter 剥离", () => {
  const doc = parseMarkdown("---\ntitle: 标题\ntags: a,b\n---\n\n正文");
  assert.deepEqual(doc.frontmatter?.data, { title: "标题", tags: "a,b" });
  assert.equal(doc.blocks.length, 1);
  assert.equal(block(doc.blocks[0]), "p(正文)");
});

test("脚注定义与引用", () => {
  const doc = parseMarkdown("正文[^1] 与[^b]\n\n[^1]: 第一条\n[^b]: 第二条");
  assert.equal(doc.footnotes.length, 2);
  assert.deepEqual(
    doc.footnotes.map((f) => [f.id, f.index]),
    [
      ["1", 1],
      ["b", 2],
    ],
  );
  assert.equal(doc.blocks[0].children[1].type, "footnoteRef");
  assert.equal(doc.blocks[0].children[1].index, 1);
});

test("多行脚注定义", () => {
  const doc = parseMarkdown("正文[^a]\n\n[^a]: 第一行\n    第二行");
  assert.equal(doc.footnotes[0].children.length, 1);
  assert.equal(inlineToText(doc.footnotes[0].children[0].children), "第一行 第二行");
});

/* ---------------- 位置信息（实时预览依赖） ---------------- */
test("顶层块 start/end 能精确切出源码", () => {
  const src = "# 标题\n\n第一段\n\n- a\n- b\n\n```js\ncode\n```";
  const doc = parseMarkdown(src);
  for (const node of doc.blocks) {
    const slice = src.slice(node.start, node.end);
    assert.ok(slice.trim().length > 0, `${node.type} 切片为空`);
    assert.ok(!slice.includes("\n\n"), `${node.type} 切片跨越了空行：${JSON.stringify(slice)}`);
  }
  assert.equal(src.slice(doc.blocks[0].start, doc.blocks[0].end), "# 标题");
  assert.equal(src.slice(doc.blocks[2].start, doc.blocks[2].end), "- a\n- b");
});

test("CRLF 归一化", () => {
  assert.equal(dump("# 标题\r\n\r\n正文"), "h1(标题)\np(正文)");
});



/* ---------------- !!! 提示块 ---------------- */
test("!!! 默认渲染为 warning 提示块", () => {
  assert.equal(dump("!!!\n警告内容\n!!!"), "callout:warning(p(警告内容))");
});

test("!!! 支持类型与标题", () => {
  assert.equal(dump('!!! note "小提示"\n内容\n!!!'), "callout:note[小提示](p(内容))");
  assert.equal(dump("!!! caution 小心\n内容\n!!!"), "callout:caution[小心](p(内容))");
  assert.equal(dump("!!! tip\n内容\n!!!"), "callout:tip(p(内容))");
});

test("!!! 首词不是类型时整行当标题", () => {
  assert.equal(dump("!!! 自定义标题\n内容\n!!!"), "callout:warning[自定义标题](p(内容))");
});

test("!!! 内容支持列表、代码与行内格式", () => {
  const out = dump("!!!\n- a\n- b\n\n```js\ncode\n```\n!!!" );
  assert.equal(out, "callout:warning(ul(-:p(a); -:p(b)); code[js](code))");
});

test("!!! 内容缩进 4 空格也能解析（MkDocs 风格）", () => {
  const out = dump("!!! warning\n    第一段\n\n    - 项\n!!!");
  assert.equal(out, "callout:warning(p(第一段); ul(-:p(项)))");
});

test("!!! 未闭合时吞到文末", () => {
  assert.equal(dump("!!!\n内容\n第二段"), "callout:warning(p(内容 第二段))");
});

test("代码块里的 !!! 不当作提示块", () => {
  assert.equal(dump("```\n!!!\n```"), "code[](!!!)");
});

test("提示块出现在引用里", () => {
  assert.equal(dump("> !!!\n> 内容\n> !!!"), "quote(callout:warning(p(内容)))");
});

test("??? 折叠提示块：默认收起，???+ 默认展开", () => {
  const folded = parseMarkdown('??? note "折叠"\n内容\n???');
  assert.equal(folded.blocks[0].type, "callout");
  assert.equal(folded.blocks[0].fold, true);
  assert.equal(folded.blocks[0].open, false);
  assert.equal(folded.blocks[0].kind, "note");
  assert.equal(folded.blocks[0].title, "折叠");
  const expanded = parseMarkdown("???+ tip\n内容\n???");
  assert.equal(expanded.blocks[0].fold, true);
  assert.equal(expanded.blocks[0].open, true);
});

test("??? 内容与 !!! 等价：缩进、未闭合、代码围栏", () => {
  assert.equal(dump("??? warning\n    内容\n???"), "callout:warning(fold)(p(内容))");
  assert.equal(dump("???+\n内容\n第二段"), "callout:warning(fold+)(p(内容 第二段))");
  assert.equal(dump("```\n???\n```"), "code[](???)");
});

test("Admonition 类型别名覆盖 MkDocs Material 全集", () => {
  assert.equal(dump("??? abstract\nx\n???"), "callout:note(fold)(p(x))");
  assert.equal(dump("??? success\nx\n???"), "callout:tip(fold)(p(x))");
  assert.equal(dump("??? faq\nx\n???"), "callout:tip(fold)(p(x))");
  assert.equal(dump("??? attention\nx\n???"), "callout:warning(fold)(p(x))");
  assert.equal(dump("??? bug\nx\n???"), "callout:caution(fold)(p(x))");
  assert.equal(dump("??? cite\nx\n???"), "callout:note(fold)(p(x))");
});

test("代码围栏 info 保留折叠指令", () => {
  const doc = parseMarkdown("```js collapse\ncode\n```");
  assert.equal(doc.blocks[0].lang, "js");
  assert.equal(doc.blocks[0].meta, "collapse");
});

test("callout 命令：插入块并选中占位内容", () => {
  const result = runCommand({ text: "", start: 0, end: 0 }, "callout", options);
  assert.equal(result.text, "!!! warning\n内容\n!!!");
  assert.equal(result.text.slice(result.start, result.end), "内容");
});

test("callout 命令：有选区时包住选区", () => {
  const result = runCommand({ text: "需要提醒", start: 0, end: 4 }, "callout", options);
  assert.equal(result.text, "!!! warning\n需要提醒\n!!!");
  assert.equal(result.text.slice(result.start, result.end), "需要提醒");
});

/* ---------------- 编辑命令 ---------------- */
const options = { tabSize: 2, labels: {} };
const cmd = (text, name, start = text.length, end = start) =>
  runCommand({ text, start, end }, name, options);

test("包裹命令：有选区包裹、无选区插入占位并选中", () => {
  const wrapped = cmd("hello", "bold", 0, 5);
  assert.equal(wrapped.text, "**hello**");
  assert.deepEqual([wrapped.start, wrapped.end], [2, 7]);

  const inserted = cmd("hello", "bold");
  assert.equal(inserted.text, "hello**粗体文本**");
  assert.equal(inserted.text.slice(inserted.start, inserted.end), "粗体文本");
});

test("标题命令：设置、切换同级取消、互斥替换", () => {
  assert.equal(cmd("标题", "heading").text, "# 标题");
  assert.equal(applyHeading({ text: "# 标题", start: 2, end: 2 }, 1).text, "标题");
  assert.equal(applyHeading({ text: "## 标题", start: 3, end: 3 }, 3).text, "### 标题");
});

test("列表命令：加前缀、再点取消、有序编号递增", () => {
  const bullet = cmd("a\nb", "bulletList", 0, 3);
  assert.equal(bullet.text, "- a\n- b");
  assert.equal(runCommand({ text: "- a\n- b", start: 0, end: 5 }, "bulletList", options).text, "a\nb");

  const ordered = cmd("a\nb\nc", "orderedList", 0, 5);
  assert.equal(ordered.text, "1. a\n2. b\n3. c");
});

test("任务列表与缩进", () => {
  assert.equal(cmd("任务", "taskList").text, "- [ ] 任务");
  assert.equal(cmd("a", "indent").text, "  a");
  assert.equal(cmd("  a", "outdent").text, "a");
});

test("代码块 / 表格 / 分割线 / 公式", () => {
  assert.ok(cmd("", "codeBlock").text.includes("```"));
  assert.ok(cmd("", "table").text.includes("| --- |"));
  // 分割线只插「--- + 换行」；前面不在行首才补一个换行
  assert.equal(cmd("", "hr").text, "---\n");
  assert.equal(cmd("正文", "hr").text, "正文\n---\n");
  assert.equal(cmd("", "math").text, "$公式$");
  assert.ok(cmd("", "mathBlock").text.includes("$$"));
});

test("列表 / 引用命令在空行上也要生效", () => {
  // 回归：光标落在空行时点击引用/列表曾毫无反应
  assert.equal(cmd("", "quote").text, "> ");
  assert.equal(cmd("", "bulletList").text, "- ");
  assert.equal(cmd("", "orderedList").text, "1. ");
  assert.equal(cmd("", "taskList").text, "- [ ] ");
  assert.equal(cmd("a\n\nb", "quote", 2, 2).text, "a\n> \nb");
});

test("链接：选中文字后生成链接并选中地址", () => {
  const result = cmd("点这里", "link", 0, 3);
  assert.equal(result.text, "[点这里](https://)");
  assert.equal(result.text.slice(result.start, result.end), "https://");
});

test("脚注：自动编号并追加定义", () => {
  const result = cmd("正文[^1]", "footnote");
  assert.ok(result.text.includes("正文[^1][^2]"));
  assert.ok(result.text.includes("[^2]: 脚注内容"));
});

test("提示块：转换为 GFM Alert 并可取消", () => {
  const alert = applyCallout({ text: "内容", start: 2, end: 2 }, "note");
  assert.equal(alert.text, "> [!NOTE]\n\n> 内容");
  assert.equal(applyCallout({ text: alert.text, start: 3, end: 3 }, "note").text, "内容");
});

test("回车续写列表 / 任务 / 引用", () => {
  const list = continueMarkdownOnEnter("- 第一项", 5, 2);
  assert.equal(list.text, "- 第一项\n- ");
  const ordered = continueMarkdownOnEnter("1. 第一项", 6, 2);
  assert.equal(ordered.text, "1. 第一项\n2. ");
  const task = continueMarkdownOnEnter("- [x] 完成", 8, 2);
  assert.equal(task.text, "- [x] 完成\n- [ ] ");
  const quote = continueMarkdownOnEnter("> 引用", 4, 2);
  assert.equal(quote.text, "> 引用\n> ");
});

test("空列表项回车结束列表", () => {
  const result = continueMarkdownOnEnter("- a\n- ", 6, 2);
  assert.equal(result.text, "- a\n");
});

test("自动配对与跳过右括号", () => {
  const pair = autoPairOnInput("", 0, "(", { brackets: true, quotes: false, backticks: true });
  assert.equal(pair.text, "()");
  assert.equal(pair.caret, 1);
  const skip = autoPairOnInput("()", 1, ")", { brackets: true, quotes: false, backticks: true });
  assert.equal(skip.caret, 2);
  assert.equal(autoPairOnInput("", 0, '"', { brackets: true, quotes: false, backticks: false }), null);
  assert.equal(autoPairOnInput("", 0, "`", { brackets: true, quotes: false, backticks: false }), null);
});

test("统计：中英混排字数与光标位置", () => {
  const stats = computeStats("hello world\n中文", 13);
  assert.equal(stats.words, 4);
  assert.equal(stats.lines, 2);
  assert.equal(stats.cursor.line, 2);
  assert.equal(stats.cursor.column, 2);
});

test("格式状态识别", () => {
  const formats = detectFormats("**粗体**", 2, 4);
  assert.equal(formats.bold, true);
  assert.equal(detectFormats("## 标题", 4, 4).heading, 2);
  assert.equal(detectFormats("- [ ] 任务", 4, 4).taskList, true);
});

test("默认配置可被深合并且数组整体替换", () => {
  const config = resolveConfig({ preview: { typography: { fontSize: 18 } }, toolbar: { items: ["bold"] } });
  assert.equal(config.preview.typography.fontSize, 18);
  // 未覆盖的字段保留默认值
  assert.equal(config.preview.typography.maxWidth, 820);
  assert.deepEqual(config.toolbar.items, ["bold"]);
});


/* ---------------- 代码围栏 meta ---------------- */
test("行号范围：1-2,5", () => {
  assert.deepEqual(parseLineRanges("1-2,5"), [1, 2, 5]);
  assert.deepEqual(parseLineRanges("5-3"), [3, 4, 5]);
  assert.deepEqual(parseLineRanges("7"), [7]);
  assert.deepEqual(parseLineRanges(""), []);
});

test("代码 meta：花括号范围自动开行号", () => {
  const meta = parseCodeMeta("{1-2,5}");
  assert.deepEqual(meta.highlight, [1, 2, 5]);
  assert.equal(meta.lineNumbers, null);
  assert.equal(meta.collapse, false);
});

test("代码 meta：无花括号的范围写法", () => {
  const meta = parseCodeMeta("1-2,5");
  assert.deepEqual(meta.highlight, [1, 2, 5]);
});

test("代码 meta：行号与折叠指令", () => {
  assert.equal(parseCodeMeta("lines").lineNumbers, true);
  assert.equal(parseCodeMeta("nolines").lineNumbers, false);
  assert.equal(parseCodeMeta("collapse").collapse, true);
  assert.equal(parseCodeMeta("{collapse}").collapse, true);
  assert.equal(parseCodeMeta("expand").expand, true);
  assert.equal(parseCodeMeta("nocollapse").foldDisabled, true);
});

test("代码 meta：范围与其它指令共存", () => {
  const meta = parseCodeMeta("{2-3} nolines collapse");
  assert.deepEqual(meta.highlight, [2, 3]);
  assert.equal(meta.lineNumbers, false);
  assert.equal(meta.collapse, true);
});

/* ---------------- 查找 / 替换 ---------------- */
const SEARCH_OPTS = { caseSensitive: false, regex: false };

test("查找：大小写不敏感与敏感", () => {
  const text = "Markdown markup mark";
  assert.equal(findMatches(text, "mark", SEARCH_OPTS).length, 3);
  assert.equal(findMatches(text, "mark", { ...SEARCH_OPTS, caseSensitive: true }).length, 2);
});

test("查找：中文命中的偏移按 UTF-16 索引对齐", () => {
  assert.deepEqual(findMatches("中文中 文文 中文", "中文", SEARCH_OPTS), [
    { start: 0, end: 2 },
    { start: 7, end: 9 },
  ]);
});

test("查找：正则模式与非法正则不抛错", () => {
  assert.equal(findMatches("a1 b2 c3", "\\d", { ...SEARCH_OPTS, regex: true }).length, 3);
  assert.deepEqual(findMatches("abc", "(", { ...SEARCH_OPTS, regex: true }), []);
});

test("查找：非正则模式把元字符当普通文本", () => {
  assert.deepEqual(findMatches("a.c abc", "a.c", SEARCH_OPTS), [{ start: 0, end: 3 }]);
});

test("查找：limit 到量即停", () => {
  assert.equal(findMatches("aaaa", "a", SEARCH_OPTS, 2).length, 2);
});

test("查找：零宽正则不会死循环", () => {
  assert.equal(findMatches("abc", "x*", { ...SEARCH_OPTS, regex: true }).length <= 4, true);
});

test("跳转：下一个 / 上一个与回绕", () => {
  const matches = findMatches("a\nb\nc", "[abc]", { ...SEARCH_OPTS, regex: true });
  assert.equal(nextMatchIndex(matches, 0), 0);
  assert.equal(nextMatchIndex(matches, 1), 1);
  assert.equal(nextMatchIndex(matches, 5, true), 0);
  assert.equal(nextMatchIndex(matches, 5, false), -1);
  assert.equal(prevMatchIndex(matches, 5), 2);
  assert.equal(prevMatchIndex(matches, 0, true), 2);
  assert.equal(prevMatchIndex(matches, 0, false), -1);
});

test("替换：单个替换返回新文本与光标", () => {
  const result = replaceMatch("hello world", { start: 6, end: 11 }, "there");
  assert.equal(result.text, "hello there");
  assert.equal(result.caret, 11);
});

test("替换：全部替换按区间拼接", () => {
  const matches = findMatches("a-a-a", "a", SEARCH_OPTS);
  const result = replaceAllMatches("a-a-a", matches, (matched) => matched.toUpperCase());
  assert.equal(result.text, "A-A-A");
  assert.equal(result.caret, 5);
});

test("替换：正则模式支持 $1 捕获组", () => {
  const replacement = expandReplacement("2026-10", "(\\d{4})-(\\d{2})", "$2/$1", {
    ...SEARCH_OPTS,
    regex: true,
  });
  assert.equal(replacement, "10/2026");
});

test("替换：非正则模式不展开 $1", () => {
  assert.equal(expandReplacement("abc", "abc", "$1", SEARCH_OPTS), "$1");
});

test("偏移转行号", () => {
  assert.equal(offsetToLine("a\nb\nc", 0), 0);
  assert.equal(offsetToLine("a\nb\nc", 2), 1);
  assert.equal(offsetToLine("a\nb\nc", 99), 2);
});

test("配置：查找配置有默认值", () => {
  const config = resolveConfig();
  assert.equal(config.search.enabled, true);
  assert.equal(config.search.maxMatches, 2000);
  assert.equal(typeof config.search.showReplace, "boolean");
});

/* ---------------- 运行 ---------------- */
let passed = 0;
const failures = [];
for (const { name, fn } of cases) {
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push({ name, error });
  }
}

console.log(`\nMarkdown 解析器测试：${passed}/${cases.length} 通过`);
for (const { name, error } of failures) {
  console.log(`\n❌ ${name}\n   ${error.message.split("\n").slice(0, 6).join("\n   ")}`);
}
if (failures.length) process.exit(1);
