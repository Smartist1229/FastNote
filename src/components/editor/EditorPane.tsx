/**
 * 一个标签对应的编辑面板（笔记 / 电脑文件 / AI 预览 / 历史版本）。
 *
 * 每个标签一个 NoteEditor 实例，**首次激活后才挂载**，之后一直保留：
 * 切回来时滚动位置、撤销历史、视图模式、光标都还在原来那篇上，不会像单实例换内容那样被重置。
 * 未激活的标签只是 `visibility: hidden`（不是 display:none）——隐藏时仍有真实尺寸，
 * 自研编辑器的行虚拟化在重新显示时不必重新测量，也不会因为高度为 0 算错可视区间。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import type { Category, NoteHistoryEntry } from "@/interface/note/note";
import type { EditorSettings } from "@/interface/settings/settings";
import type { NoteEditorActions } from "@/interface/note/editor";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { useI18n } from "@/i18n";
import { registerTabEditor } from "@/features/tabs/activeEditor";
import { tabToNote, type EditorTab } from "@/features/tabs/types";

/** 历史版本时间：按界面语言显示本地时间到分钟；非法值原样返回 */
const formatHistoryTime = (iso: string, locale: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export interface EditorPaneProps {
  tab: EditorTab;
  isActive: boolean;
  categories: Category[];
  editorSettings: EditorSettings;
  shortcutBindings: Record<string, string>;
  enableAI: boolean;
  isAiPanelOpen: boolean;
  onToggleAiPanel?: () => void;
  onSaveNote: (id: string, title: string, content: string, categoryId: string | null) => Promise<void>;
  /** 光标偏移上报：只上报激活标签的，AI 插入文本用它定位 */
  onCursorOffsetChange: (offset: number) => void;
  /** AI 预览「保存到分组」：成功后关闭这个预览标签 */
  onSavePreviewToCategory: (categoryId: string | null, title: string, content: string) => Promise<void>;
  /** 电脑文件写回磁盘（按标签自己的路径，不依赖全局当前文件） */
  onWriteExternal: (path: string, content: string) => Promise<void>;
  /** 电脑文件另存为笔记：成功后关闭这个文件标签 */
  onSaveExternalToNote: (categoryId: string | null, title: string, content: string) => Promise<void>;
  /** 历史版本回滚：返回 true 表示成功，随后关闭预览标签 */
  onRollbackHistory: (entry: NoteHistoryEntry) => Promise<boolean>;
  /** 关闭本标签（标题栏的关闭按钮、预览退出） */
  onCloseTab: () => void;
}

export const EditorPane: React.FC<EditorPaneProps> = ({
  tab,
  isActive,
  categories,
  editorSettings,
  shortcutBindings,
  enableAI,
  isAiPanelOpen,
  onToggleAiPanel,
  onSaveNote,
  onCursorOffsetChange,
  onSavePreviewToCategory,
  onWriteExternal,
  onSaveExternalToNote,
  onRollbackHistory,
  onCloseTab,
}) => {
  const { locale } = useI18n();
  /**
   * 首次激活后才挂载编辑器：开十个标签不等于十个实例，
   * 只有真正看过的才有编辑器，内存随「用过的标签数」增长而不是「标签数」。
   */
  const [mounted, setMounted] = useState(isActive);
  useEffect(() => {
    if (isActive) setMounted(true);
  }, [isActive]);

  /** 光标上报只认激活标签：隐藏实例的偏移会把 AI 插入位置带偏 */
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const handleCursorOffset = useCallback(
    (offset: number) => {
      if (isActiveRef.current) onCursorOffsetChange(offset);
    },
    [onCursorOffsetChange],
  );

  /** 注册回调按标签 key 分桶：多实例共享一个 ref 时会互相顶掉 */
  const tabKey = tab.key;
  const registerActions = useCallback(
    (actions: NoteEditorActions | null) => registerTabEditor(tabKey, "actions", actions),
    [tabKey],
  );
  const registerExport = useCallback(
    (fn: (() => void) | null) => registerTabEditor(tabKey, "exportNote", fn),
    [tabKey],
  );
  const registerFlush = useCallback(
    (fn: (() => void) | null) => registerTabEditor(tabKey, "flush", fn),
    [tabKey],
  );

  if (!mounted) return null;

  const historyProps =
    tab.kind === "history"
      ? {
          historyPreview: {
            savedAt: formatHistoryTime(tab.entry.saved_at, locale),
            onRollback: () => {
              void onRollbackHistory(tab.entry).then((ok) => {
                if (ok) onCloseTab();
              });
            },
            onExit: onCloseTab,
          },
        }
      : {};

  return (
    <div
      // 多标签下所有看过的面板都在 DOM 里（隐藏的只是 visibility），插件按选择器挂载时
      // 需要能认出「当前激活的是哪个」——ctx.ui.mount 会优先选 [data-active="true"] 里的那个。
      data-editor-pane="true"
      data-active={isActive ? "true" : undefined}
      className="absolute inset-0 min-h-0"
      style={{ visibility: isActive ? "visible" : "hidden" }}
      aria-hidden={isActive ? undefined : true}
    >
      <NoteEditor
        note={tabToNote(tab)}
        editable={tab.kind !== "history"}
        {...historyProps}
        isActive={isActive}
        isTemporary={tab.kind === "temp"}
        onCloseTemporary={onCloseTab}
        categories={categories}
        onSaveToCategory={async (categoryId, title, content) => {
          await onSavePreviewToCategory(categoryId, title, content);
          onCloseTab();
        }}
        externalFilePath={tab.kind === "external" ? tab.file.path : null}
        onSaveExternal={
          tab.kind === "external" ? (content) => onWriteExternal(tab.file.path, content) : undefined
        }
        onSaveExternalToNote={async (categoryId, title, content) => {
          await onSaveExternalToNote(categoryId, title, content);
          onCloseTab();
        }}
        onCloseExternal={onCloseTab}
        onSave={onSaveNote}
        onCursorOffsetChange={handleCursorOffset}
        editorSettings={editorSettings}
        shortcutBindings={shortcutBindings}
        onToggleAiPanel={onToggleAiPanel}
        isAiPanelOpen={isAiPanelOpen}
        onRegisterExport={registerExport}
        onRegisterFlushExternal={registerFlush}
        onRegisterActions={registerActions}
        enableAI={enableAI}
      />
    </div>
  );
};
