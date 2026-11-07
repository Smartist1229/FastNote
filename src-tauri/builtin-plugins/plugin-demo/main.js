/**
 * 内置演示插件「插件演示」：把插件系统已实现的全部扩展点都跑一遍。
 *
 * 本插件同时是「多文件 ESM import」与「插件 i18n」的活示例：entry 只做编排，真正的实现拆在
 * modules/ 下，模块之间真实互相 import（menus / commands 共用 utils.js 的
 * enabledCapabilitiesText，modals 用 utils.js 的 fmtDuration，notes 用 sleep）。
 * 宿主通过 fastnote-plugin 自定义协议加载 entry，相对路径由浏览器原生解析；
 * 语言包由 manifest.i18n 声明，宿主在 activate 时注入 ctx.i18n（语言切换时自动重激活）。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 演示的扩展点（宿主已实现）
 * ═══════════════════════════════════════════════════════════════════
 *  ① 笔记右键菜单（多层 submenu + danger + when）       → modules/menus.js
 *  ② 分组右键菜单（多层 submenu）                        → modules/menus.js
 *  ③ 命令面板（信息 + 配置 toggle + 钩子订阅 toggle）    → modules/commands.js
 *  ④ 编辑器工具栏（4 图标 + 2 纯文字按钮 + 光标插入）    → modules/toolbar.js
 *  ⑤ 样式覆盖（body class + style.css）+ 呼吸光点        → modules/effects.js
 *  ⑥ Modal 全部扩展（模态/非模态/自定义内容/按钮）       → modules/modals.js
 *  ⑦ 生命周期钩子（note-create/save/delete/switch）      → modules/hooks.js
 *  ⑧ 写笔记 API（source_plugin 沙箱，创建/更新/删除/链路）→ modules/notes.js
 *  ⑨ AI 能力（tool + systemPrompt + provider + 设置读写） → modules/ai.js
 *  ⑩ 设置分区（settings.section，覆盖全部 18 个配置项）   → modules/settingsSection.js
 *  ⑪ 插件 i18n（locales/zh.json + locales/en.json）        → 所有模块的 ctx.i18n.t
 *  ⑫ 清理契约（ctx.onDispose，见 effects.js）
 *  ⑬ 自绘弹窗（插件自己拼 DOM，外观对齐历史版本对比）      → modules/sourceView.js
 *  ⑭ 插件私有表（ctx.db，只能碰 plugin_<目录名>__ 前缀）    → modules/storage.js / prefs.js
 *  ⑮ 插件窗口（ctx.window.open：宿主外壳 + 插件页面 iframe）  → modules/windows.js + window.html
 *  ⑯ 全局快捷键（ctx.shortcut.register，按下打开速记窗口）    → modules/shortcuts.js + modules/prefs.js
 *
 * ═══════════════════════════════════════════════════════════════════
 * 权限映射（plugin.json 的 permissions 声明）
 * ═══════════════════════════════════════════════════════════════════
 * | API                          | 权限              |
 * |------------------------------|-------------------|
 * | notes.getContent             | notes.read        |
 * | notes.create/update/remove   | notes.write       |
 * | editor.insertText            | editor.insert     |
 * | config.values/set            | config.read_write |
 * | ai.tool                      | ai.tool           |
 * | ai.systemPrompt              | ai.prompt         |
 * | ai.provider                  | ai.provider       |
 * | ai.getSettings/updateSettings| ai.settings       |
 * | settings.section             | settings.section  |
 * | menu / command / modal       | 默认开放          |
 *
 * 红线：贡献 id 一律 `plugin-demo.` 前缀；自造的 DOM / 定时器登记 onDispose；
 * 只操作本插件创建的笔记（source_plugin 沙箱）。
 */

import { applyEffects } from "./modules/effects.js";
import { registerMenus } from "./modules/menus.js";
import { registerCommands } from "./modules/commands.js";
import { registerModalDemos } from "./modules/modals.js";
import { registerToolbar } from "./modules/toolbar.js";
import { registerHooks } from "./modules/hooks.js";
import { registerNotes } from "./modules/notes.js";
import { registerAi } from "./modules/ai.js";
import { registerSettingsSection } from "./modules/settingsSection.js";
import { registerShortcuts } from "./modules/shortcuts.js";

export default {
  // activate 允许 async：宿主会 await 它，读表注册快捷键这类异步动作不会漏
  async activate(ctx) {
    const config = (ctx.config && ctx.config.values) || {};

    // ① 界面效果（主题 / 隐藏统计 / 呼吸光点）
    applyEffects(ctx, config);
    // ② 右键菜单（笔记 + 分组）
    registerMenus(ctx, config);
    // ③ 命令面板（信息 + 配置 toggle + 钩子订阅 toggle）
    registerCommands(ctx, config);
    // ④ Modal 演示（一个菜单项 + 四个命令）
    registerModalDemos(ctx, config);
    // ⑤ 编辑器工具栏（4 图标 + 2 纯文字）
    registerToolbar(ctx, config);
    // ⑥ 生命周期钩子
    registerHooks(ctx, config);
    // ⑦ 写笔记 API（创建 / 更新 / 删除 / 完整链路）
    registerNotes(ctx, config);
    // ⑧ AI 能力（tool + 提示词 + 服务商模板 + 设置读写）
    registerAi(ctx, config);
    // ⑨ 设置分区（覆盖全部配置项）
    registerSettingsSection(ctx, config);
    // ⑩ 全局快捷键：按下打开速记窗口；键位来自配置项，生效值记在插件私有表里
    await registerShortcuts(ctx, config);
  },
};
