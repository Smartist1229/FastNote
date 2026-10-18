/**
 * 解析后的深浅模式 + 当前生效的令牌：一个极小的外部 store，供需要按主题分支的组件订阅。
 *
 * 大多数组件不需要它——颜色全部走 CSS 变量，换主题是"变量变了"，组件不重渲染。
 * 只有拿不到 CSS 变量的地方才需要它：需要显式告知明暗的组件（Markdown 编辑器、
 * 代码高亮、原生 select 的配色），以及要把令牌换算成别处配色的地方（编辑器配色跟随主题）。
 *
 * 写入方：lib/theme.ts 的 applyTheme（唯一入口），因此订阅者不会读到一个过期的值。
 */
import { useSyncExternalStore } from "react";
import type { ResolvedThemeMode, ThemeTokens } from "@/interface/theme";
import { DEFAULT_LIGHT_TOKENS } from "@/config/themes";

let current: ResolvedThemeMode = "light";
/** 当前生效的令牌；applyTheme 还没跑过时用亮色默认令牌兜底 */
let currentTokens: ThemeTokens = DEFAULT_LIGHT_TOKENS;
const listeners = new Set<() => void>();

/** 读取当前模式（非 React 场景：初始化、事件回调里判断） */
export const getResolvedThemeMode = (): ResolvedThemeMode => current;

/** 订阅变化，返回取消订阅函数（useSyncExternalStore 的契约） */
export const subscribeResolvedThemeMode = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** 写入当前模式；只有真正变化时才通知订阅者 */
export const setResolvedThemeMode = (mode: ResolvedThemeMode): void => {
  if (current === mode) return;
  current = mode;
  notify();
};

/**
 * 写入当前生效的令牌（由 lib/theme.ts 在写 CSS 变量时同步调用）。
 * 与模式分开写：系统深浅色变化会换一套令牌，但模式本身可能没变。
 */
export const setActiveThemeTokens = (tokens: ThemeTokens): void => {
  if (currentTokens === tokens) return;
  currentTokens = tokens;
  notify();
};

/** 组件里读当前模式：深色时返回 "dark"，供需要显式分支的组件切换自带主题 */
export const useResolvedThemeMode = (): ResolvedThemeMode =>
  useSyncExternalStore(subscribeResolvedThemeMode, getResolvedThemeMode, getResolvedThemeMode);

/** 读当前令牌：把主题色换算成别处配色时用（如 Markdown 编辑器） */
export const getActiveThemeTokens = (): ThemeTokens => currentTokens;

/** 组件里订阅当前令牌；主题一改就重算派生的配色 */
export const useActiveThemeTokens = (): ThemeTokens =>
  useSyncExternalStore(subscribeResolvedThemeMode, getActiveThemeTokens, getActiveThemeTokens);
