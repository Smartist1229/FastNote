import { t, useI18n, getLocale } from "@/i18n";
/**
 * 统一设置窗口。
 *
 * 职责：渲染左侧分区目录与右侧设置项，收集改动后上抛，不直接写库。
 * 落库路径：软件设置由 onAppSettingChange 交给 App 的 applyAppSetting 立即写单键；
 * AI 设置交给 App 的 effect 逐项 diff 后写库。两者都落在 SQLite 的 app_settings 表。
 *
 * 数据流：
 *   1. 打开时清空搜索、切到 defaultSection，并向 Tauri 取应用名与版本；
 *   2. 设置项 = rows（通用/编辑器/列表/对话/上下文）+ 若干自定义面板；
 *   3. **一次只渲染一个分区**（目录点选切换）：几百行设置项全量挂载会让打开明显变慢，
 *      ThemePanel / 服务商 / 访问权限这些子面板也会跟着空跑；
 *   4. 搜索同时匹配 rows 的 title/desc/keywords 与自定义面板的关键词表，命中数标在目录上；
 *   5. scope=live 立即生效，scope=startup 只影响下次启动时的初始状态。
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getName, getVersion } from "@tauri-apps/api/app";
import type { AiSettings } from "@/interface/ai";
import type { AppSettings, EnumOption } from "@/interface/settings";
import type { BackupSummary } from "@/interface/backup";
import type {
  SectionMeta,
  Scope,
  SettingRow,
  SettingsModalProps,
  SettingsSection,
} from "@/interface/settingsModal";
import { DEFAULT_AI_SETTINGS } from "@/config/aiDefaults";
import { DEFAULT_EDITOR_SETTINGS } from "@/config/appDefaults";
import { EDITOR_SETTING_SPECS } from "@/config/editorSettingSpecs";
import {
  APP_AUTHOR,
  APP_NAME_FALLBACK,
  APP_RELEASES_URL,
  ICON_SOURCE,
  OPEN_SOURCE_PROJECTS,
  shortUrl,
} from "@/config/about";
import { AiProviderSettings } from "@/components/ai/AiProviderModal";
import { ThemePanel } from "@/components/settings/ThemePanel";
import { ShortcutPanel } from "@/components/settings/ShortcutPanel";
import { SemanticPanel } from "@/components/settings/SemanticPanel";
import { ToolboxPanel } from "@/components/settings/ToolboxPanel";
import { WebdavPanel } from "@/components/settings/WebdavPanel";
import { ColorPicker } from "@/components/settings/ColorPicker";
import { Icon } from "@/components/common/Icon";
import { AiAccessLevelSelect } from "@/components/common/AiAccessLevelSelect";
import { useDraggable } from "@/components/common/useDraggable";
import { useActionGuard } from "@/hooks/useActionGuard";
import type { AiAccessLevel } from "@/interface/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/aiAccess";
import { useToast } from "@/components/common/Toast";
import { useConfirm } from "@/components/common/ConfirmDialog";
import {
  exportBackup,
  exportEncryptedBackup,
  exportSqliteBackup,
  importBackup,
  importEncryptedBackup,
  importSqliteBackup,
} from "@/api/backup";
import { BackupPassphraseDialog } from "@/components/common/EncryptionDialogs";
import { flushThemeSettings } from "@/stores/themeStore";
import { checkForUpdates, openUpdateDialog, useUpdater } from "@/stores/updaterStore";
import { normalizeHexList } from "@/lib/theme";
import { formatSpeed } from "@/lib/format";

/* ---------- 分区定义 ---------- */

/** AI 专属分区：enableAI 为 false 时整组隐藏，避免出现点了没反应的入口 */
const AI_SECTION_KEYS: SettingsSection[] = ["provider", "chat", "context", "memory", "access"];

/** 分区元数据：key 与 SettingsSection 一一对应，group 决定左侧目录归到哪一栏 */
const SECTIONS: SectionMeta[] = [
  { key: "general", label: "通用", icon: "ai-bolt", group: "软件" },
  { key: "editor", label: "编辑器", icon: "ai-edit", group: "软件" },
  { key: "view", label: "笔记列表", icon: "sidebar-list", group: "软件" },
  { key: "layout", label: "界面布局", icon: "sidebar-edit-square", group: "软件" },
  { key: "shortcuts", label: "快捷键", icon: "settings-shortcuts", group: "软件" },
  { key: "theme", label: "主题", icon: "settings-theme", group: "软件" },
  { key: "semantic", label: "语义搜索", icon: "ai-bolt", group: "软件" },
  { key: "toolbox", label: "工具箱", icon: "toolbox", group: "软件" },
  { key: "provider", label: "AI 服务商", icon: "settings-provider", group: "AI" },
  { key: "chat", label: "对话行为", icon: "settings-chat", group: "AI" },
  { key: "context", label: "上下文", icon: "settings-context", group: "AI" },
  { key: "memory", label: "记忆与提示词", icon: "settings-memory", group: "AI" },
  { key: "access", label: "AI 访问权限", icon: "ai-shield-check", group: "AI" },
  { key: "reset", label: "恢复默认", icon: "app-restore", group: "数据" },
  { key: "backup", label: "备份与恢复", icon: "app-backup", group: "数据" },
  { key: "about", label: "关于", icon: "toast-info", group: "其他" },
];

/** 目录分组顺序：与 SECTIONS 里的 group 对应，空分组在渲染时自动跳过 */
const ALL_GROUPS: SectionMeta["group"][] = ["软件", "AI", "数据", "其他"];

/** 分区元数据对外只读：命令面板据此生成「打开设置：xxx」，免得标题两处各写一份 */
export const SETTINGS_SECTIONS: readonly SectionMeta[] = SECTIONS;

/** 关闭 AI 能力时，「AI」分组整体不渲染 */
const getVisibleGroups = (enableAI: boolean): SectionMeta["group"][] =>
  enableAI ? ALL_GROUPS : ["软件", "数据", "其他"];

/** 「AI 访问权限」里"未分类"这一组的伪 key（真实分组 id 从 1 开始，用 -1 不会撞） */
const UNCATEGORIZED_KEY = -1;

/** 自定义面板分区：内容不是数据驱动的行，但同样参与搜索 */
const CUSTOM_KEYS: SettingsSection[] = ["theme", "semantic", "toolbox", "shortcuts", "provider", "memory", "access", "reset", "backup", "about"];

/* ---------- 基础控件 ---------- */

/** 作用范围徽标：live 改完即生效，startup 需下次启动才生效 */
const ScopeBadge: React.FC<{ scope: Scope }> = ({ scope }) => {
  const { t } = useI18n();
  return (
  <span
    className={`px-1.5 py-[1px] rounded text-[10px] font-medium border flex-shrink-0 ${
      scope === "live"
        ? "bg-success-soft text-success border-success-line/60"
        : "bg-warning-soft text-warning border-warning-line/60"
    }`}
    title={scope === "live" ? t("修改后立即生效") : t("在软件下次启动时生效")}
  >
    {scope === "live" ? t("实时生效") : t("重启生效")}
  </span>
);
};

/** 危险徽标：与「重启生效」并列，提示这一项改动有风险，默认态不要动 */
const DangerBadge: React.FC = () => {
  const { t } = useI18n();
  return (
  <span
    className="px-1.5 py-[1px] rounded text-[10px] font-medium border flex-shrink-0 bg-danger-soft text-danger border-danger-line/60"
    title={t("该项改动可能导致数据异常，非必要请勿修改")}
  >{t("不建议修改")}</span>
);
};

