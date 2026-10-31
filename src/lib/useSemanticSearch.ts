/**
 * 语义搜索 hook：防抖 + 过期响应丢弃 + 按当前笔记列表兜底过滤。
 *
 * 三条约束（搜索框逐字符变化，任何一条做错都会让界面闪或报错）：
 * - **不阻塞关键词搜索**：语义结果独立异步返回，调用方先渲染关键词命中；
 * - **过期响应直接丢**：每次请求递增 id，慢请求回来时若 id 已过期就不 setState；
 * - **失败只 console.error**：模型未下载 / 索引为空都是正常状态，不该弹 toast 打断输入。
 */
import { useEffect, useRef, useState } from 'react';

import * as semanticApi from '@/api/semantic';
import type { Note } from '@/interface/note';
import type { SemanticHit } from '@/interface/semantic';

const DEBOUNCE_MS = 250;

export function useSemanticSearch(
  query: string,
  enabled: boolean,
  notes: Note[],
): { hits: SemanticHit[]; loading: boolean } {
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  // 用 ref 持有最新列表：列表变化不应触发重新查询，但结果回来时要能过滤掉已删除的笔记
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const trimmed = query.trim();

  useEffect(() => {
    if (!enabled || !trimmed) {
      requestIdRef.current += 1;
      setHits([]);
      setLoading(false);
      return;
    }

    // 换词立即让旧请求失效，但保留已显示的结果直到新结果回来，避免每敲一个字就闪一下
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      semanticApi
        .semanticSearch(trimmed)
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          const known = new Set(notesRef.current.map((note) => note.id));
          setHits(result.filter((hit) => known.has(hit.note_id)));
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          console.error('语义搜索失败：', error);
          setHits([]);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      // 换词 / 卸载后迟到的响应一律丢弃
      requestIdRef.current += 1;
    };
  }, [trimmed, enabled]);

  return { hits, loading };
}
