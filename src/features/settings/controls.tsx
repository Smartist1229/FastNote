/* 设置行的基础控件：徽标、开关、数值、分段按钮、下拉选择与色值列表。 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EnumOption } from "@/interface/settings/settings";
import type { SettingBadgeId, SettingBadgeTone } from "@/config/app/settingBadges";
import { getBadge } from "@/config/app/settingBadges";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";
import { normalizeHexList } from "@/lib/theme/theme";
import { reservedShortcutName } from "@/plugins/reservedShortcuts";

/** 徽标 tone → 配色：小圆角、半透明浅底、同系前景与描边；purple 暂无主题令牌，先用默认色板 */
const BADGE_TONE_CLASS: Record<SettingBadgeTone, string> = {
  primary: "bg-primary-50 text-primary-600 border-primary-200",
  amber: "bg-warning-soft text-warning border-warning-line/60",
  red: "bg-danger-soft text-danger border-danger-line/60",
  purple: "bg-purple-50 text-purple-600 border-purple-200",
};

/**
 * 统一行徽标：按 id 从徽标目录（config/app/settingBadges.json）取文案与色调，
 * 行模型只引用 id，不再各自维护徽标语义。
 */
export const RowBadge: React.FC<{ id: SettingBadgeId }> = ({ id }) => {
  const { t } = useI18n();
  const badge = getBadge(id);
  return (
    <span
      className={`px-1.5 py-[1px] rounded text-[10px] font-medium border flex-shrink-0 ${
        BADGE_TONE_CLASS[badge.tone] ?? "bg-app text-faint border-line"
      }`}
      title={badge.hint ? t(badge.hint) : undefined}
    >
      {t(badge.label)}
    </span>
  );
};

export const Switch: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({
  value,
  onChange,
}) => (
  <button
    onClick={() => onChange(!value)}
    role="switch"
    aria-checked={value}
    className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors relative ${
      value ? "bg-primary-500" : "bg-surface-strong"
    }`}
  >
    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-surface shadow transition-all ${value ? "left-[18px]" : "left-0.5"}`} />
  </button>
);

/**
 * 数值设置项：允许自由输入（输入过程中不夹取，否则刚敲第一个数字就会被弹回下限），
 * 失焦或回车时再收敛到 [min, max] 并写入设置。
 */
export const NumberInput: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}> = ({ value, min, max, step, unit, onChange }) => {
  const { t } = useI18n();
  const [text, setText] = useState(String(value));

  // 外部值变化（恢复默认、滚轮缩放）时同步到输入框；本地输入期间 value 不变，不会被回写覆盖
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    // step < 1 的项（行高、间距、分栏比例…）要留住小数位，否则 1.8 会被四舍五入成 2
    const decimals = step > 0 && step < 1 ? (String(step).split(".")[1]?.length ?? 1) : 0;
    const next = Number(Math.min(max, Math.max(min, n)).toFixed(decimals));
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-20 px-2 py-1 text-xs text-right input-modern bg-app/60 focus:bg-surface transition-colors"
      />
      {unit ? <span className="text-[11px] text-faint whitespace-nowrap">{t(unit)}</span> : null}
    </div>
  );
};

/**
 * 色值列表：逗号分隔的十六进制颜色。
 *
 * 输入过程中保留原样（允许敲到一半），失焦或回车时才规范化：
 * 丢弃非法项、去重、最多 32 个；一个合法色都没有时回退原值。
 */
export const ColorListInput: React.FC<{
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}> = ({ value, placeholder, onChange }) => {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  const commit = () => {
    const list = normalizeHexList(text);
    if (!list.length) {
      setText(value);
      return;
    }
    const next = list.join(", ");
    setText(next);
    if (next !== value) onChange(next);
  };

  const preview = normalizeHexList(text).slice(0, 16);
  const total = normalizeHexList(text).length;

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setText(value);
            event.currentTarget.blur();
          }
        }}
        className="w-[280px] px-2 py-1 text-[11px] font-mono input-modern bg-app/60 focus:bg-surface transition-colors"
      />
      <div className="flex items-center gap-1 h-3.5 max-w-[280px] overflow-hidden">
        {preview.map((hex) => (
          <span
            key={hex}
            className="w-3.5 h-3.5 flex-none rounded-[3px] border border-line"
            style={{ background: hex }}
            title={hex}
          />
        ))}
        {total > preview.length && <span className="text-[10px] text-faint">+{total - preview.length}</span>}
      </div>
    </div>
  );
};

/**
 * 选项色卡：底色铺满，token 色画成小色点，让用户不点开也能看出这套配色长什么样。
 * 没有 swatch 的选项（绝大多数）返回 null，不占位置。
 */
export const OptionSwatch: React.FC<{ swatch?: string[] }> = ({ swatch }) => {
  if (!swatch || swatch.length === 0) return null;
  const [bg, ...dots] = swatch;
  return (
    <span
      className="w-4 h-4 flex-none rounded-[3px] border border-line/70 inline-flex items-center justify-center gap-[1.5px] overflow-hidden"
      style={{ background: bg }}
    >
      {dots.slice(0, 3).map((c, i) => (
        <span key={i} className="w-[3px] h-[3px] rounded-full" style={{ background: c }} />
      ))}
    </span>
  );
};

