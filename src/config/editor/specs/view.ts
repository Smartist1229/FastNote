/**
 * 编辑器设置 · 视图组。
 *
 * 数据表拆自 `editorSettingSpecs.ts`：一个分组一个文件，改某一组时不用在 1100 行里上下找；
 * 顺序由主文件的展开顺序决定，这里的元素顺序就是弹窗里的排列顺序。
 */
import type { EditorSettingSpec } from "../editorSettingSpecs";

export const VIEW_SPECS: EditorSettingSpec[] = [
  {
    field: "defaultMode",
    group: "视图",
    kind: "segment",
    title: "默认视图",
    desc: "打开笔记时默认用哪种视图：分栏（左编辑右预览）、编辑（只写 Markdown）、阅读（只看排版）。",
    keywords: "视图 模式 分栏 编辑 阅读 split code read 默认",
    options: [
      { value: "split", label: "分栏" },
      { value: "code", label: "编辑" },
      { value: "read", label: "阅读" },
    ],
  },
  {
    field: "showModeSwitch",
    group: "视图",
    kind: "toggle",
    title: "工具栏显示视图切换",
    desc: "关闭后工具栏右侧不再出现「分栏 / 编辑 / 阅读」切换，视图固定为上面的默认视图。",
    keywords: "视图切换 模式切换 分栏 编辑 阅读 toolbar mode",
    hiddenWhen: (s) => !s.showToolbar,
  },
  {
    field: "splitRatio",
    group: "视图",
    kind: "number",
    title: "分栏时编辑区占比",
    desc: "分栏视图下左边编辑区占多少宽度，0.5 即左右各一半。",
    keywords: "分栏 比例 宽度 布局 ratio split",
    min: 0.2,
    max: 0.8,
    step: 0.05,
  },
  {
    field: "splitResizable",
    group: "视图",
    kind: "toggle",
    title: "分栏分隔条可拖动",
    desc: "允许拖动中间的分隔条临时改变左右比例（只影响当前会话）。",
    keywords: "分隔条 拖动 分栏 resizable divider",
  },
  {
    field: "syncScroll",
    group: "视图",
    kind: "toggle",
    title: "分栏同步滚动",
    desc: "分栏视图下滚动一侧时另一侧跟着滚动。",
    keywords: "同步滚动 sync scroll 分栏",
  },
  {
    field: "syncScrollMode",
    group: "视图",
    kind: "segment",
    title: "同步滚动方式",
    desc: "锚点：按编辑行位置对齐，正文对得更准；比例：按滚动百分比对齐，长文档更顺滑。",
    keywords: "同步滚动 锚点 比例 anchor ratio 分栏",
    options: [
      { value: "anchor", label: "行锚点" },
      { value: "ratio", label: "按比例" },
    ],
    hiddenWhen: (s) => !s.syncScroll,
  },
];
