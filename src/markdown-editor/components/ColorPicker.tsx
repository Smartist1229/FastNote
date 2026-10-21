/**
 * 自绘取色器：SV 面板 + 色相滑杆。
 *
 * 为什么不用原生 `<input type="color">`：
 * - WebView2 里它弹的是 Win32 系统对话框，位置乱飘、和浮层菜单的生命周期还打架；
 * - 更要命的是它在面板里**每次挪动都发 change**（有的版本连 preview 都算），
 *   外层一接到就立刻套色 + 关菜单，于是「刚碰上就确定了」，滑杆根本拖不动。
 *
 * 这套自己画：按下时抢占指针（`setPointerCapture`），之后无论指针跑到哪、
 * 松手时在哪，移动都还算在这块面板上 —— 拖到面板外面也不会断。
 * 拖动过程只更新本地状态做预览，**松手才真正落到文档**（一次拖动 = 一次编辑，不是几百次），
 * 菜单也不会在拖动中途被关掉。
 *
 * 撞过的坑：指针事件一律 `preventDefault` —— 焦点一旦被取色器抢走，编辑器的选区就没了。
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const isHex = (value: string): boolean => /^#?[0-9a-f]{6}$/i.test(value.trim());
const normalizeHex = (value: string): string => {
  const v = value.trim();
  return v.startsWith("#") ? v.toLowerCase() : `#${v.toLowerCase()}`;
};

/** HSV → `#rrggbb` */
const hsvToHex = (h: number, s: number, v: number): string => {
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  const segment = Math.floor(((h % 360) + 360) % 360 / 60) % 6;
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

/** `#rrggbb` → HSV */
const hexToHsv = (value: string): { h: number; s: number; v: number } => {
  const text = value.trim().replace(/^#/, "");
  const int = Number.parseInt(text, 16);
  if (!/^[0-9a-f]{6}$/i.test(text) || Number.isNaN(int)) return { h: 210, s: 0.75, v: 0.9 };
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

interface ColorPickerProps {
  /** 当前已生效的颜色（没有则为 null） */
  value: string | null;
  /** 没有当前颜色时的起始色 */
  fallback: string;
  labelCustom: string;
  labelClear: string;
  /** 松手提交一次颜色 */
  onPick: (hex: string) => void;
  onClear: () => void;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  fallback,
  labelCustom,
  labelClear,
  onPick,
  onClear,
}) => {
  const start = value && isHex(value) ? value : fallback;
  const [hsv, setHsv] = useState(() => hexToHsv(start));
  /**
   * 十六进制输入框的本地草稿：输入到一半（`#66d`）也是合法文本，
   * 不能拿 HSV 推出来的完整值把它顶回去。回车或失焦才提交。
   */
  const [draft, setDraft] = useState<string | null>(null);
  /** 正在拖哪一块：拖动中不接受外部 value 回灌，否则手柄会被拽回去 */
  const dragging = useRef<"sv" | "hue" | null>(null);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  /** 外部颜色变了（切换了段落、点开了别的工具）就跟着走，拖动时不打断 */
  useEffect(() => {
    if (dragging.current) return;
    setDraft(null);
    if (!value || !isHex(value)) return;
    const next = hexToHsv(value);
    setHsv((prev) =>
      Math.abs(prev.h - next.h) < 0.5 &&
      Math.abs(prev.s - next.s) < 0.005 &&
      Math.abs(prev.v - next.v) < 0.005
        ? prev
        : next,
    );
  }, [value]);

  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  /**
   * 指针 → 数值。
   * 宽高读 `offsetWidth/offsetHeight`（不受菜单出现动画的 transform 影响），
   * 位置读 `rect.left/top`（这是视觉坐标，指针也在同一坐标系里）。
   */
  const readPointer = (kind: "sv" | "hue", event: ReactPointerEvent) => {
    const element = kind === "sv" ? svRef.current : hueRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const width = element.offsetWidth || 1;
    const height = element.offsetHeight || 1;
    const ratioX = clamp01((event.clientX - rect.left) / width);
    return kind === "sv"
      ? { ...hsv, s: ratioX, v: 1 - clamp01((event.clientY - rect.top) / height) }
      : { ...hsv, h: ratioX * 360 };
  };

  const updateFromPointer = (kind: "sv" | "hue", event: ReactPointerEvent) => {
    const next = readPointer(kind, event);
    if (next) setHsv(next);
  };

  const beginDrag = (kind: "sv" | "hue") => (event: ReactPointerEvent) => {
    // 不 preventDefault 的话，按下会把焦点从编辑器挪走 —— 选区没了，颜色也就没地方套
    event.preventDefault();
    setDraft(null);
    const element = kind === "sv" ? svRef.current : hueRef.current;
    element?.setPointerCapture?.(event.pointerId);
    dragging.current = kind;
    updateFromPointer(kind, event);
  };

  const moveDrag = (kind: "sv" | "hue") => (event: ReactPointerEvent) => {
    if (dragging.current !== kind) return;
    event.preventDefault();
    updateFromPointer(kind, event);
  };

  const endDrag = (kind: "sv" | "hue") => (event: ReactPointerEvent) => {
    if (dragging.current !== kind) return;
    dragging.current = null;
    const element = kind === "sv" ? svRef.current : hueRef.current;
    if (element?.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
    // 用松手瞬间的坐标算最终色：最后一次 pointermove 可能还没进 React 状态
    const next = readPointer(kind, event) ?? hsv;
    setHsv(next);
    setDraft(null);
    onPick(hsvToHex(next.h, next.s, next.v));
  };

  /** 滑杆的键盘通道：左右调色相 */
  const onHueKey = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 15 : 3;
    const next = (hsv.h + (event.key === "ArrowRight" ? step : -step) + 360) % 360;
    setHsv((prev) => ({ ...prev, h: next }));
    setDraft(null);
    onPick(hsvToHex(next, hsv.s, hsv.v));
  };

  /** 合法的十六进制才提交；返回是否成功 */
  const commitHex = (raw: string): boolean => {
    if (!isHex(raw)) return false;
    const next = normalizeHex(raw);
    setHsv(hexToHsv(next));
    setDraft(null);
    onPick(next);
    return true;
  };

  /** 输入过程中只更新预览，不落文档；输入框保留用户原样文本 */
  const editHex = (raw: string) => {
    setDraft(raw);
    if (isHex(raw)) setHsv(hexToHsv(normalizeHex(raw)));
  };

  const finishHex = () => {
    if (draft === null) return;
    if (!commitHex(draft)) setDraft(null);
  };

  const displayHex = draft ?? hex;

  return (
    <div className="mde-picker" role="group" aria-label={labelCustom}>
      <div
        ref={svRef}
        className="mde-picker-sv"
        style={{ background: `hsl(${hsv.h} 100% 50%)` }}
        onPointerDown={beginDrag("sv")}
        onPointerMove={moveDrag("sv")}
        onPointerUp={endDrag("sv")}
        onPointerCancel={endDrag("sv")}
      >
        <div className="mde-picker-sv-white" />
        <div className="mde-picker-sv-black" />
        <div
          className="mde-picker-handle"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>

      <div className="mde-picker-row">
        <div
          ref={hueRef}
          className="mde-picker-hue"
          role="slider"
          tabIndex={0}
          aria-label={labelCustom}
          aria-valuenow={Math.round(hsv.h)}
          aria-valuemin={0}
          aria-valuemax={360}
          onPointerDown={beginDrag("hue")}
          onPointerMove={moveDrag("hue")}
          onPointerUp={endDrag("hue")}
          onPointerCancel={endDrag("hue")}
          onKeyDown={onHueKey}
        >
          <div
            className="mde-picker-hue-handle"
            style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
          />
        </div>
        <span className="mde-picker-preview" style={{ background: hex }} title={hex} />
      </div>

      <div className="mde-picker-row">
        <input
          type="text"
          className="mde-picker-hex"
          spellCheck={false}
          value={displayHex}
          aria-label={labelCustom}
          onFocus={(event) => {
            setDraft(hex);
            event.currentTarget.select();
          }}
          onChange={(event) => editHex(event.target.value)}
          onBlur={finishHex}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (commitHex(draft ?? hex)) event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
        <button
          type="button"
          className="mde-menu-item is-inline"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClear}
        >
          {labelClear}
        </button>
      </div>
    </div>
  );
};
