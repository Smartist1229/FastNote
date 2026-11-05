/**
 * 跨 feature 事件总线。
 *
 * 模块之间只通过这里通信，不直接 import 对方的状态：
 * - 事件名与 payload 统一在 `AppEventMap` 中声明，新增事件先补类型再使用；
 * - 发送用 `emitAppEvent`，订阅用 `onAppEvent`（返回取消订阅函数，可直接作为 effect 的清理逻辑）。
 *
 * 说明：底层仍是 window 上的 CustomEvent，保持与既有行为完全一致（无 payload 时派发普通 Event）。
 */
export interface AppEventMap {
  /** 笔记/分组数据发生变化，列表需要重新拉取 */
  "fastnote-data-changed": void;
  /** AI 工具要求切换当前打开的真实笔记 */
  "fastnote-select-note": { noteId: string };
  /** AI 服务商列表发生增删改，需要重新拉取 */
  "fastnote-providers-changed": void;
  /** 在设置里切换了当前服务商 */
  "fastnote-provider-selected": { providerId: number };
}

export type AppEventName = keyof AppEventMap;

/** 派发事件：有 payload 时用 CustomEvent，无 payload 时用普通 Event */
export const emitAppEvent = <K extends AppEventName>(
  name: K,
  ...args: AppEventMap[K] extends void ? [] : [payload: AppEventMap[K]]
): void => {
  const payload = args[0];
  window.dispatchEvent(payload === undefined ? new Event(name) : new CustomEvent(name, { detail: payload }));
};

/** 订阅事件：返回取消订阅函数 */
export const onAppEvent = <K extends AppEventName>(
  name: K,
  handler: (payload: AppEventMap[K]) => void,
): (() => void) => {
  const listener = (event: Event) => handler((event as CustomEvent<AppEventMap[K]>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
};
