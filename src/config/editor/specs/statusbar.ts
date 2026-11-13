/**
 * 编辑器设置 · 状态栏组。
 *
 * 数据表拆自 `editorSettingSpecs.ts`：一个分组一个文件，改某一组时不用在 1100 行里上下找；
 * 顺序由主文件的展开顺序决定，这里的元素顺序就是弹窗里的排列顺序。
 */
import type { EditorSettingSpec } from "../editorSettingSpecs";

export const STATUS_BAR_SPECS: EditorSettingSpec[] = [
  {
    field: "showStatusBar",
    group: "状态栏",
    kind: "toggle",
    title: "显示状态栏",
    desc: "编辑器底部显示统计信息（默认关闭，把空间留给正文）。",
    keywords: "状态栏 status bar 底部 统计",
  },
  {
    field: "statusWords",
    group: "状态栏",
    kind: "toggle",
    title: "状态栏：字数",
    desc: "英文按单词、中日韩按字计。",
    keywords: "状态栏 字数 words 统计",
    hiddenWhen: (s) => !s.showStatusBar,
  },
  {
    field: "statusChars",
    group: "状态栏",
    kind: "toggle",
    title: "状态栏：字符数",
    desc: "含空格与标点的字符总数。",
    keywords: "状态栏 字符数 chars 统计",
    hiddenWhen: (s) => !s.showStatusBar,
  },
  {
    field: "statusLines",
    group: "状态栏",
    kind: "toggle",
    title: "状态栏：行数",
    desc: "当前文档的总行数。",
    keywords: "状态栏 行数 lines 统计",
    hiddenWhen: (s) => !s.showStatusBar,
  },
  {
    field: "statusCursor",
    group: "状态栏",
    kind: "toggle",
    title: "状态栏：光标位置",
    desc: "光标所在的第几行第几列。",
    keywords: "状态栏 光标 位置 cursor 行列",
    hiddenWhen: (s) => !s.showStatusBar,
  },
  {
    field: "statusReadingTime",
    group: "状态栏",
    kind: "toggle",
    title: "状态栏：阅读时长",
    desc: "按下面的阅读速度估算还剩多少分钟。",
    keywords: "状态栏 阅读 时长 分钟 reading time",
    hiddenWhen: (s) => !s.showStatusBar,
  },
  {
    field: "statusMode",
    group: "状态栏",
    kind: "toggle",
    title: "状态栏：当前视图",
    desc: "标注当前是分栏 / 编辑 / 阅读。",
    keywords: "状态栏 视图 模式 mode",
    hiddenWhen: (s) => !s.showStatusBar,
  },
  {
    field: "statusReadingSpeed",
    group: "状态栏",
    kind: "number",
    title: "阅读速度",
    desc: "估算阅读时长用的速度（每分钟多少字）。",
    keywords: "阅读 速度 字数 每分钟 状态栏",
    min: 100,
    max: 1200,
    step: 50,
    unit: "字/分",
    hiddenWhen: (s) => !s.showStatusBar,
  },
];
