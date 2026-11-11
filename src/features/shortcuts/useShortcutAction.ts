/**
 * 把一个动作的处理函数挂到快捷键运行时上。
 *
 * `handler` 每次渲染都会变（闭包着当次的状态），所以只用 ref 更新，注册本身只做一次——
 * 否则每次输入都会重新注册，键位按下时反而可能命中上一帧的闭包。
 */
import { useEffect, useRef } from "react";
import { registerShortcutHandler } from "./runtime";

export function useShortcutAction(
  actionId: string,
  handler: (payload?: unknown) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(
    () => registerShortcutHandler(actionId, (payload) => handlerRef.current(payload)),
    [actionId],
  );
}
