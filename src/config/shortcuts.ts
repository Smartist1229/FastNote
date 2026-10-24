/**
 * 「设置 → 快捷键」的数据源：全软件键位的**唯一清单**。
 *
 * 编辑器的格式类键位不从文档里抄，而是直接读 `markdown-editor/shortcuts.ts` 那张表
 * （组件自己也是从那里建映射的）——否则改键位时必然出现"说明里写着 Ctrl+K、实际按了没反应"。
 * 应用层的键位在 `App.tsx` 里注册，这里的文案与那边一一对应。
 *
 * `available` 用来表达"某一项设置关掉后这条键位不存在"：面板据此把行置灰并给出原因，
 * 而不是让用户对着一条按不出反应的说明发愁。
 */
import type { AppSettings } from "@/interface/settings";
import { FORMAT_ACTIONS, SHORTCUTS_BY_ACTION } from "@/markdown-editor/shortcuts";

export interface ShortcutEntry {
  /** 归一化键位：`mod+shift+p`；`/` 分隔表示多个等价键；`mod+滚轮` 这类非按键也照此写 */
  keys: string;
  label: string;
  /** 补充说明（生效前提、易混点） */
  note?: string;
  /** 缺省表示始终生效 */
  available?: (settings: AppSettings) => boolean;
  /** 不可用时的原因，显示在行尾 */
  offHint?: string;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  /** 组说明，只在组标题下显示一行 */
  desc?: string;
  entries: ShortcutEntry[];
}

/** 编辑器快捷键总开关关掉后，所有编辑器内键位都不存在 */
const editorShortcutsOn = (settings: AppSettings) => settings.editor.shortcuts;
const EDITOR_OFF = "编辑器快捷键已关闭";

/** 格式类键位：顺序与文案来自编辑器包，键位反查 `SHORTCUTS_BY_ACTION` */
const formatEntries: ShortcutEntry[] = FORMAT_ACTIONS.flatMap(({ action, label }) => {
  const keys = SHORTCUTS_BY_ACTION[action];
  if (!keys || !keys.length) return [];
  return [{ keys: keys.join(" / "), label, available: editorShortcutsOn, offHint: EDITOR_OFF }];
});

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: "app",
    title: "应用",
    desc: "任何位置都生效（输入框里打字时除外）",
    entries: [
      { keys: "mod+p", label: "快速跳转", note: "按标题与正文搜索笔记" },
      { keys: "mod+shift+p", label: "命令面板", note: "新建、排序、主题、设置…" },
      { keys: "mod+s", label: "保存 / 导出当前笔记", note: "编辑电脑上的文件时直接写回原文件" },
      { keys: "escape", label: "关闭面板", note: "命令面板、查找框、全屏依次退出" },
    ],
  },
  {
    id: "editor-format",
    title: "编辑器 · 格式",
    desc: "焦点在正文里时生效",
    entries: formatEntries,
  },
  {
    id: "editor-edit",
    title: "编辑器 · 编辑",
    entries: [
      { keys: "mod+z", label: "撤销", available: editorShortcutsOn, offHint: EDITOR_OFF },
      { keys: "mod+shift+z / mod+y", label: "重做", available: editorShortcutsOn, offHint: EDITOR_OFF },
      { keys: "tab / shift+tab", label: "缩进 / 反缩进", note: "选中多行时整块缩进", available: editorShortcutsOn, offHint: EDITOR_OFF },
    ],
  },
  {
    id: "editor-search",
    title: "编辑器 · 查找替换",
    entries: [
      { keys: "mod+f", label: "打开查找", available: (s) => s.editor.searchEnabled, offHint: "查找已关闭" },
      { keys: "mod+h", label: "打开查找并展开替换", available: (s) => s.editor.searchEnabled, offHint: "查找已关闭" },
      { keys: "mod+g / mod+shift+g", label: "下一个 / 上一个命中", note: "查找框已打开时生效", available: (s) => s.editor.searchEnabled, offHint: "查找已关闭" },
      { keys: "f3 / shift+f3", label: "下一个 / 上一个命中", available: (s) => s.editor.searchEnabled, offHint: "查找已关闭" },
      { keys: "enter / shift+enter", label: "查找框内：下一个 / 上一个", available: (s) => s.editor.searchEnabled, offHint: "查找已关闭" },
      { keys: "ctrl+alt+enter", label: "查找框内：全部替换", available: (s) => s.editor.searchEnabled, offHint: "查找已关闭" },
    ],
  },
  {
    id: "editor-view",
    title: "编辑器 · 视图与缩放",
    entries: [
      { keys: "mod+alt+enter", label: "全屏 / 退出全屏", available: editorShortcutsOn, offHint: EDITOR_OFF },
      { keys: "mod+=", label: "放大字号", available: (s) => s.editor.ctrlScrollZoom, offHint: "字号缩放已关闭" },
      { keys: "mod+-", label: "缩小字号", available: (s) => s.editor.ctrlScrollZoom, offHint: "字号缩放已关闭" },
      { keys: "mod+0", label: "恢复默认字号", available: (s) => s.editor.ctrlScrollZoom, offHint: "字号缩放已关闭" },
      { keys: "mod+滚轮", label: "滚动缩放字号", note: "指针要在编辑区里", available: (s) => s.editor.ctrlScrollZoom, offHint: "字号缩放已关闭" },
      { keys: "escape", label: "退出全屏 / 关闭查找框", available: editorShortcutsOn, offHint: EDITOR_OFF },
    ],
  },
];
