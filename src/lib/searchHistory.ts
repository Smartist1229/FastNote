/**
 * 侧边栏搜索历史（只存最近用过的查询词）。
 *
 * 与最近打开文件同理，键名不带 `app.config.` 前缀：搜索历史是个人痕迹，
 * 「重置设置」清的是外观与编辑器配置，不该把用户的检索习惯一起抹掉。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { getAppSettings, setAppSetting } from "@/api/settings";

const STORAGE_KEY = "recent.searchQueries";
const MAX_ITEMS = 10;

export const useSearchHistory = () => {
  const [history, setHistory] = useState<string[]>([]);
  const listRef = useRef<string[]>([]);
  useEffect(() => {
    listRef.current = history;
  }, [history]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await getAppSettings();
        const raw = rows[STORAGE_KEY];
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        const list = Array.isArray(parsed)
          ? parsed.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0)
          : [];
        if (alive) setHistory(list.slice(0, MAX_ITEMS));
      } catch (e) {
        console.error("读取搜索历史失败：", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback((list: string[]) => {
    listRef.current = list;
    setHistory(list);
    void setAppSetting(STORAGE_KEY, JSON.stringify(list)).catch((e) =>
      console.error("保存搜索历史失败：", e),
    );
  }, []);

  /**
   * 记一个查询词：已存在则提到最前（这里首项 = 最近用过）。
   * 只记真正执行过的搜索（长度 ≥ 1），空串不计。
   */
  const pushSearchQuery = useCallback(
    (query: string) => {
      const q = query.trim();
      if (!q) return;
      const next = [q, ...listRef.current.filter((x) => x !== q)].slice(0, MAX_ITEMS);
      persist(next);
    },
    [persist],
  );

  const removeSearchQuery = useCallback(
    (query: string) => {
      persist(listRef.current.filter((x) => x !== query));
    },
    [persist],
  );

  const clearSearchHistory = useCallback(() => persist([]), [persist]);

  return { searchHistory: history, pushSearchQuery, removeSearchQuery, clearSearchHistory };
};
