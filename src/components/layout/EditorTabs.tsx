/**
 * 编辑区标签栏：横向排列、可滚动、可关闭。
 *
 * 三类交互刻意区分开：
 * - 单击标签 → 激活（不重建编辑器，滚动位置与撤销历史都在各自实例里）；
 * - 中键 / 点 × → 关闭（关闭时若有关联的加密态或外部文件写回，由标签域统一处理）；
 * - 滚轮 → 横向滚动（标签开得多时不必去拖那条细滚动条）。
 *
 * 图标按标签类型区分：笔记 / 电脑文件 / AI 预览 / 历史版本，靠形状就能分清来源。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { Icon } from "@/components/common/Icon";
import { ContextMenu, useContextMenu } from "@/components/common/ContextMenu";
import { buildTabMenu } from "@/config/app/contextMenus";
import { useI18n } from "@/i18n";
import type { EditorTab, EditorTabKind } from "@/features/tabs/types";

/** 标签类型 → 图标名（src/assets/icons 下的文件名） */
const KIND_ICON: Record<EditorTabKind, string> = {
  note: "sidebar-note",
  external: "ai-file-text",
  temp: "ai-sparkles",
  history: "sidebar-clock",
};

export interface EditorTabsProps {
  tabs: EditorTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** 右键菜单：关掉除它以外的全部 */
  onCloseOthers: (key: string) => void;
  /** 右键菜单：关掉它左侧的全部 */
  onCloseLeft: (key: string) => void;
  /** 右键菜单：关掉它右侧的全部 */
  onCloseRight: (key: string) => void;
  /** 右键菜单：全部关闭 */
  onCloseAll: () => void;
  /** 拖拽排序：把 fromKey 挪到 toKey 的位置 */
  onMoveTab: (fromKey: string, toKey: string) => void;
}

/** 标签上显示的文字：笔记没标题时用「无标题」，其余类型共用自己的标题字段 */
const useTabTitle = (): ((tab: EditorTab) => string) => {
  const { t } = useI18n();
  return useCallback(
    (tab: EditorTab): string => {
      const raw =
        tab.kind === "note"
          ? tab.note.title
          : tab.kind === "external"
            ? tab.file.name
            : tab.kind === "temp"
              ? tab.preview.title
              : tab.entry.title;
      return raw.trim() || t("无标题");
    },
    [t],
  );
};