/**
 * 枚举设置项：分段按钮组而不是原生 select —— 选项少（2~3 个）时更直观，
 * 且样式跟随主题，不再是浏览器默认的下拉框。
 */
export const SegmentedInput: React.FC<{
  value: string;
  options: EnumOption[];
  onChange: (v: string) => void;
}> = ({ value, options, onChange }) => {
  const { t } = useI18n();
  return (
  <div className="inline-flex flex-shrink-0 flex-wrap items-center gap-0.5 p-0.5 rounded-lg bg-surface-alt border border-line/70">
    {options.map((o) => {
      const active = o.value === value;
      return (
        <button
          key={o.value}
          type="button"
          onClick={() => !active && onChange(o.value)}
          className={`px-2 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap ${
            active ? "bg-surface text-primary-600 font-medium shadow-xs" : "text-muted"
          } ${active ? "" : "hover:text-body"}`}
        >
          {o.value === "zh-CN" || o.value === "en-US" ? o.label : t(o.label)}
        </button>
      );
    })}
  </div>
);
};

/**
 * 下拉选择：选项多时分段按钮一行放不下，收进一个框里。
 *
 * 为什么不用原生 <select>：系统绘制的选项列表样式不受控，亮色窗口里是一整块系统灰，
 * 与设置窗口的观感脱节。这里自绘菜单——portal 到 body + fixed 定位，
 * 避免被设置窗口的滚动容器裁掉；点外部 / Esc / 选中即收起。
 */
export const SelectInput: React.FC<{
  value: string;
  options: EnumOption[];
  label: string;
  onChange: (v: string) => void;
  /** 紧凑模式：给「关于」这类小字行用——去掉边框和多余留白，看起来像行内值而不是表单控件 */
  compact?: boolean;
}> = ({ value, options, label, onChange, compact = false }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const triggerRect = useRef<DOMRect | null>(null);
  const current = options.find((o) => o.value === value);

  const close = () => setOpen(false);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    triggerRect.current = rect;
    // 下方放不下就往上翻，避免菜单被窗口底边截断
    const height = Math.min(options.length * 28 + 8, 264);
    const flip = rect.bottom + 4 + height > window.innerHeight && rect.top - 4 - height > 0;
    setPos({
      top: flip ? rect.top - 4 - height : rect.bottom + 4,
      left: rect.left,
      minWidth: rect.width,
    });
    setOpen(true);
  };

  // 紧凑触发器只有几十像素宽，菜单按左边缘对齐会探出面板外；量完宽度后改成右对齐。
  // 用 offsetWidth 而非 getBoundingClientRect：入场动画的 scale 会让后者偏小。
  useLayoutEffect(() => {
    if (!open || !compact || !pos) return;
    const width = menuRef.current?.offsetWidth;
    const rect = triggerRect.current;
    if (!width || !rect) return;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    if (Math.abs(left - pos.left) > 0.5) setPos({ ...pos, left });
  }, [compact, open, pos]);

  useEffect(() => {
    if (!open) return;
    // 点在触发器上交给它自己的 onClick 收起，其余点击一律关闭。
    // 菜单内部必须放过：mousedown 早于 click，这里关掉会让菜单先卸载，
    // 选项的 onClick 就再也收不到（表现为「点了没反应、值不变」）。
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // 滚动 / 改窗口大小时菜单位置会飘，直接收起最省事；
    // scroll 用捕获阶段，设置窗口自己的滚动容器不冒泡到 document
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  // 打开后把焦点交给当前选项：菜单是自绘的，不接管焦点的话键盘用户只能 Tab 逐个走，
  // 也让「方向键选、回车确认」这套原生下拉的习惯能延续下来。
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const target =
      menu?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]') ??
      menu?.querySelector<HTMLButtonElement>('[role="option"]');
    target?.focus();
  }, [open, pos]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") buttons[0].focus();
    else if (event.key === "End") buttons[buttons.length - 1].focus();
    else if (index < 0) buttons[event.key === "ArrowDown" ? 0 : buttons.length - 1].focus();
    else buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center text-[11px] transition-colors cursor-pointer ${
          compact
            ? `-mr-1 gap-1 px-1.5 py-0.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-300 ${
                open ? "bg-primary-50 text-primary-600" : "text-body hover:bg-surface-alt"
              }`
            : `gap-1.5 pl-2.5 pr-2 py-1.5 rounded-lg bg-surface border ${
                open ? "border-primary-400 text-primary-600" : "border-line text-body hover:bg-surface-alt"
              }`
        }`}
      >
        <OptionSwatch swatch={current?.swatch} />
        {current ? t(current.label) : value}
        <Icon
          name="sidebar-chevron-down"
          className={`w-3 h-3 text-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            onKeyDown={onMenuKeyDown}
            className="fixed z-[80] p-1 rounded-lg bg-surface border border-line shadow-elevated animate-scaleIn"
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, maxHeight: 264, overflowY: "auto" }}
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={`w-full flex items-center gap-2.5 px-2 py-1.5 text-[11px] text-left rounded-md transition-colors ${
                    active ? "bg-primary-50 text-primary-600 font-medium" : "text-body hover:bg-surface-alt"
                  }`}
                >
                  <OptionSwatch swatch={o.swatch} />
                  <span className="flex-1 truncate">{o.value === "zh-CN" || o.value === "en-US" ? o.label : t(o.label)}</span>
                  {active && <Icon name="sidebar-check" className="w-3 h-3 flex-none text-primary-500" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
};

