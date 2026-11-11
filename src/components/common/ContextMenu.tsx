/**
 * 通用右键菜单：createPortal 到 body 后用 fixed 坐标渲染，因此不会被父级 overflow 裁切。
 *
 * 光标位置只是期望值——菜单宽度随条目文案变化，只能挂载后量：先按原始坐标渲染，
 * useLayoutEffect 里测量并夹进视口（四周留 8px），在浏览器绘制前完成校正。
 *
 * 子菜单递归渲染，支持任意深度；每层独立管理 hover 状态与位置，向右展开，
 * 右侧放不下时翻到左侧；父项悬停即切换，移入子菜单不会关闭。
 * 关闭时机：点击菜单外（mousedown）、Esc、任意容器滚动（capture 阶段监听）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextMenuItem, ContextMenuProps } from "@/interface/app/ui";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";

/** 菜单根容器的 data 属性，用于外部点击检测时识别所有层级的 submenu DOM */
const MENU_ROOT_ATTR = 'data-context-menu-root';

/** 把菜单夹进视口：四周留 8px；菜单本身比视口还宽时退回 margin，避免算出负坐标 */
function getSafePosition(x: number, y: number, width: number, height: number) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

/**
 * 递归子菜单组件：渲染一层菜单，hover 有 submenu 的项时继续递归渲染下一层。
 * 位置由父级传入（主菜单算好传给第一层 submenu，第一层算好传给第二层…），
 * 每层独立管理自己的 activeSub state。
 *
 * z-index 用递减方案：主菜单 z-[2147483647]，第一层 submenu z-[2147483646]，
 * 每层 -1，避免多层 submenu 互相遮挡。因为后渲染的 DOM 会盖在前面上面，
 * 父级用最大值保证在所有 submenu 之下，submenu 逐层递减让更深的层在上。
 */
