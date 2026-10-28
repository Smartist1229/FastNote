/**
 * 通用右键菜单：createPortal 到 body 后用 fixed 坐标渲染，因此不会被父级 overflow 裁切。
 *
 * 光标位置只是期望值——菜单宽度随条目文案变化，只能挂载后量：先按原始坐标渲染，
 * useLayoutEffect 里测量并夹进视口（四周留 8px），在浏览器绘制前完成校正。
 *
 * 子菜单统一向右展开，右侧放不下时翻到左侧；父项悬停即切换，移入子菜单不会关闭。
 * 关闭时机：点击菜单外（mousedown）、Esc、任意容器滚动（capture 阶段监听）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextMenuProps } from "@/interface/ui";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";

export const ContextMenu: React.FC<ContextMenuProps> = ({ items, position, onClose }) => {
  const { locale } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  /** 校正后的坐标；sourceX/sourceY 记住它对应哪一次 position，避免沿用上一份菜单的位置 */
  const [adjustedPos, setAdjustedPos] = useState<
    { x: number; y: number; sourceX: number; sourceY: number } | null
  >(null);
  /** 当前展开的子菜单下标与坐标：同一时刻只允许一个子菜单存在 */
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);

  /** 把菜单夹进视口：四周留 8px；菜单本身比视口还宽时退回 margin，避免算出负坐标 */
  const getSafePosition = useCallback((x: number, y: number, width: number, height: number) => {
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);
    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY),
    };
  }, []);

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
  }, [position, items.length, getSafePosition, locale]);

  // scroll 用 capture 阶段：菜单不跟随滚动，任何可滚动祖先一滚就会飘到错误位置，直接关掉最省事
  useEffect(() => {
    if (!position) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInMenu = menuRef.current?.contains(target);
      const isInSubmenu = submenuRef.current?.contains(target);
      if (!isInMenu && !isInSubmenu) {
        onClose();
      }
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

  /** 子菜单定位：宽度固定按 180 估算，高度按每项 32px 推；右侧放不下就翻到父项左边 */
  const handleSubmenuEnter = useCallback((index: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const width = 180;
    const height = Math.max(40, (items[index]?.submenu?.length || 1) * 32 + 8);
    const x = rect.right + 4;
    const y = rect.top - 4;
    setSubmenuPos(getSafePosition(x + width > window.innerWidth ? rect.left - width - 4 : x, y, width, height));
    setActiveSubmenu(index);
  }, [getSafePosition, items]);

  if (!position) return null;

  const displayPos =
    adjustedPos?.sourceX === position.x && adjustedPos?.sourceY === position.y
      ? adjustedPos
      : { x: position.x, y: position.y };
  const activeSubmenuItem = activeSubmenu !== null ? items[activeSubmenu] : null;

  return createPortal(
    <>
      {/* 层级取 32 位有符号整数上限：必须压过 Modal（z-50）与 Toast（z-9999） */}
      <div
        ref={menuRef}
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
        <div
          ref={submenuRef}
          className="fixed z-[2147483647] animate-scaleIn"
          style={{ left: submenuPos.x, top: submenuPos.y }}
          onMouseEnter={() => setActiveSubmenu(activeSubmenu)}
        >
          <div className="bg-surface rounded-xl shadow-elevated border border-line/80 py-1 min-w-[160px] overflow-hidden">
            {activeSubmenuItem.submenu.map((sub, j) => (
              <button
                key={j}
                onClick={() => {
                  sub.onClick();
                  onClose();
                }}
                disabled={sub.disabled}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2.5 transition-colors ${
                  sub.disabled
                    ? 'text-faint-soft cursor-not-allowed'
                    : sub.danger
                    ? 'text-danger-strong hover:bg-danger-soft'
                    : 'text-body hover:bg-app hover:text-ink'
                }`}
              >
                {sub.icon && <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{sub.icon}</span>}
                <span>{sub.label}</span>
              </button>
            ))}
          </div>
        </div>
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