/* ---------------- 组合键输入（插件配置项 kind = "shortcut" 用） ---------------- */

/** 单键名归一化：字母取 code（中文输入法下 key 不可靠），字母键 → "P"，空格 → "Space"，F1 原样 */
const shortcutKeyName = (event: KeyboardEvent): string => {
  const code = event.code ?? "";
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (code === "Space") return "Space";
  if (/^F\d{1,2}$/.test(event.key)) return event.key.toUpperCase();
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
};

/**
 * keydown → "Ctrl+Shift+P"。
 * 只按修饰键时返回 null（继续等主键）；顺序固定 Ctrl → Shift → Alt → Meta，
 * 与宿主 parseShortcut 拼 label 的顺序一致，避免同一个键位写出两种字符串。
 */
const shortcutComboOf = (event: KeyboardEvent): string | null => {
  const key = shortcutKeyName(event);
  if (["Control", "Shift", "Alt", "Meta", ""].includes(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
};

/** 至少带一个修饰键：裸字母做全局快捷键会把正常打字全吃掉 */
const shortcutHasModifier = (combo: string): boolean => /^(Ctrl|Shift|Alt|Meta)\+/.test(combo);

/**
 * 组合键设置项：点一下进入捕获态，按下的组合键直接变成 "Ctrl+Alt+P" 这种字符串。
 *
 * 为什么不用输入框：手写 "Ctrl+Alt+P" 要背格式（大小写、分隔符、修饰键顺序），
 * 写错了只会在插件注册快捷键时抛错，用户根本不知道错在哪。
 *
 * 捕获期间 `stopPropagation` 只能挡住 React 树里的监听；宿主与插件挂在 window **捕获阶段**
 * 的监听（Ctrl+P 跳转、插件自己的快捷键）已经先跑过了——所以按到「当前生效的那个键」时，
 * 它可能顺手把原功能也触发一次。这不影响设置结果，属于已知的轻微副作用。
 */
export const ShortcutInput: React.FC<{
  value: string;
  onChange: (combo: string) => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  const [capturing, setCapturing] = useState(false);
  /** 捕获态下的提示：没有修饰键 / 撞上宿主已占用的键位（两者文案不同） */
  const [invalid, setInvalid] = useState(false);
  const [reservedBy, setReservedBy] = useState("");

  const stop = () => {
    setCapturing(false);
    setInvalid(false);
    setReservedBy("");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    // 捕获态下所有按键都归这里：既不让页面滚动 / 焦点跑掉，也不让外部再处理一遍
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stop();
      return;
    }
    const combo = shortcutComboOf(event.nativeEvent);
    if (!combo) return;
    if (!shortcutHasModifier(combo)) {
      setInvalid(true);
      setReservedBy("");
      return;
    }
    // 宿主自己占用的键位（Ctrl+F 这类）：写进配置也只会在注册时失败，当场拒绝
    const reserved = reservedShortcutName(combo);
    if (reserved) {
      setInvalid(false);
      setReservedBy(reserved);
      return;
    }
    setInvalid(false);
    setReservedBy("");
    setCapturing(false);
    onChange(combo);
  };

  const label = !capturing
    ? value || t("点击后按下组合键")
    : reservedBy
      ? t("这个组合键已被「{name}」占用，换一个", { name: t(reservedBy) })
      : invalid
        ? t("组合键至少要有一个 Ctrl / Alt / Shift")
        : t("按下组合键…");

  /** 提示态（不接受当前按键）时文字用危险色，正常捕获 / 已设值时用常规色 */
  const warning = capturing && (invalid || reservedBy !== "");

  return (
    <button
      type="button"
      onClick={() => {
        setInvalid(false);
        setReservedBy("");
        setCapturing(true);
      }}
      onKeyDown={handleKeyDown}
      onBlur={stop}
      title={t("点一下，然后按下要用的组合键（Esc 取消）")}
      className={`min-w-[168px] px-2.5 py-1.5 text-xs rounded-lg border text-left font-mono transition-colors ${
        capturing
          ? "border-primary-400 bg-surface ring-1 ring-primary-400/30"
          : "border-line bg-app/60 hover:bg-surface"
      } ${warning ? "text-danger" : capturing || !value ? "text-faint" : "text-body"}`}
    >
      {label}
    </button>
  );
};
