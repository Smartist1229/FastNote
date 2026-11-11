import { useEffect, useRef } from "react";

/** 视为「用户还在用」的输入事件：任意一个就把空闲计时重新拉满 */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/** 检查间隔：误差不超过它，对「分钟级」的空闲阈值足够 */
const CHECK_INTERVAL_MS = 15_000;

interface IdleLockOptions {
  /** 空闲多少分钟后触发；0 或负数表示关闭 */
  minutes: number;
  onIdle: () => void;
  /** 返回 true 时本次不锁（如密码弹窗正开着），计时顺延 */
  shouldSkip?: () => boolean;
}

/**
 * 空闲自动锁定：只做计时，锁什么由调用方决定。
 *
 * 时间戳存在 ref 里而不是 state：鼠标移动每秒几十次，走 state 会让整个应用重渲染。
 * 触发后先把时间戳刷新，锁定失败也不会每 15 秒重试一次、反复弹提示。
 */
export function useIdleLock({ minutes, onIdle, shouldSkip }: IdleLockOptions): void {
  const lastActivityRef = useRef(Date.now());
  const onIdleRef = useRef(onIdle);
  const shouldSkipRef = useRef(shouldSkip);
  onIdleRef.current = onIdle;
  shouldSkipRef.current = shouldSkip;

  useEffect(() => {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    lastActivityRef.current = Date.now();
    const touch = () => {
      lastActivityRef.current = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, touch, { passive: true });
    }
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current < minutes * 60_000) return;
      touch();
      if (shouldSkipRef.current?.()) return;
      onIdleRef.current();
    }, CHECK_INTERVAL_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, touch);
      }
      window.clearInterval(timer);
    };
  }, [minutes]);
}
