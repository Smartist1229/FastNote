import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { TEXT_FORMAT_GROUPS, isSupportedTextExt, normalizeTextExt } from '@/config/textFileFormats';
import { Icon } from '@/components/common/Icon';

interface TextExtPickerProps {
  /** 触发按钮的位置，浮层贴着它显示 */
  anchor: DOMRect;
  /** 当前后缀（不带点） */
  value: string;
  /** 选定后缀（已确认在白名单内） */
  onPick: (ext: string) => void;
  onClose: () => void;
}

const CARD_WIDTH = 236;
/** 估算高度，用于判断向下展示还向上展示 */
const CARD_HEIGHT = 300;
const MARGIN = 8;

/**
 * 纯文本后缀选择浮层：搜索 + 分组列表 + 自定义输入。
 * 列表来自纯文本白名单，自定义输入也会校验，避免写出打不开的二进制文件。
 */
export const TextExtPicker: React.FC<TextExtPickerProps> = ({ anchor, value, onPick, onClose }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [keyword, setKeyword] = useState('');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose();
    };
    // Esc 用捕获阶段拦下，避免同时把外层的导出弹窗一起关掉
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  const query = keyword.trim().toLowerCase();
  const groups = useMemo(
    () =>
      TEXT_FORMAT_GROUPS.map((group) => ({
        name: group.name,
        formats: group.formats.filter(
          (format) => !query || format.ext.includes(query) || format.label.toLowerCase().includes(query)
        ),
      })).filter((group) => group.formats.length > 0),
    [query]
  );

  // 优先展示在按钮下方，空间不够就翻到上方
  const left = Math.min(
    Math.max(MARGIN, anchor.left),
    Math.max(MARGIN, window.innerWidth - CARD_WIDTH - MARGIN)
  );
  const top =
    anchor.bottom + 4 + CARD_HEIGHT > window.innerHeight - MARGIN
      ? Math.max(MARGIN, anchor.top - CARD_HEIGHT - 4)
      : anchor.bottom + 4;

  const customExt = normalizeTextExt(custom);
  const applyCustom = () => {
    if (!customExt) return;
    if (!isSupportedTextExt(customExt)) {
      setError('只支持下面列出的纯文本格式');
      return;
    }
    onPick(customExt);
  };

  return createPortal(
    // 浮层挂在 body 上，点击事件不向导出弹窗冒泡，避免顺带把弹窗关掉
    <div
      ref={cardRef}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[60] animate-scaleIn bg-white rounded-xl shadow-elevated border border-slate-200/80 overflow-hidden"
      style={{ left, top, width: CARD_WIDTH }}
    >
      <div className="p-2 border-b border-slate-100">
        <div className="relative">
          <Icon
            name="sidebar-search"
            className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2"
          />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索后缀，如 py、json"
            className="w-full pl-7 pr-2 py-1.5 text-xs input-modern"
          />
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto py-1">
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-slate-300">没有匹配的格式</p>
        ) : (
          groups.map((group) => (
            <div key={group.name}>
              <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-slate-400">{group.name}</p>
              {group.formats.map((format) => (
                <button
                  key={format.ext}
                  onClick={() => onPick(format.ext)}
                  className={`w-full flex items-center gap-2 px-3 py-1 text-left text-xs transition-colors ${
                    format.ext === value
                      ? 'text-primary-600 bg-primary-50'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="font-medium w-16 flex-shrink-0">.{format.ext}</span>
                  <span className="truncate min-w-0 flex-1 text-[11px] text-slate-400">{format.label}</span>
                  {format.ext === value && <Icon name="toast-check" className="w-3.5 h-3.5 flex-shrink-0" />}
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="p-2 border-t border-slate-100">
        <div className="flex items-center gap-1.5">
          <input
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyCustom();
            }}
            placeholder="自定义，如 .py"
            className="flex-1 min-w-0 px-2 py-1.5 text-xs input-modern"
          />
          <button
            onClick={applyCustom}
            disabled={!customExt}
            className="btn-primary px-2.5 py-1.5 text-xs flex-shrink-0 disabled:opacity-40"
          >
            应用
          </button>
        </div>
        {error ? (
          <p className="mt-1 text-[10px] text-red-500">{error}</p>
        ) : (
          <p className="mt-1 text-[10px] text-slate-400">仅限纯文本格式，二进制格式会打不开</p>
        )}
      </div>
    </div>,
    document.body
  );
};
