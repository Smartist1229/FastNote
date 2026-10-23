/**
 * 编辑器默认键位的**单一事实源**（纯数据，不引 React，可以被软件层安全地静态导入）。
 *
 * 两个消费方：
 * - `components/MarkdownEditor.tsx` 用它建快捷键映射表；
 * - 软件层 `config/shortcuts.ts` 用同一张表 + 下面的中文名生成「设置 → 快捷键」清单。
 *
 * 分成单独文件的原因：组件入口 `index.ts` 会把整个编辑器（含 React、KaTeX 懒加载）
 * 拖进主包，而设置面板只需要一张表——表放这里，两个包各取所需。
 *
 * 键名是 `KeyboardEvent.code` 归一化后的结果（见 MarkdownEditor 的 `acceleratorOf`）：
 * `mod` = Windows / Linux 的 Ctrl、macOS 的 ⌘。
 */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "mod+b": "bold",
  "mod+i": "italic",
  "mod+shift+x": "strike",
  "mod+e": "inlineCode",
  "mod+shift+e": "codeBlock",
  "mod+k": "link",
  "mod+shift+k": "image",
  "mod+shift+.": "quote",
  "mod+shift+7": "orderedList",
  "mod+shift+8": "bulletList",
  "mod+shift+9": "taskList",
  "mod+shift+m": "math",
  "mod+shift+f": "footnote",
  "mod+alt+1": "heading1",
  "mod+alt+2": "heading2",
  "mod+alt+3": "heading3",
  "mod+alt+4": "heading4",
  "mod+alt+5": "heading5",
  "mod+alt+6": "heading6",
  "mod+alt+0": "heading0",
};

/**
 * 格式类动作的展示顺序与中文名。
 * 顺序就是快捷键说明表里的顺序（先常用行内格式，再块级，最后标题级别），
 * 文案与工具栏保持一致，避免同一动作在两处叫不同名字。
 */
export const FORMAT_ACTIONS: ReadonlyArray<{ action: string; label: string }> = [
  { action: "bold", label: "加粗" },
  { action: "italic", label: "斜体" },
  { action: "strike", label: "删除线" },
  { action: "inlineCode", label: "行内代码" },
  { action: "codeBlock", label: "代码块" },
  { action: "link", label: "插入链接" },
  { action: "image", label: "插入图片" },
  { action: "quote", label: "引用" },
  { action: "orderedList", label: "有序列表" },
  { action: "bulletList", label: "无序列表" },
  { action: "taskList", label: "任务列表" },
  { action: "math", label: "行内公式" },
  { action: "footnote", label: "脚注" },
  { action: "heading1", label: "一级标题" },
  { action: "heading2", label: "二级标题" },
  { action: "heading3", label: "三级标题" },
  { action: "heading4", label: "四级标题" },
  { action: "heading5", label: "五级标题" },
  { action: "heading6", label: "六级标题" },
  { action: "heading0", label: "转为正文" },
];

/** 动作 → 键位（个别动作可绑多个键，如「重做」的 shift+z 与 y） */
export const SHORTCUTS_BY_ACTION: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [key, action] of Object.entries(DEFAULT_SHORTCUTS)) {
    (out[action] ??= []).push(key);
  }
  return out;
})();
