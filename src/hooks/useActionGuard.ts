import { useCallback, useRef } from "react";

/**
 * 按钮动作守卫：同一时刻只执行一个动作，动作结束后的冷却期内也忽略新触发。
 *
 * 只靠 `disabled` 不够：两次点击事件可能在同一次 React 渲染前连续到达，
 * 第一次 setState 还没生效，第二次照样会进入处理函数。
 * 冷却期是给「动作很快返回、状态还没刷新」的按钮兜底（如重建索引、取消下载）。
 */
export function useActionGuard(cooldownMs = 400): (action: () => unknown) => Promise<void> {
  const busyRef = useRef(false);
  const lastRunRef = useRef(0);

  return useCallback(
    async (action: () => unknown) => {
      const now = performance.now();
      if (busyRef.current || now - lastRunRef.current < cooldownMs) return;
      busyRef.current = true;
      try {
        await action();
      } catch (error) {
        // 调用方通常自行 toast；这里兜底，避免 void 调用产生未处理的 rejection
        console.error("按钮动作执行失败:", error);
      } finally {
        lastRunRef.current = performance.now();
        busyRef.current = false;
      }
    },
    [cooldownMs],
  );
}
