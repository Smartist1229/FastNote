/**
 * 编辑器设置 · 大纲组。
 *
 * 数据表拆自 `editorSettingSpecs.ts`：一个分组一个文件，改某一组时不用在 1100 行里上下找；
 * 顺序由主文件的展开顺序决定，这里的元素顺序就是弹窗里的排列顺序。
 */
import type { EditorSettingSpec } from "../editorSettingSpecs";

export const OUTLINE_SPECS: EditorSettingSpec[] = [
  {
    field: "showOutline",
    group: "大纲",
    kind: "toggle",
    title: "默认展开大纲",
    desc: "打开笔记时就把大纲面板展开（工具栏上的大纲按钮随时可切换）。",
    keywords: "大纲 outline 目录 标题 展开",
  },
  {
    field: "outlinePosition",
    group: "大纲",
    kind: "segment",
    title: "大纲位置",
    desc: "大纲面板停靠在编辑区的左边还是右边。",
    keywords: "大纲 位置 左 右 outline position",
    options: [
      { value: "left", label: "左侧" },
      { value: "right", label: "右侧" },
    ],
    hiddenWhen: (s) => !s.showOutline,
  },
  {
    field: "outlineWidth",
    group: "大纲",
    kind: "number",
    title: "大纲宽度",
    desc: "大纲面板的宽度。",
    keywords: "大纲 宽度 outline width px",
    min: 140,
    max: 420,
    step: 10,
    unit: "px",
    hiddenWhen: (s) => !s.showOutline,
  },
  {
    field: "outlineMaxDepth",
    group: "大纲",
    kind: "number",
    title: "大纲层级深度",
    desc: "大纲最多列到第几级标题。",
    keywords: "大纲 层级 深度 标题 depth outline",
    min: 1,
    max: 6,
    hiddenWhen: (s) => !s.showOutline,
  },
  {
    field: "outlineIndent",
    group: "大纲",
    kind: "toggle",
    title: "大纲层级缩进",
    desc: "低级别标题在大纲里向右缩进。",
    keywords: "大纲 缩进 层级 outline indent",
    hiddenWhen: (s) => !s.showOutline,
  },
  {
    field: "outlineCaretTarget",
    group: "大纲",
    kind: "segment",
    title: "点击大纲后光标落点",
    desc: "行首：`###` 前面（顶格），改标题级别最顺手；文字前：跳过 `### ` 落在标题内容上，改文字最顺手。",
    keywords: "大纲 光标 落点 行首 标题 outline caret 跳转",
    options: [
      { value: "lineStart", label: "行首" },
      { value: "textStart", label: "文字前" },
    ],
    hiddenWhen: (s) => !s.showOutline,
  },
  {
    field: "outlineFlashTarget",
    group: "大纲",
    kind: "toggle",
    title: "跳转后高亮标题",
    desc: "点击大纲后短暂高亮目标标题，光标移开自动撤掉。",
    keywords: "大纲 跳转 高亮 标题 闪烁 flash outline jump",
    hiddenWhen: (s) => !s.showOutline,
  },
];
