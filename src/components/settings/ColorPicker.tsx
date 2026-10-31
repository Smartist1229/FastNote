import { useI18n } from "@/i18n";
/**
 * 设置里的自绘取色器（SV 面板 + 色相滑杆 + 十六进制输入）。
 *
 * 不用原生 `<input type="color">`：WebView2 在拖动过程中会连续触发 change，
 * 主题一整页换 CSS 变量、每个像素都重算一遍，拖起来就是卡的。
 * 这里拖动只改面板本地状态，**松手才 onChange 一次**；
 * 松手后仍可继续微调，面板不会自己收起。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { normalizeHex } from "@/lib/theme";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const hsvToHex = (h: number, s: number, v: number): string => {
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  const segment = Math.floor((((h % 360) + 360) % 360) / 60) % 6;
  const table: [number, number, number][] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [r, g, b] = table[segment] ?? [0, 0, 0];
  const byte = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
};

const hexToHsv = (value: string): { h: number; s: number; v: number } => {
  const hex = normalizeHex(value) ?? "#000000";
  const int = Number.parseInt(hex.slice(1), 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
};

export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  label: string;
  disabled?: boolean;
  /** 触发按钮额外 className（不显示色值时按钮本身就是色块） */
  className?: string;
  /** 色块旁显示十六进制文本 */
  showValue?: boolean;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  label,
  disabled,
  className = "",
  showValue = false,
}) => {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<"sv" | "hue" | null>(null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [draft, setDraft] = useState<string | null>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  /** 外部值变化（恢复默认、导入主题）时同步；拖动中不打断 */
  useEffect(() => {
    if (dragging.current) return;
    setHsv(hexToHsv(value));
    setDraft(null);
  }, [value]);

  const placePanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 236;
    const height = 218;
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - margin
      ? Math.max(margin, rect.top - height - 6)
      : below;
    setPos({ top, left });
  };

  const openPanel = () => {
    placePanel();
    setHsv(hexToHsv(value));
    setDraft(null);
    setOpen(true);
  };

  const closePanel = (commitDraft: boolean) => {
    if (commitDraft && draft !== null) {
      const next = normalizeHex(draft);
      if (next) onChange(next);
    }
    setDraft(null);
    setOpen(false);
  };

  /** 点外部 / Esc / 滚动 / 改窗口大小：收起面板 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closePanel(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel(false);
    };
    const onLayout = () => closePanel(true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  });

  const readPointer = (kind: "sv" | "hue", event: React.PointerEvent) => {
    const element = kind === "sv" ? svRef.current : hueRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const width = element.offsetWidth || 1;
    const height = element.offsetHeight || 1;
    const ratioX = clamp01((event.clientX - rect.left) / width);
    const base = hsvRef.current;
    return kind === "sv"
      ? { ...base, s: ratioX, v: 1 - clamp01((event.clientY - rect.top) / height) }
      : { ...base, h: ratioX * 360 };
  };

  const applyPointer = (kind: "sv" | "hue", event: React.PointerEvent) => {
    const next = readPointer(kind, event);
    if (!next) return null;
    hsvRef.current = next;
    setHsv(next);
    return next;
  };

  const beginDrag = (kind: "sv" | "hue") => (event: React.PointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = kind;
    setDraft(null);
    applyPointer(kind, event);
  };

  const moveDrag = (kind: "sv" | "hue") => (event: React.PointerEvent) => {
    if (dragging.current !== kind) return;
    event.preventDefault();
    applyPointer(kind, event);
  };

  const endDrag = (kind: "sv" | "hue") => (event: React.PointerEvent) => {
    if (dragging.current !== kind) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 用松手瞬间的坐标：最后一次 pointermove 可能还没进 React 状态
    const next = applyPointer(kind, event) ?? hsvRef.current;
    onChange(hsvToHex(next.h, next.s, next.v));
  };

  const editHex = (raw: string) => {
    setDraft(raw);
    const next = normalizeHex(raw);
    if (next) {
      const value = hexToHsv(next);
      hsvRef.current = value;
      setHsv(value);
    }
  };

  const commitHex = (raw: string) => {
    const next = normalizeHex(raw);
    setDraft(null);
    if (!next) return;
    const value = hexToHsv(next);
    hsvRef.current = value;
    setHsv(value);
    onChange(next);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closePanel(true) : openPanel())}
        aria-label={label}
        aria-expanded={open}
        title={`${label}：${normalizeHex(value) ?? value}`}
        className={`relative overflow-hidden ${showValue ? "inline-flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-lg border border-line bg-surface hover:bg-surface-alt transition-colors" : ""} ${
          disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
        } ${className}`}
        style={showValue ? undefined : { background: normalizeHex(value) ?? value }}
      >
        {showValue && (
          <>
            <span
              className="w-5 h-5 flex-none rounded-md border border-line-strong/60 shadow-inner"
              style={{ background: normalizeHex(value) ?? value }}
            />
            <span className="font-mono text-[11px] uppercase text-body">{(normalizeHex(value) ?? value).toUpperCase()}</span>
          </>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            onPointerDown={(event) => event.stopPropagation()}
            className="fixed z-[90] w-[236px] p-2.5 rounded-xl bg-surface border border-line shadow-elevated animate-scaleIn"
            style={{ top: pos.top, left: pos.left }}
          >
            <div
              ref={svRef}
              className="relative w-full h-[132px] rounded-lg overflow-hidden cursor-crosshair touch-none"
              style={{ background: `hsl(${hsv.h} 100% 50%)` }}
              onPointerDown={beginDrag("sv")}
              onPointerMove={moveDrag("sv")}
              onPointerUp={endDrag("sv")}
              onPointerCancel={endDrag("sv")}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent" />
              <div
                className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md pointer-events-none"
                style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
              />
            </div>

            <div
              ref={hueRef}
              className="relative h-3 mt-2 rounded-full cursor-pointer touch-none"
              style={{ background: "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" }}
              role="slider"
              tabIndex={0}
              aria-label={t("{label}色相", { label: label })}
              aria-valuenow={Math.round(hsv.h)}
              aria-valuemin={0}
              aria-valuemax={360}
              onPointerDown={beginDrag("hue")}
              onPointerMove={moveDrag("hue")}
              onPointerUp={endDrag("hue")}
              onPointerCancel={endDrag("hue")}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const step = event.shiftKey ? 15 : 3;
                const next = (hsv.h + (event.key === "ArrowRight" ? step : -step) + 360) % 360;
                setHsv((prev) => ({ ...prev, h: next }));
                onChange(hsvToHex(next, hsv.s, hsv.v));
              }}
            >
              <div
                className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md pointer-events-none"
                style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
              />
            </div>

            <div className="flex items-center gap-1.5 mt-2">
              <span
                className="w-6 h-6 flex-none rounded-md border border-line-strong/60 shadow-inner"
                style={{ background: hex }}
              />
              <input
                type="text"
                value={draft ?? hex}
                spellCheck={false}
                aria-label={t("{label}色值", { label: label })}
                onFocus={(event) => {
                  setDraft(hex);
                  event.currentTarget.select();
                }}
                onChange={(event) => editHex(event.target.value)}
                onBlur={() => {
                  if (draft !== null) commitHex(draft);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (draft !== null) commitHex(draft);
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    setDraft(null);
                    event.currentTarget.blur();
                  }
                }}
                className="min-w-0 flex-1 px-2 py-1 text-[11px] font-mono uppercase input-modern"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