function SubmenuMenu({
  items,
  position,
  onClose,
  depth,
}: {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
  depth: number;
}) {
  const [activeSub, setActiveSub] = useState<number | null>(null);
  const [subPos, setSubPos] = useState<{ x: number; y: number } | null>(null);
  const subRef = useRef<HTMLDivElement>(null);

  /** 子子菜单定位：宽度固定按 180 估算，高度按每项 32px 推；右侧放不下就翻到父项左边 */
  const handleSubEnter = useCallback((index: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const width = 180;
    const height = Math.max(40, (items[index]?.submenu?.length || 1) * 32 + 8);
    const x = rect.right + 4;
    const y = rect.top - 4;
    setSubPos(getSafePosition(x + width > window.innerWidth ? rect.left - width - 4 : x, y, width, height));
    setActiveSub(index);
  }, [items]);

  const zIndex = 2147483647 - depth;

  return (
    <div
      ref={subRef}
      {...{ [MENU_ROOT_ATTR]: 'true' }}
      className="fixed animate-scaleIn"
      style={{ left: position.x, top: position.y, zIndex }}
    >
      <div className="bg-surface rounded-xl shadow-elevated border border-line/80 py-1 min-w-[160px] overflow-hidden">
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={i} className="h-px bg-surface-alt my-1" />;
          }
          return (
            <div
              key={i}
              className="relative"
              onMouseEnter={(e) => {
                if (item.submenu) {
                  handleSubEnter(i, e.currentTarget);
                } else {
                  setActiveSub(null);
                  setSubPos(null);
                }
              }}
            >
              <button
                onClick={() => {
                  if (item.disabled) return;
                  if (!item.submenu) {
                    item.onClick();
                    onClose();
                  }
                }}
                disabled={item.disabled}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2.5 transition-colors ${
                  item.disabled
                    ? 'text-faint-soft cursor-not-allowed'
                    : item.danger
                    ? 'text-danger-strong hover:bg-danger-soft'
                    : 'text-body hover:bg-app hover:text-ink'
                }`}
              >
                {item.icon && <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.submenu && (
                  <Icon name="menu-chevron-right" className="w-3.5 h-3.5 text-faint-soft" />
                )}
              </button>
            </div>
          );
        })}
      </div>
      {activeSub !== null && subPos && items[activeSub]?.submenu && (
        <SubmenuMenu
          items={items[activeSub].submenu!}
          position={subPos}
          onClose={onClose}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ items, position, onClose }) => {
  const { locale } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  /** 校正后的坐标；sourceX/sourceY 记住它对应哪一次 position，避免沿用上一份菜单的位置 */
  const [adjustedPos, setAdjustedPos] = useState<
    { x: number; y: number; sourceX: number; sourceY: number } | null
  >(null);
  /** 当前展开的第一层子菜单下标与坐标；之后的层级由 SubmenuMenu 自己管理 */
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);

  // 依赖 items.length：菜单项增减会改变高度，需要重新夹取一次
  useLayoutEffect(() => {
    if (!position) {
      setAdjustedPos(null);
      setActiveSubmenu(null);
      setSubmenuPos(null);
      return;
    }
    setActiveSubmenu(null);
    setSubmenuPos(null);
    if (!menuRef.current) {
      setAdjustedPos({
        x: position.x,
        y: position.y,
        sourceX: position.x,
        sourceY: position.y,
      });
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const next = getSafePosition(position.x, position.y, rect.width, rect.height);
    setAdjustedPos({
      ...next,
      sourceX: position.x,
      sourceY: position.y,
    });
  }, [position, items.length, locale]);

  // scroll 用 capture 阶段：菜单不跟随滚动，任何可滚动祖先一滚就会飘到错误位置，直接关掉最省事
  useEffect(() => {
    if (!position) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // 遍历所有带 data-context-menu-root 的元素，覆盖主菜单 + 任意层级 submenu
      const roots = document.querySelectorAll<HTMLElement>(`[${MENU_ROOT_ATTR}]`);
      for (const root of roots) {
        if (root.contains(target)) return;
      }
      onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [position, onClose]);

  /** 第一层子菜单定位：宽度固定按 180 估算，高度按每项 32px 推；右侧放不下就翻到父项左边 */
  const handleSubmenuEnter = useCallback((index: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const width = 180;
    const height = Math.max(40, (items[index]?.submenu?.length || 1) * 32 + 8);
    const x = rect.right + 4;
    const y = rect.top - 4;
    setSubmenuPos(getSafePosition(x + width > window.innerWidth ? rect.left - width - 4 : x, y, width, height));
    setActiveSubmenu(index);
  }, [items]);

  if (!position) return null;

  const displayPos =
    adjustedPos?.sourceX === position.x && adjustedPos?.sourceY === position.y
      ? adjustedPos
      : { x: position.x, y: position.y };
  const activeSubmenuItem = activeSubmenu !== null ? items[activeSubmenu] : null;

  return createPortal(
    <>
      {/* 层级取 32 位有符号整数上限：必须压过 Modal（z-50）与 Toast（z-9999）；submenu 逐层 -1 */}
      <div
        ref={menuRef}
        data-editor-blur-ignore="true"
        {...{ [MENU_ROOT_ATTR]: 'true' }}
        className="fixed z-[2147483647] animate-scaleIn"
        style={{ left: displayPos.x, top: displayPos.y }}
      >
        <div className="bg-surface rounded-xl shadow-elevated border border-line/80 py-1 min-w-[160px] overflow-hidden">
          {items.map((item, i) => {
            if (item.divider) {
              return <div key={i} className="h-px bg-surface-alt my-1" />;
            }
            return (
              <div
                key={i}
                className="relative"
                onMouseEnter={(e) => {
                  if (item.submenu) {
                    handleSubmenuEnter(i, e.currentTarget);
                  } else {
                    setActiveSubmenu(null);
                    setSubmenuPos(null);
                  }
                }}
              >
                <button
                  onClick={() => {
                    if (item.disabled) return;
                    if (!item.submenu) {
                      item.onClick();
                      onClose();
                    }
                  }}
                  disabled={item.disabled}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2.5 transition-colors ${
                    item.disabled
                      ? 'text-faint-soft cursor-not-allowed'
                      : item.danger
                      ? 'text-danger-strong hover:bg-danger-soft'
                      : 'text-body hover:bg-app hover:text-ink'
                  }`}
                >
                  {item.icon && <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{item.icon}</span>}
                  <span className="flex-1">{item.label}</span>
                  {item.submenu && (
                    <Icon name="menu-chevron-right" className="w-3.5 h-3.5 text-faint-soft" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {activeSubmenuItem?.submenu && submenuPos && (
        <SubmenuMenu
          items={activeSubmenuItem.submenu}
          position={submenuPos}
          onClose={onClose}
          depth={1}
        />
      )}
    </>,
    document.body
  );
};

/**
 * 右键菜单的受控状态：只保存光标坐标，不关心点中的是谁——目标对象由调用方自己记在 ref 里。
 * preventDefault 屏蔽 WebView 默认菜单；stopPropagation 让嵌套区域只弹最内层菜单。
 */
export function useContextMenu() {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenuPos(null), []);

  return { menuPos, handleContextMenu, closeMenu };
}
