/**
 * 编辑器设置 · 排版组。
 *
 * 数据表拆自 `editorSettingSpecs.ts`：一个分组一个文件，改某一组时不用在 1100 行里上下找；
 * 顺序由主文件的展开顺序决定，这里的元素顺序就是弹窗里的排列顺序。
 */
import type { EditorSettingSpec } from "../editorSettingSpecs";

export const TYPOGRAPHY_SPECS: EditorSettingSpec[] = [
  {
    field: "previewLineHeight",
    group: "排版",
    kind: "number",
    title: "预览行高",
    desc: "预览 / 阅读视图的正文行距倍数。",
    keywords: "行高 行距 line height 预览 排版",
    min: 1.2,
    max: 2.4,
    step: 0.05,
    unit: "倍",
  },
  {
    field: "paragraphSpacing",
    group: "排版",
    kind: "number",
    title: "段落间距",
    desc: "相邻段落之间的距离（相对字号）。",
    keywords: "段落 间距 排版 spacing paragraph",
    min: 0,
    max: 2,
    step: 0.1,
    unit: "em",
  },
  {
    field: "headingTopSpacing",
    group: "排版",
    kind: "number",
    title: "标题上方间距",
    desc: "标题与它上面一段之间的距离（相对字号）。",
    keywords: "标题 间距 上 排版 heading",
    min: 0,
    max: 3,
    step: 0.1,
    unit: "em",
  },
  {
    field: "headingBottomSpacing",
    group: "排版",
    kind: "number",
    title: "标题下方间距",
    desc: "标题与它下面一段之间的距离（相对字号）。",
    keywords: "标题 间距 下 排版 heading",
    min: 0,
    max: 3,
    step: 0.1,
    unit: "em",
  },
  {
    field: "previewMaxWidth",
    group: "排版",
    kind: "number",
    title: "正文最大宽度",
    desc: "预览内容的最大宽度，超出部分居中留白（宽屏下避免一行太长）。",
    keywords: "宽度 最大 正文 排版 max width",
    min: 480,
    max: 1600,
    step: 20,
    unit: "px",
  },
  {
    field: "textAlign",
    group: "排版",
    kind: "segment",
    title: "正文对齐",
    desc: "左对齐：右侧留参差；两端对齐：左右都对齐（中文长文更整齐）。",
    keywords: "对齐 左对齐 两端对齐 justify align 排版",
    options: [
      { value: "left", label: "左对齐" },
      { value: "justify", label: "两端对齐" },
      { value: "start", label: "按书写方向" },
    ],
  },
  {
    field: "headingWeight",
    group: "排版",
    kind: "number",
    title: "标题字重",
    desc: "预览里标题的粗细（400 常规 / 700 加粗）。",
    keywords: "标题 字重 粗细 weight bold 排版",
    min: 400,
    max: 900,
    step: 50,
  },
];
