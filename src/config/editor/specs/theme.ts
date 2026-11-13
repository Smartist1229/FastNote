/**
 * 编辑器设置 · 主题与其他组。
 *
 * 数据表拆自 `editorSettingSpecs.ts`：一个分组一个文件，改某一组时不用在 1100 行里上下找；
 * 顺序由主文件的展开顺序决定，这里的元素顺序就是弹窗里的排列顺序。
 */
import type { EditorSettingSpec } from "../editorSettingSpecs";

export const THEME_SPECS: EditorSettingSpec[] = [
  {
    field: "codeTheme",
    group: "主题与其他",
    kind: "select",
    title: "代码块配色",
    desc: "代码块（含 AI 回复）的高亮配色；选「主题」时跟随当前软件主题变化。",
    keywords: "代码块 配色 主题 高亮 code theme 预设 跟随",
    // swatch 取各预设的底色 + 三个 token 色，让「按外观挑」不用逐一点开试；
    // 「主题」没有固定色值，用当前主题的主色渐变表示「跟着软件主题走」
    options: [
      {
        value: "follow",
        label: "主题",
        swatch: [
          "linear-gradient(135deg, rgb(var(--c-primary-400)), rgb(var(--c-primary-600)))",
          "rgb(var(--c-primary-50))",
          "rgb(var(--c-primary-100))",
          "rgb(var(--c-primary-200))",
        ],
      },
      { value: "github", label: "GitHub", swatch: ["#f6f8fa", "#cf222e", "#0a3069", "#8250df"] },
      { value: "atom", label: "Atom", swatch: ["#282c34", "#c678dd", "#98c379", "#61afef"] },
      { value: "nord", label: "Nord", swatch: ["#2e3440", "#81a1c1", "#a3be8c", "#88c0d0"] },
      { value: "solarized", label: "Solarized", swatch: ["#fdf6e3", "#859900", "#2aa198", "#268bd2"] },
      { value: "monokai", label: "Monokai", swatch: ["#272822", "#f92672", "#e6db74", "#a6e22e"] },
      { value: "plain", label: "无色", swatch: ["rgb(var(--c-surface))", "rgb(var(--c-faint))", "rgb(var(--c-faint-soft))", "rgb(var(--c-faint))"] },
    ],
  },
  {
    field: "shortcuts",
    group: "主题与其他",
    kind: "toggle",
    title: "启用快捷键",
    desc: "加粗、斜体、查找等编辑器快捷键；关闭后只保留系统输入法的按键。",
    keywords: "快捷键 shortcut 键盘 关闭",
  },
  {
    field: "radius",
    group: "主题与其他",
    kind: "number",
    min: 0,
    max: 24,
    step: 1,
    unit: "px",
    title: "编辑器圆角",
    desc: "编辑区与预览区外框的圆角。设为 0 时四角为直角；这也是分栏/阅读视图外层容器的圆角来源。",
    keywords: "圆角 半径 radius 弧度 直角 corners",
  },
  {
    field: "keepFocusOnHostClick",
    group: "主题与其他",
    kind: "toggle",
    title: "点击宿主 UI 时保持编辑器焦点",
    desc: "点击工具栏、侧边栏或插件按钮时保持编辑器光标不丢，插件插入文本不失败。",
    keywords: "保持焦点 失焦 blur focus 宿主 插件 toolbar 点击",
  },
];
