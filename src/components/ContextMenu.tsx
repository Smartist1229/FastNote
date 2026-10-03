import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
  submenu?: ContextMenuItem[];
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number } | null;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ items, position, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState<
    { x: number; y: number; sourceX: number; sourceY: number } | null
  >(null);
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);

  const getSafePosition = useCallback((x: number, y: number, width: number, height: number) => {
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);
    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY),
    };
  }, []);

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
  }, [position, items.length, getSafePosition]);

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
      <div
        ref={menuRef}
        className="fixed z-[2147483647] animate-scaleIn"
        style={{ left: displayPos.x, top: displayPos.y }}
      >
        <div className="bg-white rounded-xl shadow-elevated border border-slate-200/80 py-1 min-w-[160px] overflow-hidden">
          {items.map((item, i) => {
            if (item.divider) {
              return <div key={i} className="h-px bg-slate-100 my-1" />;
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
                      ? 'text-slate-300 cursor-not-allowed'
                      : item.danger
                      ? 'text-red-600 hover:bg-red-50'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {item.icon && <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{item.icon}</span>}
                  <span className="flex-1">{item.label}</span>
                  {item.submenu && (
                    <svg className="w-3.5 h-3.5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
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
          <div className="bg-white rounded-xl shadow-elevated border border-slate-200/80 py-1 min-w-[160px] overflow-hidden">
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
                    ? 'text-slate-300 cursor-not-allowed'
                    : sub.danger
                    ? 'text-red-600 hover:bg-red-50'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
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