const Switch: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({
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
const NumberInput: React.FC<{
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
 * 枚举设置项：分段按钮组而不是原生 select —— 选项少（2~3 个）时更直观，
 * 且样式跟随主题，不再是浏览器默认的下拉框。
 */
/**
 * 色值列表：逗号分隔的十六进制颜色。
 *
 * 输入过程中保留原样（允许敲到一半），失焦或回车时才规范化：
 * 丢弃非法项、去重、最多 32 个；一个合法色都没有时回退原值。
 */
const ColorListInput: React.FC<{
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
const OptionSwatch: React.FC<{ swatch?: string[] }> = ({ swatch }) => {
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

const SegmentedInput: React.FC<{
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
            active ? "bg-surface text-primary-600 font-medium shadow-sm" : "text-muted"
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
const SelectInput: React.FC<{
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

/**
 * 行的统一渲染：左标题 + 说明 + 作用范围徽标，右侧按 kind 派发到具体控件。
 *
 * 用 memo 包一层：搜索输入、目录高亮、保存提示等状态变化都会重渲染整个弹窗，
 * 但这些变化并不改动具体某一行的 row 对象（row 引用只在设置值变化时重建），
 * 交给 memo 拦掉无谓的行级重渲染。
 */
const RowView = memo(function RowView({ row }: { row: SettingRow }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-[220px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-body">{t(row.title)}</span>
          <ScopeBadge scope={row.scope} />
          {row.danger && <DangerBadge />}
        </div>
        <p className="text-[11px] text-faint leading-relaxed mt-1">{t(row.desc)}</p>
      </div>
      <div className="max-w-full pt-0.5">
        {row.kind === "toggle" && <Switch value={row.value} onChange={row.onChange} />}
        {row.kind === "number" && (
          <NumberInput
            value={row.value}
            min={row.min}
            max={row.max}
            step={row.step ?? 1}
            unit={row.unit ? t(row.unit) : undefined}
            onChange={row.onChange}
          />
        )}
        {row.kind === "segment" && (
          <SegmentedInput value={row.value} options={row.options} onChange={row.onChange} />
        )}
        {row.kind === "select" && (
          <SelectInput label={t(row.title)} value={row.value} options={row.options} onChange={row.onChange} />
        )}
        {row.kind === "color" && (
          <ColorPicker
            value={row.value}
            onChange={row.onChange}
            label={t(row.title)}
            showValue
            className="min-w-[104px]"
          />
        )}
        {row.kind === "colorList" && (
          <ColorListInput
            value={row.value}
            placeholder={row.placeholder}
            onChange={row.onChange}
          />
        )}
      </div>
    </div>
  );
});

/**
 * 按 group 切段：相邻同组行归为一段，段前带一个小标题。
 * 没有 group 的行（通用 / 列表 / 布局…）整段落在同一个无名分组里，渲染结果与原来一致。
 */
const chunkByGroup = (rows: SettingRow[]): { group: string | null; items: SettingRow[] }[] => {
  const chunks: { group: string | null; items: SettingRow[] }[] = [];
  for (const row of rows) {
    const group = row.group ?? null;
    const last = chunks[chunks.length - 1];
    if (last && last.group === group) last.items.push(row);
    else chunks.push({ group, items: [row] });
  }
  return chunks;
};

/** 分组节点的 key：分组名只在分区内唯一（「视图」这类名字多个分区都有） */
const groupKey = (section: SettingsSection, group: string | null) => `${section}::${group ?? ""}`;

/**
 * AI 访问三档的分段选项：与「单篇笔记 / 分组」用的是同一套文案（AI_ACCESS_LABELS），
 * 数值在 onChange 里转回 number，档位类型只认 0/1/2。
 */
const ACCESS_LEVEL_OPTIONS: EnumOption[] = ([0, 1, 2] as AiAccessLevel[]).map((level) => ({
  value: String(level),
  label: AI_ACCESS_LABELS[level],
}));

/** 运行期间自动检查更新的间隔选项（分钟）；0 = 关闭，默认值与 appDefaults 保持一致 */
const UPDATE_CHECK_INTERVAL_OPTIONS: EnumOption[] = [
  { value: "0", label: "关闭" },
  { value: "5", label: "5 分钟" },
  { value: "10", label: "10 分钟" },
  { value: "15", label: "15 分钟" },
  { value: "30", label: "30 分钟" },
  { value: "60", label: "1 小时" },
];

/* ---------- 备份工具函数 ---------- */

/** 备份文件名里的时间戳：20261006-1930 */
const fileStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** ISO 时间去秒，展示成 2026-10-06 19:30；缺值或非法日期显示「未知」 */
const prettyTime = (iso: string | null) => {
  if (!iso) return t("未知");
  const d = new Date(iso);
  // new Date 对非法字符串不抛错，只会得到 Invalid Date，必须显式判断
  if (Number.isNaN(d.getTime())) return t("未知");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 取路径最后一段文件名：兼容 Windows 反斜杠与 POSIX 斜杠 */
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行提示文案 */
const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

/** 生成提示词条目的唯一 id：时间戳 + 随机后缀，避免同一毫秒内连续添加时撞号 */
const newPromptId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ---------- 主组件 ---------- */

/**
 * 统一的「设置」窗口。
 *
 * - 锚点式布局：左侧目录（跟随滚动高亮）+ 右侧设置项，点击目录平滑滚动。
 * - 固定宽高（860×600，小屏按视口收缩）；顶部搜索可过滤设置项，无命中的分区自动隐藏。
 * - 设置项区分「实时生效」与「重启生效」两种作用范围。
 * - AI 服务商、AI 记忆、备份与恢复、恢复默认、关于都是内嵌面板，共用同一套目录与搜索。
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  defaultSection,
  appSettings,
  onAppSettingChange,
  onResetAppSettings,
  onResetEditorSettings,
  onResetThemeSettings,
  aiSettings,
  onAiSettingsChange,
  aiProviders,
  aiSelectedProviderId,
  onAiProvidersChange,
  onAiSelectedProviderChange,
  aiPrompts,
  onAiPromptsChange,
  categories = [],
  notes = [],
  onSetCategoryAiAccess,
  onSetNoteAiAccess,
  theme,
  onThemeChange,
  onRequestRootPasswordChange,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const guard = useActionGuard();
  const updater = useUpdater();

  /** 搜索关键词：非空时只渲染命中的分区与行 */
  const [query, setQuery] = useState("");
  /** 关于页「作者」的连续点击时间戳：5 次 / 2 秒内触发隐藏的根密码修改入口 */
  const authorClicksRef = useRef<number[]>([]);
  // 关闭设置窗就清空计数：下次打开不该接着上一次的点击数（组件常驻，不会随关闭卸载）
  useEffect(() => {
    if (!isOpen) authorClicksRef.current = [];
  }, [isOpen]);
  const handleAuthorClick = () => {
    if (!onRequestRootPasswordChange) return;
    const now = Date.now();
    const clicks = authorClicksRef.current.filter((at) => now - at < 2000);
    clicks.push(now);
    authorClicksRef.current = clicks;
    if (clicks.length >= 5) {
      authorClicksRef.current = [];
      onRequestRootPasswordChange();
    }
  };
  /** 「AI 访问权限」里展开了哪些分组（key 为分组 id，未分类用 UNCATEGORIZED_KEY） */
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set());
  const toggleCategory = (key: number) =>
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /**
   * 当前显示的分区。**一次只渲染这一个**：设置项加起来有几百行，全量挂载既拖慢打开速度，
   * 也会让 ThemePanel / 服务商 / 访问权限这些带副作用的子面板白白运行。
   */
  const [active, setActive] = useState<SettingsSection>(defaultSection ?? "general");
  /** 当前分区里滚到的二级分组（目录里的子项高亮），null 表示还在最上面 */
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  /** 关于页：软件名与版本（版本由 Tauri 自动获取） */
  const [appName, setAppName] = useState(APP_NAME_FALLBACK);
  const [appVersion, setAppVersion] = useState("");

  /** 右侧滚动容器：切换分区时归零，也用于滚动反查二级分组 */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 当前分区内各分组段的节点：二级目录跳转与高亮反查都靠它 */
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});
  /** 左侧目录容器（高亮项自动滚进可视区） */
  const navRef = useRef<HTMLElement>(null);
  /** 滚动事件的 rAF 句柄：一帧只反查一次，避免高频 setState */
  const scrollRafRef = useRef<number | null>(null);

  /* 记忆编辑的本地草稿：未点「添加」前不写库 */
  const [memoryDraft, setMemoryDraft] = useState("");
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [editingPromptText, setEditingPromptText] = useState("");

  /* 备份操作的进行中状态：非 null 时禁用导出/导入按钮，防止并发 */
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const [lastExport, setLastExport] = useState<{ summary: BackupSummary; path: string } | null>(null);
  /** 导出备份时是否一并写入 AI 服务商 API Key（JSON 为明文，SQLite 为本机加密值） */
  const [backupIncludeApiKey, setBackupIncludeApiKey] = useState(false);
  /** 导出备份时是否一并写入 WebDAV 配置（JSON 含明文密码，SQLite 保留本机密文） */
  const [backupIncludeWebdav, setBackupIncludeWebdav] = useState(false);
  /**
 * 备份格式：JSON 适合换机迁移，SQLite 是整库快照、适合本机快速备份，
 * 加密备份（.fnbak）在整库快照外再套一层独立备份口令，连加密笔记一起带走。
 */
  const [backupFormat, setBackupFormat] = useState<"json" | "sqlite" | "encrypted">("json");
  /** 加密备份的口令弹窗：选完文件/确认覆盖后才弹，取消则整个操作作废 */
  const [backupPassphrase, setBackupPassphrase] = useState<{
    mode: "export" | "import";
    path: string;
  } | null>(null);

  /* 顶部「已保存」提示：平时隐藏，发生修改后短暂出现 */
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimerRef = useRef<number | null>(null);
  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    // 连续修改时不叠加定时器，只把消失时间往后推
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      setSavedFlash(false);
      savedTimerRef.current = null;
    }, 2000);
  }, []);

  /** 写软件设置：改动立即上抛（App 侧同步运行时状态并落库），并闪一下「已保存」 */
  const setApp = useCallback(
    <K extends keyof AppSettings>(
      category: K,
      field: keyof AppSettings[K],
      value: boolean | number | string,
    ) => {
      onAppSettingChange(category, field as string, value);
      flashSaved();
    },
    [onAppSettingChange, flashSaved],
  );

  /** 写 AI 设置：整个对象上抛，App 侧 diff 出真正变化的字段再落库 */
  const setAi = useCallback(
    <K extends keyof AiSettings>(field: K, value: AiSettings[K]) => {
      onAiSettingsChange({ ...aiSettings, [field]: value });
      flashSaved();
    },
    [aiSettings, onAiSettingsChange, flashSaved],
  );

  /**
   * 数据驱动的设置行：文案、搜索关键词、当前值与写回回调集中声明。
   * 依赖其他开关的行（AI 面板、开机后最小化）用展开运算符条件插入；
   * 依赖数组是设置值本身，任一改动都会重建数组，行数很少，成本可忽略。
   *
   * 「编辑器」分区的行不在这里逐条写：全部由 config/editorSettingSpecs.ts 的规格表生成，
   * 新增一项只改那张表，弹窗与落库同时生效。
   */
  const rows: SettingRow[] = useMemo(() => {
    const editor = appSettings.editor;
    /** 规格 → 设置行：按 kind 取对应类型的值，写回统一走 setApp；依赖未满足的整行不出现 */
    const editorRows: SettingRow[] = EDITOR_SETTING_SPECS.filter(
      (spec) => !spec.hiddenWhen?.(editor),
    ).map((spec) => {
      const base = {
        section: "editor" as const,
        group: spec.group,
        title: spec.title,
        desc: spec.desc,
        keywords: spec.keywords,
        scope: "live" as const,
      };
      if (spec.kind === "toggle") {
        return {
          ...base,
          kind: "toggle",
          value: editor[spec.field] as boolean,
          onChange: (v: boolean) => setApp("editor", spec.field, v),
        };
      }
      if (spec.kind === "number") {
        return {
          ...base,
          kind: "number",
          value: editor[spec.field] as number,
          min: spec.min,
          max: spec.max,
          step: spec.step,
          unit: spec.unit,
          onChange: (v: number) => setApp("editor", spec.field, v),
        };
      }
      if (spec.kind === "color") {
        return {
          ...base,
          kind: "color",
          value: editor[spec.field] as string,
          onChange: (v: string) => setApp("editor", spec.field, v),
        };
      }
      if (spec.kind === "colorList") {
        return {
          ...base,
          kind: "colorList",
          value: editor[spec.field] as string,
          placeholder: spec.placeholder,
          onChange: (v: string) => setApp("editor", spec.field, v),
        };
      }
      // segment 与 select 的行形状相同（value + options），只是渲染控件不同。
      // 选项值统一是字符串，但 Tab 宽度这类字段在设置对象里是 number：
      // 展示时转成字符串，写回时再转回 number，否则分段按钮选不中、落库后也读不回来。
      const numeric = typeof DEFAULT_EDITOR_SETTINGS[spec.field] === "number";
      const raw = editor[spec.field] as string | number;
      return {
        ...base,
        kind: spec.kind,
        value: numeric ? String(raw) : (raw as string),
        options: spec.options,
        onChange: (v: string) => setApp("editor", spec.field, numeric ? Number(v) : v),
      };
    });

    return [
      {
        section: "general",
        kind: "select",
        scope: "live",
        title: "语言",
        desc: "统一应用到软件和编辑器；跟随系统时自动使用系统语言。",
        keywords: "语言 language locale 简体中文 English system",
        value: appSettings.general.language ?? "system",
        options: [
          { value: "system", label: "跟随系统" },
          { value: "zh-CN", label: "简体中文" },
          { value: "en-US", label: "English" },
        ],
        onChange: (v) => setApp("general", "language", v),
      },
      {
        section: "general",
        kind: "toggle",
        scope: "startup",
        title: "启动时清空回收站",
        desc: "每次打开软件时，永久删除回收站里的全部笔记（不可恢复）。",
        keywords: "回收站 清空 清理 垃圾 startup",
        value: appSettings.general.cleanTrashOnStartup,
        onChange: (v) => setApp("general", "cleanTrashOnStartup", v),
      },
      {
        section: "general",
        kind: "toggle",
        scope: "startup",
        danger: true,
        title: "启用单例模式",
        desc: "开启后同一时间只允许运行一个软件进程：再次双击启动时不会再开新窗口，而是把已运行的窗口叫到前台。关闭后可以同时打开多个进程，但多个进程会同时读写同一个笔记数据库，极易互相覆盖、导致笔记保存失败或内容丢失，请确认清楚再关闭（默认开启）。",
        keywords: "单例 多开 多进程 实例 single instance 单实例 重复启动",
        value: appSettings.general.singleInstance,
        onChange: (v) => setApp("general", "singleInstance", v),
      },
      {
        section: "general",
        kind: "toggle",
        scope: "live",
        title: "开启 AI 能力",
        desc: "开启后可为软件开启 AI 能力，但本软件默认不联网，如果开启需要联网与 AI 进行通信，AI 可能会读取所有笔记内容。请注意个人隐私与笔记安全。",
        keywords: "AI 能力 开关 enable",
        value: appSettings.general.enableAI,
        onChange: (v) => setApp("general", "enableAI", v),
      },
      {
        section: "general",
        kind: "number",
        scope: "live",
        title: "最近历史版本保留数",
        desc: "每篇笔记保留多少个最近自动版本；最早一版始终额外保留，过去 30 天每天也会留一条，方便找回最初内容。手动「存版本」与固定的版本不计入上限、不会被自动清理。改小后，已有笔记会在下次编辑时收敛到新上限。",
        keywords: "历史 版本 回滚 history version 快照 上限 固定",
        value: appSettings.general.noteHistoryLimit,
        min: 1,
        max: 100,
        unit: "个",
        onChange: (v) => setApp("general", "noteHistoryLimit", v),
      },
      {
        section: "general",
        kind: "number",
        scope: "live",
        title: "自动历史版本间隔",
        desc: "自动保存不会每次都记历史：距上一条历史满这个间隔才再记一条，内容没有变化也不重复记；打开笔记时的基线与手动「存版本」不受此间隔限制。调小记录更细，但更早的版本会被更快挤出保留窗口；调大更省空间，中间过程记录更少。",
        keywords: "历史 版本 间隔 快照 history interval",
        value: appSettings.general.noteHistoryIntervalMinutes,
        min: 1,
        max: 60,
        unit: "分钟",
        onChange: (v) => setApp("general", "noteHistoryIntervalMinutes", v),
      },
      {
        section: "general",
        kind: "number",
        scope: "live",
        title: "空闲自动锁定",
        desc: "超过这段时间没有任何键盘、鼠标或滚轮操作，就清空内存里的解密密钥：已解锁的加密笔记与分组会回到锁定态，需要重新输入密码。设为 0 表示不自动锁定。",
        keywords: "加密 锁定 自动 lock idle 离开 安全 密码",
        value: appSettings.general.autoLockMinutes,
        min: 0,
        max: 120,
        step: 5,
        unit: "分钟",
        onChange: (v) => setApp("general", "autoLockMinutes", v),
      },
      ...editorRows,
      {
        section: "view",
        kind: "segment",
        scope: "live",
        title: "默认排序字段",
        desc: "笔记列表默认按照哪个字段排序。",
        keywords: "排序 sort 创建 更新 标题",
        value: appSettings.view.sortBy,
        options: [
          { value: "created_at", label: "创建时间" },
          { value: "updated_at", label: "更新时间" },
          { value: "title", label: "标题" },
        ],
        onChange: (v) => setApp("view", "sortBy", v),
      },
      {
        section: "view",
        kind: "segment",
        scope: "live",
        title: "排序方向",
        desc: "升序（由早到晚 / A→Z）或降序。",
        keywords: "排序 方向 升序 降序 asc desc",
        value: appSettings.view.sortOrder,
        options: [
          { value: "asc", label: "升序" },
          { value: "desc", label: "降序" },
        ],
        onChange: (v) => setApp("view", "sortOrder", v as "asc" | "desc"),
      },
      {
        section: "layout",
        kind: "toggle",
        scope: "startup",
        title: "启动时折叠分组侧边栏",
        desc: "只是启动时的布局状态，不跟随运行时的折叠操作；下次打开软件才会生效。",
        keywords: "侧边栏 折叠 sidebar 布局 启动",
        value: appSettings.layout.sidebarCollapsed,
        onChange: (v) => setApp("layout", "sidebarCollapsed", v),
      },
      // 依赖 enableAI：关闭 AI 能力时不出现这个「启动时打开面板」的开关
      ...(appSettings.general.enableAI
        ? [
            {
              section: "layout" as const,
              kind: "toggle" as const,
              scope: "startup" as const,
              title: "启动时打开 AI 对话面板",
              desc: "只是启动时的布局状态，不跟随运行时的开关操作；下次打开软件才会生效。",
              keywords: "ai 面板 对话 布局 panel 启动",
              value: appSettings.layout.aiPanelOpen,
              onChange: (v: boolean) => setApp("layout", "aiPanelOpen", v),
            },
          ]
        : []),

      // ---- 托盘与开机自启动：归属「通用」分区 ----
      {
        section: "general",
        kind: "toggle",
        scope: "live",
        title: "显示托盘图标",
        desc: "开启后，关闭窗口时软件将最小化到托盘；托盘图标的右键菜单可直接退出软件。",
        keywords: "托盘 tray 图标 最小化 通知区",
        value: appSettings.general.trayEnabled,
        onChange: (v) => setApp("general", "trayEnabled", v),
      },
      // 未开启托盘时关闭按钮只会直接退出，这一项无从选择，整行不出现
      ...(appSettings.general.trayEnabled
        ? [
            {
              section: "general" as const,
              kind: "segment" as const,
              scope: "live" as const,
              title: "关闭窗口时",
              desc: "点击窗口关闭按钮时的行为。最小化到托盘：隐藏窗口但保留托盘图标；直接退出：关闭软件。",
              keywords: "关闭 退出 minimize exit 行为 托盘",
              value: appSettings.general.closeBehavior,
              options: [
                { value: "minimize", label: "最小化到托盘" },
                { value: "exit", label: "直接退出" },
              ],
              onChange: (v: string) => setApp("general", "closeBehavior", v),
            },
          ]
        : []),
      {
        section: "general",
        kind: "toggle",
        scope: "startup",
        title: "开机自启动",
        desc: "计算机启动时自动运行 FastNote。",
        keywords: "开机 自启动 boot autostart",
        value: appSettings.general.autostart,
        onChange: (v) => setApp("general", "autostart", v),
      },
      // 开机后最小化到托盘同时依赖「开机自启动」与「托盘图标」，缺一个就整行隐藏
      ...(appSettings.general.autostart && appSettings.general.trayEnabled
        ? [
            {
              section: "general" as const,
              kind: "toggle" as const,
              scope: "startup" as const,
              title: "开机后最小化到托盘",
              desc: "开启：开机自启动后不弹出主窗口，只在托盘显示图标，点击托盘图标再打开。关闭：开机后正常显示窗口。",
              keywords: "开机 自启动 最小化 tray 后台",
              value: appSettings.general.minimizeToTray,
              onChange: (v: boolean) => setApp("general", "minimizeToTray", v),
            },
          ]
        : []),

      // ---- chat：对话行为与请求参数 ----
      {
        section: "chat",
        kind: "number",
        scope: "live",
        title: "深度思考最少字数",
        desc: "低于这个字数会提醒模型重新深入思考（0 表示不限制）。",
        keywords: "思考 thinking 字数",
        value: aiSettings.minThinkingLen,
        min: 0,
        max: 1000,
        step: 10,
        unit: "字",
        onChange: (v) => setAi("minThinkingLen", v),
      },
      {
        section: "chat",
        kind: "number",
        scope: "live",
        title: "最多工具轮数",
        desc: "一次提问里模型最多连续调用几轮工具；0 表示不限制。",
        keywords: "工具 轮数 rounds tool",
        value: aiSettings.maxRounds,
        min: 0,
        max: 200,
        unit: "轮",
        onChange: (v) => setAi("maxRounds", v),
      },
      {
        section: "chat",
        kind: "number",
        scope: "live",
        title: "最大输出长度",
        desc: "单次回复最多生成多少 token；调大能明显减少「长文被截断」。",
        keywords: "输出 token 长度 截断 maxtokens",
        value: aiSettings.maxTokens,
        min: 256,
        max: 32000,
        step: 512,
        unit: "token",
        onChange: (v) => setAi("maxTokens", v),
      },
      {
        section: "chat",
        kind: "toggle",
        scope: "live",
        title: "思考过浅时重来一次",
        desc: "关闭后直接采纳模型的回答，不再要求重写（响应更快）。",
        keywords: "思考 重试 retry",
        value: aiSettings.retryShallowThinking,
        onChange: (v) => setAi("retryShallowThinking", v),
      },
      {
        section: "chat",
        kind: "toggle",
        scope: "live",
        title: "流式输出",
        desc: "边生成边显示；关闭后等整段生成完再一次性显示。",
        keywords: "流式 streaming 输出",
        value: aiSettings.streaming,
        onChange: (v) => setAi("streaming", v),
      },
      {
        section: "chat",
        kind: "toggle",
        scope: "live",
        title: "自动生成会话标题",
        desc: "首轮对话后自动用一句话概括，关闭后标题保持「新对话」。",
        keywords: "标题 title 自动",
        value: aiSettings.autoTitle,
        onChange: (v) => setAi("autoTitle", v),
      },
      {
        section: "chat",
        kind: "toggle",
        scope: "live",
        title: "默认开启操作确认",
        desc: "写操作（创建/修改/删除）执行前先弹确认框，面板里仍可临时切换。标签操作不在此列：AI 打标签、删自己建的标签一律直接执行。",
        keywords: "确认 confirm 操作 标签",
        value: aiSettings.confirmByDefault,
        onChange: (v) => setAi("confirmByDefault", v),
      },
      {
        section: "chat",
        kind: "toggle",
        scope: "live",
        title: "显示工具执行轨迹",
        desc: "在回复上方逐条显示执行过的工具，可展开查看参数与结果。",
        keywords: "工具 轨迹 trace 执行",
        value: aiSettings.showToolTrace,
        onChange: (v) => setAi("showToolTrace", v),
      },
      // ---- context：上下文压缩与裁剪 ----
      {
        section: "context",
        kind: "number",
        scope: "live",
        title: "上下文预算",
        desc: "历史超过这个规模就把更早的对话压成摘要，避免上下文过长。",
        keywords: "上下文 context token 预算",
        value: aiSettings.contextBudget,
        min: 2000,
        max: 200000,
        step: 1000,
        unit: "token",
        onChange: (v) => setAi("contextBudget", v),
      },
      {
        section: "context",
        kind: "number",
        scope: "live",
        title: "始终保留最近消息",
        desc: "无论上下文多长，最近这么多条消息都完整保留。",
        keywords: "上下文 保留 keep 消息",
        value: aiSettings.keepRecent,
        min: 2,
        max: 50,
        unit: "条",
        onChange: (v) => setAi("keepRecent", v),
      },
      {
        section: "context",
        kind: "number",
        scope: "live",
        title: "工具结果注入上限",
        desc: "单个工具结果最多带多少字进上下文，超出只保留开头。",
        keywords: "工具 结果 上限 toolresult",
        value: aiSettings.toolResultChars,
        min: 200,
        max: 20000,
        step: 100,
        unit: "字",
        onChange: (v) => setAi("toolResultChars", v),
      },
      {
        section: "access",
        kind: "toggle",
        scope: "live",
        title: "允许 AI 访问笔记",
        desc: "总开关。关闭后 AI 完全看不到笔记内容：不发送当前笔记、所有笔记工具直接被拒，对话仍可正常进行。",
        keywords: "ai 访问 权限 隐私 限制 开关 access privacy permission",
        value: aiSettings.aiAccessEnabled,
        onChange: (v) => setAi("aiAccessEnabled", v),
      },
      // AI 无法访问笔记时，「新建默认权限」无处生效，两行一并隐藏
      ...(aiSettings.aiAccessEnabled
        ? [
            {
              section: "access" as const,
              kind: "segment" as const,
              scope: "live" as const,
              title: "新建笔记默认权限",
              desc:
                "之后新建的笔记以此档位开局：软件里新建、另存为笔记、导入文件，以及 AI 创建笔记都算。已有笔记不受影响，建好后仍可在「笔记属性」里单独改。",
              keywords: "默认 新建 笔记 权限 档位 note default",
              value: String(aiSettings.defaultNoteAiAccess),
              options: ACCESS_LEVEL_OPTIONS,
              onChange: (v: string) => setAi("defaultNoteAiAccess", Number(v) as AiAccessLevel),
            },
            {
              section: "access" as const,
              kind: "segment" as const,
              scope: "live" as const,
              title: "新建分组默认权限",
              desc:
                "之后新建的分组（含 AI 创建的分组）以此档位开局。分组档位是组内笔记的上限，设成「只读」时组内笔记再怎么写也超不过它。",
              keywords: "默认 新建 分组 权限 档位 category default",
              value: String(aiSettings.defaultCategoryAiAccess),
              options: ACCESS_LEVEL_OPTIONS,
              onChange: (v: string) => setAi("defaultCategoryAiAccess", Number(v) as AiAccessLevel),
            },
          ]
        : []),
    ];
  }, [appSettings, aiSettings, setApp, setAi, t]);

  /**
   * 未分类笔记：没有分组可继承，只能逐篇设。
   * 弹窗关闭时本组件仍挂载（保留状态），这里用 isOpen 兜底，避免关着也白算一遍。
   */
  const uncategorized = useMemo(
    // 加密笔记对 AI 恒为禁止档，不参与权限设置
    () => (isOpen ? notes.filter((n) => !n.is_deleted && n.category_id === null && n.enc_mode === 0) : []),
    [notes, isOpen],
  );

  /**
   * 「AI 访问权限」分区的数据：按分组把笔记分桶，并预先算出被分组档位压低的篇数。
   * 原实现在渲染里对每个分组都 notes.filter 一遍（O(分组数 × 笔记数)），
   * 而弹窗的搜索输入、开关改动都会触发重渲染，笔记一多就会明显拖慢。
   */
  const accessByCategory = useMemo(
    () =>
      isOpen
        ? new Map(
            // 加密分组及其笔记对 AI 恒为禁止档，权限分区里直接不列出
            categories.filter((c) => !c.is_encrypted).map((c) => {
              const rows = notes.filter((n) => !n.is_deleted && n.enc_mode === 0 && n.category_id === c.id);
              return [c.id, { rows, capped: rows.filter((n) => n.ai_access > c.ai_access).length }] as const;
            }),
          )
        : new Map<number, { rows: typeof notes; capped: number }>(),
    [categories, notes, isOpen],
  );

  /* 搜索过滤：q 为归一化后的关键词，空串表示不过滤 */
  const q = query.trim().toLowerCase();

  /**
   * 自定义面板的可搜索文案：这些面板的内容不是 SettingRow，取不到行级关键词，
   * 因此按分区手写词表；服务商名称随 aiProviders 变化，所以放进 useMemo。
   */
  const customSearch = useMemo<Record<string, string>>(
    () => ({
      provider:
        "服务商 模型 api key 密钥 openai google claude 接口 base url http " +
        aiProviders.map((p) => p.name).join(" "),
      theme:
        "主题 配色 颜色 取色 色盘 暗黑 暗色 深色 浅色 夜间 预设 自定义 圆角 外观 theme color palette dark light appearance radius preset",
      semantic:
        "语义搜索 语义 向量 embedding 向量检索 模型 本地模型 推荐 多语言 bge minilm 下载 索引 重建 自动 自动索引 增量 启用 开关 index semantic vector model onnx 离线 相似 近似",
      shortcuts:
        "快捷键 键位 按键 组合键 键盘 ctrl cmd shift alt 跳转 命令面板 shortcut shortcuts keymap hotkey keyboard ctrl+p ctrl+shift+p",
      toolbox:
        "工具箱 下载 下载器 链接 url http https 线程 并发 分段 文件 目录 download downloader threads",
      memory: "记忆 提示词 prompt 长期记忆 前置 要求 memory",
      access: "访问 权限 分组 笔记 ai 隐私 限制 禁止 只读 完全 三档 access permission privacy readonly category note",
      reset: "恢复默认 重置 出厂值 reset default",
      backup:
        "备份 恢复 导出 导入 数据 json sqlite db 数据库 快照 迁移 加密 口令 fnbak 加密备份 webdav 云同步 云端 网盘 nextcloud 群晖 坚果云 alist 自动备份 服务器 账号 密码 文件夹 backup restore cloud sync encrypted passphrase",
      about:
        "关于 版本 作者 应用名 图标 开源项目 开源 about version author name iconfont opensource",
    }),
    [aiProviders],
  );

  /**
   * 可见分区：先按 enableAI 剔除 AI 分区，再按搜索词过滤。
   * 自定义面板匹配「分区名 + 关键词表」，普通分区只要任一子行命中就整段保留。
   */
  const visibleSections = useMemo(
    () =>
      SECTIONS.filter((s) => {
        if (!appSettings.general.enableAI && AI_SECTION_KEYS.includes(s.key)) {
          return false;
        }
        if (!q || `${s.label} ${t(s.label)}`.toLowerCase().includes(q)) return true;
        if (CUSTOM_KEYS.includes(s.key)) {
          return `${s.label} ${t(s.label)} ${customSearch[s.key] ?? ""}`.toLowerCase().includes(q);
        }
        return rows.some(
          (r) => r.section === s.key && `${r.title} ${t(r.title)} ${r.desc} ${t(r.desc)} ${r.group ? t(r.group) : ""} ${r.keywords ?? ""} ${"options" in r ? r.options.map((o) => t(o.label)).join(" ") : ""}`.toLowerCase().includes(q),
        );
      }),
    [q, rows, customSearch, appSettings.general.enableAI, t],
  );

  /** 某分区下命中搜索的行；没有关键词时返回该分区全部行 */
  const visibleRowsOf = useCallback(
    (section: SettingsSection) =>
      rows.filter(
        (r) =>
          r.section === section &&
          (!q || SECTIONS.some((s) => s.key === section && `${s.label} ${t(s.label)}`.toLowerCase().includes(q)) || `${r.title} ${t(r.title)} ${r.desc} ${t(r.desc)} ${r.group ? t(r.group) : ""} ${r.keywords ?? ""} ${"options" in r ? r.options.map((o) => t(o.label)).join(" ") : ""}`.toLowerCase().includes(q)),
      ),
    [rows, q, t],
  );

  /** 分区的二级分组（按行顺序去重）；空数组表示这个分区在目录里是叶子节点 */
  const groupsOf = useCallback(
    (section: SettingsSection) => {
      const out: string[] = [];
      for (const row of visibleRowsOf(section)) {
        if (row.group && !out.includes(row.group)) out.push(row.group);
      }
      return out;
    },
    [visibleRowsOf],
  );

  /**
   * 右侧实际渲染的分区：**只有一个**（当前选中的那个）。
   * 搜索把当前分区过滤掉时先渲染第一个命中的，随后的 effect 会把 active 同步过去。
   */
  const shownSections = useMemo(() => {
    const meta = visibleSections.find((s) => s.key === active) ?? visibleSections[0];
    return meta ? [meta] : [];
  }, [visibleSections, active]);

  /* 打开时：重置搜索与滚动位置，并切到目标分区 */
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSavedFlash(false);
    setActive(defaultSection ?? "general");
    setActiveGroup(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [isOpen, defaultSection]);

  /* 关于页：打开设置时读取应用名与版本号 */
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    Promise.all([getName(), getVersion()])
      .then(([name, version]) => {
        if (cancelled) return;
        if (name) setAppName(name);
        setAppVersion(version);
      })
      .catch((e) => console.error("读取应用信息失败:", e));
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  /* 搜索变化后，把高亮收回到首个可见分区 */
  useEffect(() => {
    if (!isOpen) return;
    if (visibleSections.length === 0) return;
    if (!visibleSections.some((s) => s.key === active)) {
      setActive(visibleSections[0].key);
    }
  }, [visibleSections, isOpen, active]);

  /**
   * 切换分区：右侧换内容、滚动位置归零。
   * 只渲染当前分区，所以这里不需要"滚动到锚点"，只要把容器拉回顶部。
   */
  const selectSection = useCallback((key: SettingsSection) => {
    setActive(key);
    setActiveGroup(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  /* 滚动监听：只反查当前分区内的二级分组，让目录里的子项高亮跟着走 */
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = contentRef.current;
      if (!container) return;
      const groups = groupsOf(active);
      if (groups.length === 0) {
        setActiveGroup(null);
        return;
      }
      const top = container.scrollTop + 20;
      let group: string | null = null;
      for (const name of groups) {
        const el = groupRefs.current[groupKey(active, name)];
        if (el && el.offsetTop <= top) group = name;
      }
      setActiveGroup(group);
    });
  }, [active, groupsOf]);

  /** 二级目录：跳到当前分区里的某个分组 */
  const scrollToGroup = useCallback((section: SettingsSection, group: string) => {
    const container = contentRef.current;
    const el = groupRefs.current[groupKey(section, group)];
    if (!container || !el) return;
    setActiveGroup(group);
    container.scrollTo({ top: Math.max(0, el.offsetTop - 8) });
  }, []);

  /** 高亮项自动滚进目录可视区（分组很多时，滚到下面的分区目录也能跟得上） */
  useEffect(() => {
    if (!isOpen) return;
    const nav = navRef.current;
    const selector = activeGroup ? `[data-nav-key="${active}:${activeGroup}"]` : `[data-nav-key="${active}"]`;
    const el = nav?.querySelector<HTMLElement>(selector);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, activeGroup, isOpen]);

  /* 卸载时清掉挂起的 timer 与 rAF，避免回调打到已卸载的组件上 */
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  /* 记忆：增删改都立即上抛新数组，写库与生效由 App 负责 */
  const addPrompt = () => {
    const text = memoryDraft.trim();
    if (!text) return;
    onAiPromptsChange([...aiPrompts, { id: newPromptId(), text, enabled: true }]);
    setMemoryDraft("");
    flashSaved();
  };

  const togglePrompt = (id: string) => {
    onAiPromptsChange(aiPrompts.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)));
    flashSaved();
  };

  const removePrompt = (id: string) => {
    onAiPromptsChange(aiPrompts.filter((e) => e.id !== id));
    flashSaved();
  };

  const savePromptEdit = () => {
    const text = editingPromptText.trim();
    if (!text) {
      setEditingPromptId(null);
      return;
    }
    onAiPromptsChange(aiPrompts.map((e) => (e.id === editingPromptId ? { ...e, text } : e)));
    setEditingPromptId(null);
    flashSaved();
  };

  /** 导出：先让用户选保存路径（取消则返回），再交给后端写文件；失败只弹提示 */
  const handleExport = async () => {
    const isSqlite = backupFormat === "sqlite";
    const isEncrypted = backupFormat === "encrypted";
    try {
      const path = await save({
        defaultPath: `fastnote-backup-${fileStamp()}.${isEncrypted ? "fnbak" : isSqlite ? "db" : "json"}`,
        filters: [
          isEncrypted
            ? { name: t("FastNote 加密备份"), extensions: ["fnbak"] }
            : isSqlite
              ? { name: t("SQLite 数据库备份"), extensions: ["db", "sqlite"] }
              : { name: t("FastNote 备份"), extensions: ["json"] },
        ],
      });
      if (!path) return;
      // 加密备份还要口令：先记下路径，等弹窗确认后再真正写文件
      if (isEncrypted) {
        setBackupPassphrase({ mode: "export", path });
        return;
      }
      // 主题落库有防抖：导出前把最后一次改动冲下去，避免备份里少了刚改的主题
      await flushThemeSettings();
      setBackupBusy("export");
      const summary = isSqlite
        ? await exportSqliteBackup(path, backupIncludeApiKey, backupIncludeWebdav)
        : await exportBackup(path, backupIncludeApiKey, backupIncludeWebdav);
      setLastExport({ summary, path });
      const extras = [
        backupIncludeApiKey ? (isSqlite ? t("本机加密 Key") : "API Key") : "",
        backupIncludeWebdav ? t("WebDAV 配置") : "",
      ].filter(Boolean);
      const keyNote = extras.length ? t("（含{value1}）", { value1: extras.join(getLocale() === "zh-CN" ? "、" : ", ") }) : "";
      showToast(t("已导出 {notes} 篇笔记{keyNote}", { notes: summary.notes, keyNote: keyNote }), "success");
      if (summary.skipped_encrypted > 0) {
        showToast(t("备份已跳过 {count} 篇加密笔记", { count: summary.skipped_encrypted }), "info");
      }
    } catch (e) {
      showToast(t("导出失败：{value1}", { value1: errorText(e) }), "error");
    } finally {
      setBackupBusy(null);
    }
  };

  /**
   * 加密备份：口令由弹窗收集，这里只负责调用后端。
   * 失败直接抛出，让弹窗原地显示错误（口令错要能重试），不再额外弹 toast。
   */
  const runEncryptedExport = async (passphrase: string) => {
    const path = backupPassphrase?.path;
    if (!path) return;
    // 主题落库有防抖：导出前把最后一次改动冲下去
    await flushThemeSettings();
    setBackupBusy("export");
    try {
      const summary = await exportEncryptedBackup(path, passphrase);
      setLastExport({ summary, path });
      showToast(t("已导出加密备份：{notes} 篇笔记（含加密笔记与密钥元数据）", { notes: summary.notes }), "success");
    } finally {
      setBackupBusy(null);
    }
  };

  /**
   * 导入：覆盖式恢复，必须先二次确认（数据不可撤销）；
   * 成功后延迟 800ms 再整页 reload，一是让提示能被看到，二是让各 store 重新从库里读。
   */
  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: t("FastNote 备份"), extensions: ["json", "db", "sqlite", "fnbak"] },
        ],
      });
      if (!selected || typeof selected !== "string") return;

      const lower = selected.toLowerCase();
      const isEncrypted = lower.endsWith(".fnbak");
      const isSqlite = lower.endsWith(".db") || lower.endsWith(".sqlite");
      const formatLabel = isEncrypted
        ? t("加密容器")
        : isSqlite
          ? t("SQLite 数据库")
          : "JSON";
      const ok = await confirm({
        title: t("从备份恢复"),
        message: t("恢复会用{formatLabel}备份覆盖当前的**全部**笔记、分组、回收站、AI 对话记录与设置。当前数据将被清空，无法撤销，建议先导出一份备份。\n\n备份文件：{value2}", { formatLabel: formatLabel, value2: baseName(selected) }),
        confirmText: t("覆盖并恢复"),
        danger: true,
      });
      if (!ok) return;

      // 加密备份覆盖前先问口令：口令错就原地重试，不会碰到现有数据
      if (isEncrypted) {
        setBackupPassphrase({ mode: "import", path: selected });
        return;
      }

      // 主题有防抖写入：先冲掉旧改动，导入后再由备份内容覆盖，避免旧主题回写
      await flushThemeSettings();
      setBackupBusy("import");
      const summary = isSqlite
        ? await importSqliteBackup(selected)
        : await importBackup(selected);
      showToast(t("恢复完成：{notes} 篇笔记，界面即将刷新", { notes: summary.notes }), "success");
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setBackupBusy(null);
      // 加密相关的拒绝是带 code 的 JSON 字符串，直接展示会让用户看到 {"code":...}
      const raw = errorText(e);
      const friendly = raw.includes("local_has_encrypted")
        ? t("当前库存在加密内容，恢复会丢失密钥，已取消")
        : raw.includes("backup_contains_encrypted")
          ? t("备份包含加密内容，无法恢复")
          : raw;
      showToast(t("恢复失败：{value1}", { value1: friendly }), "error");
    }
  };

  /** 加密备份恢复：口令由弹窗收集；失败抛出给弹窗显示，成功后才整页刷新 */
  const runEncryptedImport = async (passphrase: string) => {
    const path = backupPassphrase?.path;
    if (!path) return;
    await flushThemeSettings();
    setBackupBusy("import");
    try {
      const summary = await importEncryptedBackup(path, passphrase);
      showToast(t("恢复完成：{notes} 篇笔记，界面即将刷新", { notes: summary.notes }), "success");
      setTimeout(() => window.location.reload(), 800);
    } finally {
      setBackupBusy(null);
    }
  };

  // 非模态浮窗：标题栏拖动挪位置（不落库，关掉再开回到居中）
  const drag = useDraggable(isOpen);

  // 所有 hook 都已执行完，关闭时直接不渲染（保留组件状态，下次打开不闪）
  if (!isOpen) return null;

  /** 底部统计用：启用中的记忆/提示词条数 */
  const enabledPromptCount = aiPrompts.filter((p) => p.enabled).length;

  return (
    <>
      {/* 非模态：不铺遮罩、整层 pointer-events 关掉，只有卡片本身可点——
          开着设置也能继续看笔记、点列表；点窗外不会关闭，关闭走按钮或 Esc */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={drag.panelRef}
          className="modal-content floating-panel pointer-events-auto bg-surface rounded-2xl w-[860px] h-[600px] max-w-[94vw] max-h-[92vh] flex flex-col overflow-hidden"
          style={drag.style}
        >
          {/* 头部：标题 + 自动保存提示（aria-live 供读屏播报）+ 关闭；按住可拖动窗口 */}
          <div
            className="flex items-center justify-between px-5 py-3.5 border-b border-line-soft flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
            onPointerDown={drag.startDrag}
          >
            <div className="flex items-center gap-2">
              <Icon name="ai-settings-bold" className="w-4 h-4 text-primary-500" />
              <h3 className="text-base font-semibold text-ink">{t("设置")}</h3>
            </div>
            <div className="flex items-center gap-3">
              <span
                aria-live="polite"
                className={`hidden sm:flex items-center gap-1.5 text-[11px] text-faint transition-opacity duration-500 ${
                  savedFlash ? "opacity-100" : "opacity-0"
                }`}
              >
                <Icon name="editor-check" className="w-3 h-3 text-success" />
                {t("更改已自动保存")}</span>
              <button onClick={onClose} className="toolbar-btn hover:!bg-surface-alt" title={t("关闭设置")}>
                <Icon name="modal-close" className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* 左侧目录：搜索框 + 分组导航，空分组不渲染 */}
            <div className="w-[186px] flex-shrink-0 border-r border-line-soft flex flex-col bg-app/40">
              <div className="p-2.5 flex-shrink-0">
                <div className="relative">
                  <Icon
                    name="sidebar-search"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint-soft pointer-events-none"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("搜索设置...")}
                    className="w-full pl-8 pr-2 py-1.5 text-xs input-modern"
                  />
                </div>
              </div>
              <nav ref={navRef} className="flex-1 overflow-y-auto chat-scrollbar px-2 pb-3">
                {getVisibleGroups(appSettings.general.enableAI).map((group) => {
                  const items = visibleSections.filter((s) => s.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div key={group} className="mb-1">
                      <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold text-faint-soft uppercase tracking-wider">
                        {t(group)}
                      </div>
                      {items.map((s) => {
                        const isActive = active === s.key;
                        // 二级项只列当前分区的：一次只显示一个分区，别的分区的子项没有落点
                        const subGroups = isActive ? groupsOf(s.key) : [];
                        // 搜索时把命中条数标在没被选中的分区上，省得一个个点开找
                        const hits = q ? visibleRowsOf(s.key).length : 0;
                        return (
                          <div key={s.key}>
                            <button
                              data-nav-key={s.key}
                              onClick={() => selectSection(s.key)}
                              className={`w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-xs font-medium ${
                                isActive ? "bg-primary-50 text-primary-600" : "text-muted hover:bg-surface-alt/70"
                              }`}
                            >
                              <Icon
                                name={s.icon}
                                className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "opacity-100" : "opacity-70"}`}
                              />
                              <span className="min-w-0 text-left break-words">{t(s.label)}</span>
                              {hits > 0 && !isActive && (
                                <span className="ml-auto flex-shrink-0 text-[10px] text-faint-soft">{hits}</span>
                              )}
                              {/* 叶子分区用圆点标记当前项 */}
                              {isActive && subGroups.length === 0 && (
                                <span className="ml-auto w-1 h-1 rounded-full bg-primary-500 flex-shrink-0" />
                              )}
                            </button>
                            {subGroups.length > 0 && (
                              <div className="mt-0.5 mb-1 ml-[18px] border-l border-line-soft pl-1.5">
                                {subGroups.map((name) => {
                                  const on = activeGroup === name;
                                  return (
                                    <button
                                      key={name}
                                      data-nav-key={`${s.key}:${name}`}
                                      onClick={() => scrollToGroup(s.key, name)}
                                      className={`w-full text-left px-2 py-[5px] rounded-md text-[11px] break-words ${
                                        on
                                          ? "bg-primary-50 text-primary-600 font-medium"
                                          : "text-faint hover:bg-surface-alt/70 hover:text-body"
                                      }`}
                                    >
                                      {t(name)}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {visibleSections.length === 0 && (
                  <p className="px-3 py-6 text-center text-[11px] text-faint">{t("没有匹配的设置项")}</p>
                )}
              </nav>
            </div>

            {/* 右侧内容：只挂载当前分区；滚动时反查本分区内的二级分组 */}
            <div
              ref={contentRef}
              onScroll={handleScroll}
              className="relative flex-1 min-w-0 overflow-y-auto chat-scrollbar px-6 py-5"
            >
              {shownSections.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-faint">
                  <Icon name="sidebar-search" className="w-8 h-8 text-faint-soft" />
                  <p className="text-sm">{t("没有找到相关设置")}</p>
                  <p className="text-[11px] text-faint-soft">{t("换个关键词试试")}</p>
                </div>
              ) : (
                shownSections.map((s) => {
                  const sectionRows = visibleRowsOf(s.key);
                  return (
                    <section key={s.key} data-section={s.key} className="animate-fadeIn [&>*+*]:pl-8">
                      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-line-soft">
                        <span className="w-6 h-6 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                          <Icon name={s.icon} className="w-3.5 h-3.5 text-primary-500" />
                        </span>
                        <h4 className="text-sm font-semibold text-body">{t(s.label)}</h4>
                      </div>

                      {/* 数据驱动的行：统一交给 RowView 按 kind 渲染；带 group 的分区按组分段 */}
                      {sectionRows.length > 0 && (
                        <div className="space-y-1">
                          {chunkByGroup(sectionRows).map((chunk) => (
                            <div
                              key={chunk.group ?? "_"}
                              className="divide-y divide-line-soft"
                              ref={(el) => {
                                groupRefs.current[groupKey(s.key, chunk.group)] = el;
                              }}
                            >
                              {chunk.group && (
                                <p className="pt-3 pb-1 text-[11px] font-semibold text-muted">
                                  {t(chunk.group)}
                                </p>
                              )}
                              {chunk.items.map((row) => (
                                <RowView key={`${row.section}.${row.title}`} row={row} />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 主题：明暗模式 + 预设 + 自定义取色 + 已保存主题 */}
                      {s.key === "theme" && <ThemePanel theme={theme} onChange={onThemeChange} />}

                      {/* 语义搜索：本地模型下载/删除、索引重建/取消与进度 */}
                      {s.key === "semantic" && (
                        <SemanticPanel
                          enabled={appSettings.general.semanticSearch}
                          onEnabledChange={(v) => setApp("general", "semanticSearch", v)}
                          autoIndex={appSettings.general.semanticAutoIndex}
                          onAutoIndexChange={(v) => setApp("general", "semanticAutoIndex", v)}
                          modelId={appSettings.general.semanticModel}
                          onModelChange={(id) => setApp("general", "semanticModel", id)}
                        />
                      )}

                      {/* 快捷键：全软件键位一览，按当前设置置灰不可用的项 */}
                      {s.key === "shortcuts" && <ShortcutPanel settings={appSettings} />}

                      {/* 工具箱：通用下载工具，与语义模型下载共用线程数 */}
                      {s.key === "toolbox" && (
                        <ToolboxPanel
                          threads={appSettings.general.downloadThreads}
                          onThreadsChange={(v) => setApp("general", "downloadThreads", v)}
                        />
                      )}

                      {/* AI 服务商：复用 AiProviderModal 里的面板，共用本窗口的开关状态 */}
                      {s.key === "provider" && (
                        <div className="rounded-xl border border-line p-3.5">
                          <AiProviderSettings
                            isOpen={isOpen}
                            onClose={onClose}
                            providers={aiProviders}
                            selectedProviderId={aiSelectedProviderId}
                            onProvidersChange={onAiProvidersChange}
                            onSelectedProviderChange={onAiSelectedProviderChange}
                          />
                        </div>
                      )}

                      {/* AI 记忆 / 前置提示词：启用项由 buildMemoryBlock 拼进每次请求的系统提示词 */}
                      {s.key === "memory" && (
                        <div className="space-y-3">
                          <p className="text-[11px] text-faint leading-relaxed">{t("启用中的每一条都会加在每次请求的系统提示词末尾，既可作默认要求（如「回答先给结论」），也可当作长期记忆。")}</p>

                          <div className="space-y-2">
                            {/* 中文输入法组字期间的回车是选词，isComposing / keyCode 229 时不能当提交 */}
                            <textarea
                              value={memoryDraft}
                              onChange={(e) => setMemoryDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  addPrompt();
                                }
                              }}
                              rows={2}
                              placeholder={t("输入一条要求或记忆，回车添加（Shift+回车换行）")}
                              className="w-full resize-none px-3 py-2 text-xs input-modern bg-app/50 focus:bg-surface transition-colors"
                            />
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] text-faint">{t("回车即可添加")}</span>
                              <button
                                onClick={addPrompt}
                                disabled={!memoryDraft.trim()}
                                className="px-3 py-1.5 text-xs font-medium text-on-accent bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >{t("添加")}</button>
                            </div>
                          </div>

                          {/* 条目多了就内部滚动，避免把整页设置撑得特别长 */}
                          <div className="space-y-2 max-h-[260px] overflow-y-auto chat-scrollbar pr-1 -mr-1">
                            {aiPrompts.length === 0 && (
                              <div className="py-6 text-center text-xs text-faint border border-dashed border-line rounded-xl">{t("还没有内容。添加一条试试，例如「回答尽量简短，先给结论」。")}</div>
                            )}
                            {aiPrompts.map((entry) => (
                              <div
                                key={entry.id}
                                className={`group rounded-xl border px-3 py-2 transition-colors ${
                                  entry.enabled ? "border-line bg-surface" : "border-line-soft bg-app/60"
                                }`}
                              >
                                {editingPromptId === entry.id ? (
                                  <div className="space-y-2">
                                    <textarea
                                      value={editingPromptText}
                                      onChange={(e) => setEditingPromptText(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                                        if (e.key === "Enter" && !e.shiftKey) {
                                          e.preventDefault();
                                          savePromptEdit();
                                        }
                                        if (e.key === "Escape") setEditingPromptId(null);
                                      }}
                                      rows={2}
                                      autoFocus
                                      className="w-full resize-none px-2.5 py-1.5 text-xs input-modern bg-surface"
                                    />
                                    <div className="flex justify-end gap-1.5">
                                      <button
                                        onClick={() => setEditingPromptId(null)}
                                        className="px-2.5 py-1 text-[11px] text-muted bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors"
                                      >{t("取消")}</button>
                                      <button
                                        onClick={savePromptEdit}
                                        className="px-2.5 py-1 text-[11px] text-on-accent bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors"
                                      >{t("保存")}</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-start gap-2">
                                    <button
                                      onClick={() => togglePrompt(entry.id)}
                                      title={entry.enabled ? t("已启用，点击停用") : t("已停用，点击启用")}
                                      aria-pressed={entry.enabled}
                                      className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${
                                        entry.enabled
                                          ? "bg-primary-500 border-primary-500 text-on-accent"
                                          : "bg-surface border-line-strong"
                                      }`}
                                    >
                                      {entry.enabled && <Icon name="memory-check" className="w-3 h-3" />}
                                    </button>
                                    <p
                                      className={`flex-1 min-w-0 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                                        entry.enabled ? "text-body" : "text-faint"
                                      }`}
                                    >
                                      {entry.text}
                                    </p>
                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                      <button
                                        onClick={() => {
                                          setEditingPromptId(entry.id);
                                          setEditingPromptText(entry.text);
                                        }}
                                        className="px-1.5 py-1 text-[11px] text-faint hover:text-primary-500 rounded-md hover:bg-primary-50 transition-colors"
                                      >{t("编辑")}</button>
                                      <button
                                        onClick={() => removePrompt(entry.id)}
                                        className="px-1.5 py-1 text-[11px] text-faint hover:text-danger rounded-md hover:bg-danger-soft transition-colors"
                                      >{t("删除")}</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>

                          <p className="text-[11px] text-faint">{t("共 {count} 条，其中 {enabled} 条已启用", { count: aiPrompts.length, enabled: enabledPromptCount })}</p>
                        </div>
                      )}

                      {/* AI 访问权限：总开关在数据行里，这里是分组 + 组内笔记的档位 */}
                      {s.key === "access" && (
                        <div className="space-y-3">
                          <p className="text-[11px] text-faint leading-relaxed">{t("三档权限：禁止（AI 完全看不到）、只读（能读能总结，不能改）、完全（读写都可以）。分组定的是组内上限，展开分组可以给单篇笔记单独设；两层取更严格的那一档。")}</p>

                          {!aiSettings.aiAccessEnabled && (
                            <div className="flex items-start gap-2 rounded-xl border border-warning-line bg-warning-soft/70 px-3 py-2.5">
                              <Icon name="ai-warning" className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-warning" />
                              <p className="text-[11px] leading-relaxed text-warning-deep">{t("总开关已关闭，下面的设置暂时不起作用；AI 无法读取任何笔记。")}</p>
                            </div>
                          )}

                          <div className="rounded-xl border border-line divide-y divide-line-soft">
                            {categories.filter((c) => !c.is_encrypted).map((c) => {
                              const { rows, capped } = accessByCategory.get(c.id) ?? { rows: [], capped: 0 };
                              const expanded = expandedCategories.has(c.id);
                              return (
                                <div key={c.id}>
                                  <div className="flex items-center gap-2 px-3 py-2.5">
                                    <button
                                      type="button"
                                      onClick={() => toggleCategory(c.id)}
                                      disabled={rows.length === 0}
                                      className={`flex-shrink-0 w-4 h-4 rounded flex items-center justify-center transition-colors ${
                                        rows.length === 0
                                          ? "text-faint-soft cursor-default"
                                          : "text-faint hover:bg-surface-alt hover:text-body"
                                      }`}
                                      title={rows.length === 0 ? t("该分组还没有笔记") : expanded ? t("收起笔记") : t("展开设置单篇笔记")}
                                      aria-expanded={expanded}
                                    >
                                      <Icon
                                        name="sidebar-chevron-down"
                                        className={`w-2.5 h-2.5 transition-transform ${expanded ? "" : "-rotate-90"}`}
                                      />
                                    </button>
                                    <div className="min-w-0 flex-1">
                                      <p className="text-xs font-medium text-body truncate" title={c.name}>
                                        {c.name}
                                      </p>
                                      <p className="text-[10.5px] text-faint">{t("{note_count} 篇{value2}", { note_count: c.note_count, value2: capped > 0 ? t(" · {capped} 篇被分组限制在更低档", { capped: capped }) : "" })}</p>
                                    </div>
                                    <AiAccessLevelSelect
                                      value={c.ai_access}
                                      disabled={!onSetCategoryAiAccess}
                                      onChange={(level) => void onSetCategoryAiAccess?.(c, level)}
                                    />
                                  </div>

                                  {expanded && (
                                    <div className="bg-app/70 px-3 pb-2.5 pl-9 space-y-1">
                                      {rows.map((n) => {
                                        const effective = Math.min(n.ai_access, c.ai_access) as AiAccessLevel;
                                        return (
                                          <div key={n.id} className="flex items-center gap-2 py-1">
                                            <span className="min-w-0 flex-1 truncate text-[11.5px] text-body" title={n.title}>
                                              {n.title || t("无标题")}
                                            </span>
                                            {effective !== n.ai_access && (
                                              <span className="flex-shrink-0 text-[10px] text-warning">{t("实际{value1}", { value1: t(AI_ACCESS_LABELS[effective]) })}</span>
                                            )}
                                            <AiAccessLevelSelect
                                              value={n.ai_access}
                                              size="xs"
                                              disabled={!onSetNoteAiAccess}
                                              onChange={(level) => void onSetNoteAiAccess?.(n, level)}
                                            />
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* 未分类笔记没有分组可继承，只能逐篇设 */}
                            {uncategorized.length > 0 && (
                              <div>
                                <div className="flex items-center gap-2 px-3 py-2.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleCategory(UNCATEGORIZED_KEY)}
                                    className="flex-shrink-0 w-4 h-4 rounded flex items-center justify-center text-faint hover:bg-surface-alt hover:text-body transition-colors"
                                    aria-expanded={expandedCategories.has(UNCATEGORIZED_KEY)}
                                    title={t("展开设置单篇笔记")}
                                  >
                                    <Icon
                                      name="sidebar-chevron-down"
                                      className={`w-2.5 h-2.5 transition-transform ${
                                        expandedCategories.has(UNCATEGORIZED_KEY) ? "" : "-rotate-90"
                                      }`}
                                    />
                                  </button>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium text-body">{t("未分类")}</p>
                                    <p className="text-[10.5px] text-faint">{t("{length} 篇 · 逐篇设置", { length: uncategorized.length })}</p>
                                  </div>
                                </div>
                                {expandedCategories.has(UNCATEGORIZED_KEY) && (
                                  <div className="bg-app/70 px-3 pb-2.5 pl-9 space-y-1">
                                    {uncategorized.map((n) => (
                                      <div key={n.id} className="flex items-center gap-2 py-1">
                                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-body" title={n.title}>
                                          {n.title || t("无标题")}
                                        </span>
                                        <AiAccessLevelSelect
                                          value={n.ai_access}
                                          size="xs"
                                          disabled={!onSetNoteAiAccess}
                                          onChange={(level) => void onSetNoteAiAccess?.(n, level)}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {categories.length === 0 && uncategorized.length === 0 && (
                            <p className="rounded-xl border border-line px-3.5 py-3 text-[11px] text-faint">{t("还没有任何笔记或分组。")}</p>
                          )}
                        </div>
                      )}

                      {/* 恢复默认：编辑器 / 主题 / 软件 / AI 四块互相独立，按需单独恢复 */}
                      {s.key === "reset" && (
                        <div className="space-y-2.5 pt-1">
                          <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-body">{t("恢复编辑器默认设置")}</p>
                              <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("字号、行高、间距、工具栏与颜色预设等编辑器选项回到默认值，不影响主题与 AI 设置。")}</p>
                            </div>
                            <button
                              onClick={onResetEditorSettings}
                              className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
                            >{t("恢复")}</button>
                          </div>

                          <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-body">{t("恢复主题默认设置")}</p>
                              <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("明暗模式、预设配色、自定义取色与「我的主题」回到默认，不影响其他软件设置。")}</p>
                            </div>
                            <button
                              onClick={onResetThemeSettings}
                              className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
                            >{t("恢复")}</button>
                          </div>

                          <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-body">{t("恢复软件默认设置")}</p>
                              <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("通用、编辑器、笔记列表、界面布局与主题回到默认值，不影响 AI 设置。")}</p>
                            </div>
                            <button
                              onClick={onResetAppSettings}
                              className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
                            >{t("恢复")}</button>
                          </div>

                          <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-body">{t("恢复 AI 默认设置")}</p>
                              <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("对话行为、上下文等 AI 参数回到默认值，不影响服务商与记忆条目。")}</p>
                            </div>
                            <button
                              onClick={() => onAiSettingsChange({ ...DEFAULT_AI_SETTINGS })}
                              className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
                            >{t("恢复")}</button>
                          </div>
                        </div>
                      )}

                      {/* 备份与恢复：JSON / SQLite / 加密容器三种整库备份，恢复时覆盖当前数据 */}
                      {s.key === "backup" && (
                        <div className="space-y-3">
                          <p className="text-[11px] text-faint leading-relaxed">{t("备份内容包含笔记、分组、回收站、标签、历史版本、AI 对话记录与全部设置 （含编辑器与主题），支持 JSON、SQLite 与加密备份三种格式。API Key 与 WebDAV 默认不备份，可在下方按需勾选；语义向量索引与本地模型文件同样不在备份里： 恢复后需要重新下载（或重新导入）模型并重建索引。另可在下方配置 WebDAV， 把 JSON 备份自动同步到云端并按需恢复。")}</p>

                          {/* 格式选择：JSON 带字段级兼容，SQLite 是整库快照，加密备份再套一层口令 */}
                          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
                            <div className="min-w-0 flex-1 basis-[220px]">
                              <span className="text-xs font-medium text-body">{t("备份格式")}</span>
                              <p className="text-[11px] text-faint leading-relaxed mt-1">
                                {backupFormat === "sqlite"
                                  ? t("SQLite 是整库快照（.db），恢复更快，适合本机定期备份。")
                                  : backupFormat === "encrypted"
                                    ? t("加密备份（.fnbak）是整库快照再用独立口令加密的密文，包含加密笔记与密钥元数据，恢复时需要输入备份口令。")
                                    : t("JSON 带字段级兼容逻辑，可跨版本恢复，适合换机迁移。")}
                              </p>
                            </div>
                            <SegmentedInput
                              value={backupFormat}
                              options={[
                                { value: "json", label: "JSON" },
                                { value: "sqlite", label: "SQLite" },
                                { value: "encrypted", label: "加密备份" },
                              ]}
                              onChange={(v) =>
                                setBackupFormat(
                                  v === "sqlite" || v === "encrypted" ? v : "json",
                                )
                              }
                            />
                          </div>

                          {/* 加密备份是整库打包：两个开关不适用，改为说明一行 */}
                          {backupFormat === "encrypted" && (
                            <div className="px-3 py-2.5 rounded-xl bg-app border border-line-soft">
                              <p className="text-[11px] text-faint leading-relaxed">
                                {t("加密备份会把整库（含加密笔记、API Key 与 WebDAV 配置的本机密文、密钥元数据）一起放进容器，由备份口令保护，无需单独勾选。")}
                              </p>
                            </div>
                          )}

                          {/* API Key 默认不备份，避免密钥被误带到网盘 */}
                          {backupFormat !== "encrypted" && (
                          <>
                          <div className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
                            <div className="min-w-0">
                              <span className="text-xs font-medium text-body">{t("备份 API Key")}</span>
                              <p className="text-[11px] text-faint leading-relaxed mt-1">{t("勾选后导出的备份文件会保留 API Key：JSON 里是明文（请妥善保管），SQLite 里保持本机加密（换机可能解不开）；不勾选则只保留服务商配置、不含 Key。手动「备份到云端」同样遵循此开关，自动备份则始终不含 Key。")}</p>
                            </div>
                            <div className="max-w-full pt-0.5">
                              <Switch value={backupIncludeApiKey} onChange={setBackupIncludeApiKey} />
                            </div>
                          </div>

                          {/* WebDAV 配置默认同样不进备份：里面含云端账号与密码 */}
                          <div className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft">
                            <div className="min-w-0">
                              <span className="text-xs font-medium text-body">{t("备份 WebDAV 配置")}</span>
                              <p className="text-[11px] text-faint leading-relaxed mt-1">{t("勾选后备份会带上 WebDAV 服务器、账号、文件夹与自动备份设置：JSON 里密码为明文（请妥善保管），SQLite 保持本机加密（换机可能解不开）；不勾选则完全不含 WebDAV 配置。手动「备份到云端」同样遵循此开关，自动备份始终不含。")}</p>
                            </div>
                            <div className="max-w-full pt-0.5">
                              <Switch value={backupIncludeWebdav} onChange={setBackupIncludeWebdav} />
                            </div>
                          </div>
                          </>
                          )}

                          <div className="flex items-center gap-3 p-3 rounded-xl bg-app border border-line-soft">
                            <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                              <Icon name="app-backup" className="w-4 h-4 text-primary-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-body">{t("导出备份")}</p>
                              <p className="text-[11px] text-faint mt-0.5">
                                {backupFormat === "sqlite"
                                  ? t("保存为一个 SQLite 数据库文件（.db），可放到 U 盘或备份目录。")
                                  : backupFormat === "encrypted"
                                    ? t("保存为一个加密备份文件（.fnbak），需要备份口令才能打开。")
                                    : t("保存为一个 JSON 文件，可放到网盘或 U 盘带走。")}
                              </p>
                              {lastExport && (
                                <p className="text-[11px] text-success mt-1 truncate" title={lastExport.path}>{t("已导出：{value1} · {notes} 篇笔记 · {messages} 条对话消息", { value1: baseName(lastExport.path), notes: lastExport.summary.notes, messages: lastExport.summary.messages })}</p>
                              )}
                            </div>
                            <button
                              onClick={() => void guard(handleExport)}
                              disabled={backupBusy !== null}
                              className="btn-primary px-3 py-1.5 text-xs flex-shrink-0 disabled:opacity-50"
                            >
                              {backupBusy === "export" ? t("导出中...") : t("导出")}
                            </button>
                          </div>

                          <div className="flex items-center gap-3 p-3 rounded-xl bg-app border border-line-soft">
                            <div className="w-8 h-8 rounded-lg bg-warning-soft flex items-center justify-center flex-shrink-0">
                              <Icon name="app-restore" className="w-4 h-4 text-warning" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-body">{t("从备份恢复")}</p>
                              <p className="text-[11px] text-faint mt-0.5">{t("支持 .json、.db 与 .fnbak 加密备份，选择后覆盖当前数据并自动刷新；带 API Key 时会重新加密写入，同机恢复会保留已填好的 Key，加密备份还需输入备份口令。")}</p>
                            </div>
                            <button
                              onClick={() => void guard(handleImport)}
                              disabled={backupBusy !== null}
                              className="px-3 py-1.5 text-xs font-medium text-warning-deep bg-warning-soft rounded-xl hover:bg-warning-line transition-colors flex-shrink-0 disabled:opacity-50"
                            >
                              {backupBusy === "import" ? t("恢复中...") : t("选择文件")}
                            </button>
                          </div>

                          {lastExport?.summary.exported_at && (
                            <p className="text-[11px] text-faint">{t("本次导出时间：{value1}", { value1: prettyTime(lastExport.summary.exported_at) })}</p>
                          )}

                          <WebdavPanel
                            settings={appSettings.webdav}
                            onAppSettingChange={onAppSettingChange}
                            includeApiKeys={backupIncludeApiKey}
                            includeWebdav={backupIncludeWebdav}
                          />
                        </div>
                      )}

                      {/* 关于：软件名 / 作者 / 版本 */}
                      {s.key === "about" && (
                        <div className="rounded-xl border border-line p-4">
                          <div className="flex items-center gap-3">
                            <img
                              src="/icons/app-logo.png"
                              alt={t("{appName} 图标", { appName: appName })}
                              draggable={false}
                              className="rounded-lg object-contain flex-shrink-0 select-none"
                              style={{ width: 30, height: 30 }}
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-ink">{appName}</p>
                              <p
                                onClick={handleAuthorClick}
                                className="mt-0.5 text-[11px] text-faint select-none cursor-default"
                              >
                                {t("作者：{APP_AUTHOR}", { APP_AUTHOR: APP_AUTHOR })}
                              </p>
                            </div>
                          </div>
                          <div className="mt-3 pt-3 border-t border-line-soft">
                            <div className="flex items-center justify-between gap-3 text-[12px]">
                              <span className="text-faint">{t("版本")}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-body font-medium">{appVersion || "—"}</span>
                                <button
                                  type="button"
                                  onClick={() => void checkForUpdates()}
                                  disabled={
                                    updater.phase === "checking" ||
                                    updater.phase === "downloading" ||
                                    updater.phase === "ready" ||
                                    updater.phase === "installing"
                                  }
                                  className="px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {updater.phase === "checking" ? t("检查中...") : t("检查更新")}
                                </button>
                              </div>
                            </div>

                            {/* 运行期间的自动检查：启动时的静默检查不受此间隔影响 */}
                            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
                              <span className="text-faint">{t("自动检查更新")}</span>
                              <SelectInput
                                compact
                                label={t("自动检查更新间隔")}
                                value={String(appSettings.general.updateCheckIntervalMinutes)}
                                options={UPDATE_CHECK_INTERVAL_OPTIONS}
                                onChange={(value) => setApp("general", "updateCheckIntervalMinutes", Number(value))}
                              />
                            </div>

                            {/* 更新地址：想自己去发布页看版本/下载安装包时用 */}
                            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
                              <span className="text-faint">{t("更新地址")}</span>
                              <button
                                type="button"
                                onClick={() => void openUrl(APP_RELEASES_URL).catch(() => undefined)}
                                title={APP_RELEASES_URL}
                                className="text-primary-600 hover:text-primary-700 hover:underline transition-colors"
                              >
                                {t("打开更新地址")}
                              </button>
                            </div>

                            {updater.phase === "current" && (
                              <p className="mt-2 text-[11px] text-success-strong">{t("已是最新版本")}</p>
                            )}

                            {updater.phase === "error" && (
                              <p className="mt-2 text-[11px] text-danger-strong break-words">
                                {t("检查更新失败：{value1}", { value1: updater.error || t("未知") })}
                              </p>
                            )}

                            {updater.phase === "available" && (
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <p className="min-w-0 truncate text-[11px] text-primary-600">
                                  {t("发现新版本 {value1}", { value1: updater.version || "" })}
                                  {updater.activeLine && (
                                    <span className="text-faint">
                                      {" "}
                                      · {updater.activeLine === "cnb" ? t("CNB（国内）") : "GitHub"}
                                    </span>
                                  )}
                                  {updater.skippedVersion === updater.version && (
                                    <span className="text-faint"> · {t("已跳过")}</span>
                                  )}
                                </p>
                                <button
                                  type="button"
                                  onClick={openUpdateDialog}
                                  className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
                                >
                                  {t("查看更新说明")}
                                </button>
                              </div>
                            )}

                            {updater.phase === "downloading" && (
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <p className="min-w-0 truncate text-[11px] text-primary-600">
                                  {updater.progress == null
                                    ? t("正在下载更新...")
                                    : t("正在下载更新... {value1}%", { value1: updater.progress })}
                                  {updater.speed != null && (
                                    <span className="text-faint"> · {formatSpeed(updater.speed)}</span>
                                  )}
                                </p>
                                <button
                                  type="button"
                                  onClick={openUpdateDialog}
                                  className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
                                >
                                  {t("查看进度")}
                                </button>
                              </div>
                            )}

                            {/* 下载完成：安装包已缓存，可随时从弹窗里安装 */}
                            {(updater.phase === "ready" || updater.phase === "installing") && (
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <p className="min-w-0 truncate text-[11px] text-primary-600">
                                  {updater.phase === "installing"
                                    ? t("正在安装更新...")
                                    : t("更新已下载，等待安装")}
                                </p>
                                <button
                                  type="button"
                                  onClick={openUpdateDialog}
                                  className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
                                >
                                  {t("查看进度")}
                                </button>
                              </div>
                            )}
                          </div>

                          {/* 图标来源 */}
                          <div className="mt-3 pt-3 border-t border-line-soft">
                            <p className="text-[11px] font-medium text-muted">{t("部分图标来源")}</p>
                            <button
                              onClick={() => openUrl(ICON_SOURCE.url)}
                              className="mt-1.5 text-left group"
                            >
                              <span className="block text-[11px] text-body group-hover:text-primary-600 transition-colors">
                                {t(ICON_SOURCE.name)}
                              </span>
                              <span className="block text-[11px] text-faint">
                                {ICON_SOURCE.url}
                              </span>
                            </button>
                          </div>

                          {/* 开源项目：条目较多，用固定高度滚动区承载 */}
                          <div className="mt-3 pt-3 border-t border-line-soft">
                            <p className="text-[11px] font-medium text-muted">{t("开源项目")}</p>
                            <div className="mt-1.5 max-h-[150px] overflow-y-auto chat-scrollbar pr-1 space-y-0.5">
                              {OPEN_SOURCE_PROJECTS.map((p) => (
                                <button
                                  key={p.name}
                                  onClick={() => openUrl(p.url)}
                                  className="w-full flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg text-[11px] text-left hover:bg-app transition-colors group"
                                >
                                  <span className="text-body group-hover:text-primary-600 transition-colors">
                                    {p.name}
                                  </span>
                                  <span className="text-faint truncate">{shortUrl(p.url)}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </section>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmDialog}

      {/* 加密备份口令：导出/恢复共用，口令只活在这个弹窗里 */}
      <BackupPassphraseDialog
        isOpen={backupPassphrase !== null}
        mode={backupPassphrase?.mode ?? "export"}
        onClose={() => setBackupPassphrase(null)}
        onSubmit={
          backupPassphrase?.mode === "import" ? runEncryptedImport : runEncryptedExport
        }
      />
    </>
  );
};