/**
 * 插件贡献的消费门面：业务侧统一从这里读取插件贡献，不再各自 import registry。
 *
 * 两种用法：
 * - React 组件用 usePluginContributions()：内部订阅注册表版本号，
 *   插件启停 / 重激活时自动重渲染；把 version 作为 useMemo 依赖即可得到稳定快照。
 * - 非 React 上下文（菜单配置构建、回调内）直接用 pluginContributions 静态门面：
 *   调用时机即读取时机，语义与直接调 registry 读取函数一致。
 *
 * 注册函数仍留在 registry，只由 host 调用——读取与写入的边界不变。
 */
import { useMemo, useSyncExternalStore } from "react";

import type { Note } from "@/interface/note/note";
import type { EditorToolbarContext, PluginHook } from "./types";
import * as registry from "./registry";

/** 贡献项类型统一从这里取，业务侧不必再 import registry */
export type {
  PluginAiPromptEntry,
  PluginAiProviderEntry,
  PluginAiToolEntry,
  PluginCommandEntry,
  PluginEditorToolbarEntry,
  PluginGroupMenuEntry,
  PluginGroupMenuGroup,
  PluginNoteMenuEntry,
  PluginNoteMenuGroup,
  PluginSettingsSectionEntry,
} from "./registry";

export interface PluginContributions {
  /** 注册表版本号：作为 useMemo 依赖，插件启停时变化 */
  version: number;
  noteMenuGroups(note: Note): registry.PluginNoteMenuGroup[];
  groupMenuGroups(): registry.PluginGroupMenuGroup[];
  commands(): registry.PluginCommandEntry[];
  editorToolbar(ctx: EditorToolbarContext): registry.PluginEditorToolbarEntry[];
  aiTools(): registry.PluginAiToolEntry[];
  aiPrompts(): registry.PluginAiPromptEntry[];
  aiProviders(): registry.PluginAiProviderEntry[];
  settingsSections(): registry.PluginSettingsSectionEntry[];
  emitHook(hook: PluginHook, payload: unknown): Promise<void>;
}

/** 读取函数的稳定引用集合：调用时才读，拿到的一定是最新贡献 */
export const pluginContributions: Omit<PluginContributions, "version"> = {
  noteMenuGroups: registry.getNoteMenuGroups,
  groupMenuGroups: registry.getGroupMenuGroups,
  commands: registry.getPluginCommands,
  editorToolbar: registry.getEditorToolbarItems,
  aiTools: registry.getAiTools,
  aiPrompts: registry.getAiPrompts,
  aiProviders: registry.getAiProviders,
  settingsSections: registry.getSettingsSections,
  emitHook: registry.emitPluginHook,
};

/** React 侧入口：订阅贡献版本，返回带 version 的读取门面 */
export const usePluginContributions = (): PluginContributions => {
  const version = useSyncExternalStore(registry.subscribeContributions, registry.getContributionsVersion);
  return useMemo(() => ({ version, ...pluginContributions }), [version]);
};
