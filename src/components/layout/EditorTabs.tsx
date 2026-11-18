/**
 * 编辑区标签栏：横向排列、可滚动、可关闭。
 *
 * 三类交互刻意区分开：
 * - 单击标签 → 激活（不重建编辑器，滚动位置与撤销历史都在各自实例里）；
 * - 中键 / 点 × → 关闭（关闭时若有关联的加密态或外部文件写回，由标签域统一处理）；
 * - 滚轮 → 横向滚动（标签开得多时不必去拖那条细滚动条）。
 *
 * 预览标签（侧栏单击打开、还没编辑过的）：标题用斜体、激活时背景更淡，一眼能看出「这条会被替换」。
 * 双击它、或双击侧栏里同一篇笔记，就转成常驻标签。
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
  /** 双击标签：把预览标签转成常驻标签（不会被下一次单击替换） */
  onPromote: (key: string) => void;
  onClose: (key: string) => void;
  /** 右键菜单：关掉除它以外的全部 */
  onCloseOthers: (key: string) => void;
  /** 右键菜单：关掉它左侧的全部 */
  onCloseLeft: (key: string) => void;
  /** 右键菜单：关掉它右侧的全部 */
  onCloseRight: (key: string) => void;
  /** 右键菜单：全部关闭 */
  onCloseAll: () => void;
  /** 拖拽排序：把 fromKey 插到第 insertAt 项之前（0..标签数，末尾用标签数） */
  onMoveTab: (fromKey: string, insertAt: number) => void;
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
  onPromote,
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
  /**
   * 插入位置提示：`index` 是「会插到第几个标签之前」（= 标签数表示插到最后），
   * `x` 是竖线在滚动内容里的横坐标。只在拖动时出现，松手才真正重排——
   * 拖动过程中如果实时换位，指针一抖标签就来回跳，看不出落点在哪。
   */
  const [dropHint, setDropHint] = useState<{ index: number; x: number } | null>(null);
  const dropIndexRef = useRef<number | null>(null);
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
   *
   * 拖动期间**只更新落点提示**，松手才调 onMoveTab —— 实时交换会让标签在指针下
   * 来回跳，用户看不出自己会插到哪。
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
      const rows = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-key]"));
      if (rows.length === 0) return;
      /*
       * 落点按「指针越过哪条中线」算，而不是「指针压在哪一条上」：
       * 前者在第一个标签左侧 / 最后一个标签右侧也有明确含义（插到最前 / 最后），
       * 也不会出现「压在同一个标签上但想插到它前面」的歧义。
       */
      let index = rows.length;
      for (let i = 0; i < rows.length; i += 1) {
        const rect = rows[i].getBoundingClientRect();
        if (event.clientX < rect.left + rect.width / 2) {
          index = i;
          break;
        }
      }
      const border =
        index >= rows.length
          ? rows[rows.length - 1].getBoundingClientRect().right
          : rows[index].getBoundingClientRect().left;
      // 竖线相对滚动内容定位：加回 scrollLeft，横向滚动时线会跟着走
      const x = border - stripRect.left + strip.scrollLeft;
      dropIndexRef.current = index;
      setDropHint((prev) => (prev && prev.index === index && prev.x === x ? prev : { index, x }));
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      const insertAt = dropIndexRef.current;
      dragRef.current = null;
      dropIndexRef.current = null;
      setDraggingKey(null);
      setDropHint(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (suppressClickRef.current) {
        // 拖完浏览器还会补一个 click，延后一拍再放开标记
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      if (!drag.active || insertAt === null) return;
      moveTabRef.current(drag.key, insertAt);
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
    };
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={stripRef}
      className="tabs-scroll relative flex h-9 shrink-0 select-none items-stretch overflow-x-auto overflow-y-hidden border-b border-line bg-app"
      role="tablist"
      aria-label={t("已打开的标签")}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        const isPreview = tab.isPreview === true;
        const title = titleOf(tab);
        return (
          <div
            key={tab.key}
            data-tab-key={tab.key}
            data-preview={isPreview ? "true" : undefined}
            onContextMenu={(event) => {
              setMenuKey(tab.key);
              handleContextMenu(event);
            }}
            onDoubleClick={() => onPromote(tab.key)}
            onPointerDown={(event) => {
              // 只有左键按在标签上才起手：关闭按钮要留给点击，中键是「关闭标签」的手势
              if (event.button !== 0) return;
              if ((event.target as HTMLElement).closest("[data-tab-close]")) return;
              dragRef.current = { key: tab.key, startX: event.clientX, active: false };
            }}
            className={`group relative flex h-full min-w-[104px] max-w-[200px] shrink-0 items-center gap-1.5 border-r border-line pl-2.5 pr-1 transition-colors ${
              draggingKey === tab.key ? "cursor-grabbing opacity-40" : ""
            } ${isActive ? "bg-surface text-body" : "text-muted hover:bg-surface-alt hover:text-body"}`}
          >
            {/* 激活态指示线：贴顶 2px，与整块编辑区连成一体；预览标签用渐隐，暗示它是临时的 */}
            {isActive ? (
              <span
                className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] ${
                  isPreview ? "bg-gradient-to-r from-primary-500/80 via-primary-500/40 to-transparent" : "bg-primary-500"
                }`}
              />
            ) : (
              /* 没被激活的预览标签也占住这条「指示线」：换成虚线，一眼就能看出它会随时被替换 */
              isPreview && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-1.5 top-0 border-t border-dashed border-primary-300/80"
                />
              )
            )}
            <button
              ref={isActive ? activeElRef : undefined}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={isPreview ? `${title} — ${t("临时标签，双击固定")}` : title}
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
                className={`h-3.5 w-3.5 ${isActive ? "text-primary-500" : "text-faint"} ${
                  isPreview ? "opacity-70" : ""
                }`}
              />
              {/*
                斜体是「预览标签」的标记，但斜体必须补一段右内边距：
                倾斜后字形的右上角会越过内容盒，被 truncate 的 overflow:hidden 切掉一块
                （短标题也会掉角，不是只有被省略号截断时才出现）。
              */}
              <span className={`min-w-0 flex-1 truncate ${isPreview ? "pr-1 italic" : ""}`}>{title}</span>
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

      {/*
        插入位置指示线：拖动时贴在「会插进的那个缝」上，松手才真正换位。
        transition-[left] 让它在相邻缝之间滑过去，比突然跳一格更容易跟上。
      */}
      {dropHint && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 top-0 z-10 w-[2px] -translate-x-1/2 rounded-full bg-primary-500 transition-[left] duration-100 ease-out"
          style={{ left: dropHint.x }}
        />
      )}

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
