/**
 * 撤销/重做栈。
 *
 * 为什么不用原生 textarea 的 undo：编辑器会通过工具栏、任务勾选、API 直接改文本，
 * 原生栈只认键盘输入，混用会出现"撤销后内容跳回几步前"的错乱。
 *
 * 合并策略：连续键入（间隔 < 600ms）只记录一次快照，撤销时整段回退，
 * 而不是一个字一个字地退——这是所有主流编辑器的默认手感。
 */
import { useCallback, useRef, useState } from "react";

export interface HistorySnapshot {
  text: string;
  caret: number;
}

const COALESCE_MS = 600;

export interface EditorHistory {
  /** 记录上一状态；coalesce=true 时按时间窗口合并连续输入 */
  record: (snapshot: HistorySnapshot, coalesce: boolean) => void;
  undo: (current: HistorySnapshot) => HistorySnapshot | null;
  redo: (current: HistorySnapshot) => HistorySnapshot | null;
  reset: (snapshot: HistorySnapshot) => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const useHistory = (limit: number): EditorHistory => {
  const past = useRef<HistorySnapshot[]>([]);
  const future = useRef<HistorySnapshot[]>([]);
  const lastRecord = useRef(0);
  // 栈内容在 ref 里，靠这个计数器触发 canUndo/canRedo 的重新渲染
  const [, bump] = useState(0);

  const record = useCallback(
    (snapshot: HistorySnapshot, coalesce: boolean) => {
      const now = Date.now();
      const shouldCoalesce = coalesce && now - lastRecord.current < COALESCE_MS && past.current.length > 0;
      lastRecord.current = now;
      future.current = [];
      if (shouldCoalesce) {
        // 同一段输入：保留第一次的"输入前状态"，不重复入栈
        bump((v) => v + 1);
        return;
      }
      past.current.push(snapshot);
      if (past.current.length > limit) past.current.shift();
      bump((v) => v + 1);
    },
    [limit],
  );

  const undo = useCallback((current: HistorySnapshot) => {
    const previous = past.current.pop();
    if (!previous) return null;
    future.current.push(current);
    lastRecord.current = 0;
    bump((v) => v + 1);
    return previous;
  }, []);

  const redo = useCallback((current: HistorySnapshot) => {
    const next = future.current.pop();
    if (!next) return null;
    past.current.push(current);
    lastRecord.current = 0;
    bump((v) => v + 1);
    return next;
  }, []);

  const reset = useCallback((_snapshot: HistorySnapshot) => {
    past.current = [];
    future.current = [];
    lastRecord.current = 0;
    bump((v) => v + 1);
  }, []);

  return {
    record,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
};
