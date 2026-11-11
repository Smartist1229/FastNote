/**
 * 自绘正文弹窗：完全由插件自己拼 DOM，不借宿主的 Markdown 渲染。
 *
 * 目的是和「笔记历史版本对比」长一个样：等宽 12px、左侧行号槽、顶部一行统计、
 * 一个带边框的滚动区。样式全在 ../style.css 的 .plugin-demo-source* 里，
 * 颜色用宿主暴露的 --color-* 变量，所以主题一换它跟着变。
 *
 * 走的是 ctx.ui.modal 的 content 分支：返回一个 HTMLElement，宿主原样挂进内容区。
 * 这是插件「添加弹窗」的标准做法——宿主只提供空壳，长什么样归插件。
 */

/** 单次最多画多少行：再长就不是「看一眼原文」了，弹窗里铺几万个节点会卡住主线程 */
const MAX_ROWS = 3000;

/** 把正文拆成行模型（去尾部空行，行号从 1 开始） */
const toRows = (raw) => {
  const text = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return { text, rows: text.split("\n") };
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** 组装弹窗内容：头部统计行 + 行号视图 */
const buildView = (text, rows, t, heading) => {
  const root = el("div", "plugin-demo-source");
  const head = el("div", "plugin-demo-source-head");
  head.append(
    el("span", "plugin-demo-source-heading", heading || t("source.heading")),
    el("span", "plugin-demo-source-tag", t("source.readOnly")),
  );
  const visibleRows = rows.slice(0, MAX_ROWS);
  const chars = text.replace(/\s/g, "").length;
  head.append(
    el(
      "span",
      "plugin-demo-source-meta",
      t("source.stats", { lines: visibleRows.length, chars }),
    ),
  );
  root.append(head);

  const body = el("div", "plugin-demo-source-body");
  // 一次性插进 DocumentFragment：长笔记也只触发一次布局
  const fragment = document.createDocumentFragment();
  visibleRows.forEach((line, index) => {
    const row = el("div", "plugin-demo-source-row");
    row.append(
      el("span", "plugin-demo-source-no", String(index + 1)),
      el("span", "plugin-demo-source-text", line === "" ? " " : line),
    );
    fragment.append(row);
  });
  body.append(fragment);
  root.append(body);

  if (rows.length > MAX_ROWS) {
    root.append(el("div", "plugin-demo-source-more", t("source.truncated", { total: rows.length })));
  }
  return root;
};

/**
 * 打开「逐行文本」弹窗：读取正文、插件表报告这类「看一眼原文」的场景都用它。
 * @param {object} ctx 插件上下文
 * @param {string} text 原样展示的文本（不解析 Markdown）
 * @param {{ title: string, heading?: string }} options 弹窗标题 / 头部标签
 */
export const openSourceModal = (ctx, text, options) => {
  const t = (key, vars) => ctx.i18n.t(key, vars);
  const { text: normalized, rows } = toRows(text);
  // 宽度档位复用宿主 Modal 的公开参数，弹窗本体不另写一套
  return ctx.ui.modal({
    title: options.title,
    size: "2xl",
    buttons: [{ label: t("source.close") }],
    content: () => buildView(normalized, rows, t, options.heading),
  });
};