export const EditorTabs: React.FC<EditorTabsProps> = ({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onCloseAll,
  onMoveTab,
}) => {
  const { t } = useI18n();
  const titleOf = useTabTitle();
  const stripRef = useRef<HTMLDivElement>(null);
  const activeElRef = useRef<HTMLButtonElement | null>(null);
  /** 右键命中的标签：菜单文案里的「左侧 / 右侧」都以它为准 */
  const { menuPos, handleContextMenu, closeMenu } = useContextMenu();
  const [menuKey, setMenuKey] = useState<string | null>(null);
  /**
   * 拖拽排序用指针事件，不用 HTML5 drag：
   * 宿主已接管系统级拖放，pointer 方案也更省心（不需要 dragover 的 preventDefault 仪式）。
   */
  const dragRef = useRef<{ key: string; startX: number; active: boolean } | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  /** 拖拽结束后浏览器还会补一个 click：吞掉它，否则一拖就顺带切了标签 */
  const suppressClickRef = useRef(false);
  /** 收起菜单时把命中项一起清掉：否则下次渲染还会按旧 key 算「左侧 / 右侧」置灰状态 */
  const dismissMenu = useCallback(() => {
    setMenuKey(null);
    closeMenu();
  }, [closeMenu]);

  /** 竖向滚轮转横向：只在真的横向溢出时拦截，否则滚轮继续交给外层 */
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const next = el.scrollLeft + (event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
      if (next <= 0 || next >= max) return;
      event.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [tabs.length]);

  /** 切到的标签可能滚在视野外（命令面板打开笔记、AI 打开预览）：滚到能看见的位置 */
  useEffect(() => {
    activeElRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  /** onMoveTab 每次渲染都是新函数，窗口监听只挂一次，所以经 ref 读最新实现 */
  const moveTabRef = useRef(onMoveTab);
  moveTabRef.current = onMoveTab;

  /**
   * 拖拽排序：指针事件走 **window 监听**，不用 setPointerCapture。
   *
   * 捕获方案在 WebView2 里要先把指针绑到某个元素上，标签主体又是 <button>，
   * 容易在「按下的元素」和「捕获的元素」之间打转；window 监听没有这些前提，
   * 指针拖到编辑区、拖出窗口都能收到 move / up。
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        // 位移不足 5px 当点击：点标签切换不该被当成拖拽
        if (Math.abs(event.clientX - drag.startX) < 5) return;
        drag.active = true;
        setDraggingKey(drag.key);
        suppressClickRef.current = true;
        // 拖拽期间别把正文选中了；指针跑到正文上时也别变成 I 形光标
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      const strip = stripRef.current;
      if (!strip) return;
      // 拖到两端时顺手滚一屏，标签多的时候不必先滚再拖
      const stripRect = strip.getBoundingClientRect();
      if (event.clientX < stripRect.left + 24) strip.scrollLeft -= 12;
      else if (event.clientX > stripRect.right - 24) strip.scrollLeft += 12;
      // 按几何位置找落点：被拖的标签自己也在候选里，靠 key 相同跳过
      for (const el of Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-key]"))) {
        const rect = el.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right) continue;
        const overKey = el.dataset.tabKey;
        if (overKey && overKey !== drag.key) moveTabRef.current(drag.key, overKey);
        break;
      }
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDraggingKey(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.style.cursor = "";
      if (suppressClickRef.current) {
        // 拖完浏览器还会补一个 click，延后一拍再放开标记
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.style.cursor = "";
    };
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={stripRef}
      className="tabs-scroll flex h-9 shrink-0 select-none items-stretch overflow-x-auto overflow-y-hidden border-b border-line bg-app"
      role="tablist"
      aria-label={t("已打开的标签")}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        const title = titleOf(tab);
        return (
          <div
            key={tab.key}
            data-tab-key={tab.key}
            onContextMenu={(event) => {
              setMenuKey(tab.key);
              handleContextMenu(event);
            }}
            onPointerDown={(event) => {
              // 只有左键按在标签上才起手：关闭按钮要留给点击，中键是「关闭标签」的手势
              if (event.button !== 0) return;
              if ((event.target as HTMLElement).closest("[data-tab-close]")) return;
              dragRef.current = { key: tab.key, startX: event.clientX, active: false };
            }}
            className={`group relative flex h-full min-w-[104px] max-w-[200px] shrink-0 items-center gap-1.5 border-r border-line pl-2.5 pr-1 transition-colors ${
              draggingKey === tab.key ? "cursor-grabbing opacity-60" : ""
            } ${isActive ? "bg-surface text-body" : "text-muted hover:bg-surface-alt hover:text-body"}`}
          >
            {/* 激活态指示线：贴顶 2px，与整块编辑区连成一体 */}
            {isActive && <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-primary-500" />}
            <button
              ref={isActive ? activeElRef : undefined}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={title}
              onClick={() => {
                if (suppressClickRef.current) return;
                onActivate(tab.key);
              }}
              onAuxClick={(event) => {
                // 中键关闭：与浏览器/编辑器标签的习惯一致
                if (event.button !== 1) return;
                event.preventDefault();
                onClose(tab.key);
              }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 text-left text-xs outline-none"
            >
              <Icon
                name={KIND_ICON[tab.kind]}
                className={`h-3.5 w-3.5 ${isActive ? "text-primary-500" : "text-faint"}`}
              />
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </button>
            <button
              type="button"
              data-tab-close="true"
              title={t("关闭标签")}
              aria-label={t("关闭标签")}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.key);
              }}
              className={`flex h-5 w-5 flex-none items-center justify-center rounded text-faint transition-opacity hover:bg-app hover:text-body ${
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <Icon name="modal-close" className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}

      {menuKey !== null && (
        <ContextMenu
          position={menuPos}
          onClose={dismissMenu}
          items={buildTabMenu({
            onClose: () => {
              onClose(menuKey);
              dismissMenu();
            },
            onCloseOthers: () => {
              onCloseOthers(menuKey);
              dismissMenu();
            },
            onCloseLeft: () => {
              onCloseLeft(menuKey);
              dismissMenu();
            },
            onCloseRight: () => {
              onCloseRight(menuKey);
              dismissMenu();
            },
            onCloseAll: () => {
              onCloseAll();
              dismissMenu();
            },
            hasLeft: tabs.findIndex((tab) => tab.key === menuKey) > 0,
            hasRight: tabs.findIndex((tab) => tab.key === menuKey) < tabs.length - 1,
            hasOthers: tabs.length > 1,
          })}
        />
      )}
    </div>
  );
};
