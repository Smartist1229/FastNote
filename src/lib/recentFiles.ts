/**
 * 最近打开的「电脑文件」列表（只记路径，不落库为笔记）。
 *
 * 存在 app_settings 表里，键名刻意**不带 `app.config.` 前缀**：
 * 那个前缀会被「重置设置」整体清掉（见 stores/appSettingsStore 的 PREFIX），
 * 而最近打开文件是用户的浏览痕迹，重置外观/编辑器设置不该把它一起抹了。
 *
 * 列表按打开时间倒序、上限 20 条；同一路径重复打开会被提到最前面而不是插入两条。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { getAppSettings, setAppSetting } from "@/api/settings";

const STORAGE_KEY = "recent.externalFiles";
const MAX_ITEMS = 20;

export interface RecentFile {
  /** 文件绝对路径，也是列表去重与「点击加载」的唯一依据 */
  path: string;
  /** 文件名（`readme.md`），展示用的短名字 */
  name: string;
  /** 最近一次打开的 RFC3339 时间 */
  openedAt: string;
}

/** 从任意对象里尽力取出合法的一条；脏数据返回 null（不因一条坏数据让整个列表不可用） */
const normalize = (raw: unknown): RecentFile | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const path = typeof row.path === "string" ? row.path.trim() : "";
  if (!path) return null;
  const fallbackName = path.replace(/\\/g, "/").split("/").pop() || path;
  const rawName = typeof row.name === "string" ? row.name.trim() : "";
  return {
    path,
    name: rawName || fallbackName,
    openedAt: typeof row.openedAt === "string" ? row.openedAt : new Date().toISOString(),
  };
};

const sortByRecency = (list: RecentFile[]): RecentFile[] =>
  [...list].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));

export const useRecentFiles = () => {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  /** 写库的简易互斥：连点打开文件时的两次 push 不能互相覆盖 */
  const writingRef = useRef(false);
  /** 最新列表的镜像：pushRecentFile 用它做去重，不必等 state 落回来 */
  const listRef = useRef<RecentFile[]>([]);
  useEffect(() => {
    listRef.current = recentFiles;
  }, [recentFiles]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await getAppSettings();
        const raw = rows[STORAGE_KEY];
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        const list = Array.isArray(parsed)
          ? (parsed.map(normalize).filter((x): x is RecentFile => x !== null))
          : [];
        if (alive) setRecentFiles(sortByRecency(list).slice(0, MAX_ITEMS));
      } catch (e) {
        // 解析失败（手改过库/老格式）当作没有历史，不打断启动
        console.error("读取最近打开文件失败：", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 记一次打开。
   *
   * 这里**不去 stat 磁盘**校验文件还在不在：列表可能很长，每次打开都打一遍盘没必要；
   * 真点开了才由 openExternalFile 读内容，失败时 toast 并让用户手动移除这一条。
   */
  const pushRecentFile = useCallback((path: string, name: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    const now = new Date().toISOString();
    const entry: RecentFile = { path: cleanPath, name: name.trim() || cleanPath, openedAt: now };
    const next = sortByRecency([
      entry,
      ...listRef.current.filter((x) => x.path !== cleanPath),
    ]).slice(0, MAX_ITEMS);
    listRef.current = next;
    setRecentFiles(next);
    void (async () => {
      if (writingRef.current) return;
      writingRef.current = true;
      try {
        await setAppSetting(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error("保存最近打开文件失败：", e);
      } finally {
        writingRef.current = false;
      }
    })();
  }, []);

  /** 单条移除（文件已不存在时让用户自己划掉） */
  const removeRecentFile = useCallback((path: string) => {
    const next = listRef.current.filter((x) => x.path !== path);
    listRef.current = next;
    setRecentFiles(next);
    void (async () => {
      try {
        await setAppSetting(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error("移除最近打开文件失败：", e);
      }
    })();
  }, []);

  /** 清空全部 */
  const clearRecentFiles = useCallback(() => {
    listRef.current = [];
    setRecentFiles([]);
    void setAppSetting(STORAGE_KEY, "[]").catch((e) => console.error("清空最近打开文件失败：", e));
  }, []);

  return { recentFiles, pushRecentFile, removeRecentFile, clearRecentFiles };
};
