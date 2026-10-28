import { useI18n } from "@/i18n";
/**
 * 设置 → 主题。
 *
 * 四块内容，自上而下：
 *   1. 外观模式：浅色 / 深色 / 跟随系统
 *   2. 预设主题：8 套成品配色，点一下整体替换（含亮暗两套）
 *   3. 实时预览：一个"缩小的 FastNote"，用当前令牌内联着色
 *   4. 自定义：按 背景 / 文字 / 边框 / 主题色 / 语义色 分栏的取色器 + 圆角；
 *      任何一次取色都会把当前主题切成"自定义"，并从当前预设补齐另一模式的令牌
 *   5. 我的主题：给当前配色命名保存、应用、删除
 *
 * 为什么不需要"应用 / 取消"按钮：设置项都是实时生效的（App 的 effect 会立即写变量并落库），
 * 预览就是整个软件本身。面板里的预览卡只是把颜色并排放在一起，方便一次性对比。
 */
import { memo, useState } from "react";
import type { SavedTheme, ThemeColorKey, ThemeMode, ThemeSettings, ThemeTokens } from "@/interface/theme";
import {
  COLOR_FIELD_META,
  COLOR_GROUPS,
  CUSTOM_PRESET_ID,
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  MAX_SAVED_THEMES,
  RADIUS_PRESETS,
  THEME_PRESETS,
} from "@/config/themes";
import { getPreset, getTokenPair, getTokensForMode, hexToCss, normalizeHex, resolveMode } from "@/lib/theme";
import { Icon } from "@/components/common/Icon";
import { useToast } from "@/components/common/Toast";
import { ColorPicker } from "@/components/settings/ColorPicker";

/* ---------- 局部小图标：太阳 / 月亮 / 跟随系统 ---------- */

const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
    <path d="M21 12.8A8.5 8.5 0 1111.2 3a7 7 0 009.8 9.8z" />
  </svg>
);

const SystemIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

/* ---------- 取色控件 ---------- */

/**
 * 单个颜色项：色块（点开自绘取色器）+ 中文名 + 说明 + 十六进制输入。
 *
 * 色块用自绘取色器：原生 input[type=color] 拖动时会连续回调，
 * 主题每帧整页换色，卡顿明显；自绘版松手才提交一次。
 *
 * 十六进制框自己存一份草稿：用户敲到 "#6" 时不能立刻回调，
 * 只有凑齐 6 位且合法才写回，否则输入过程会被顶回原值。
 */
const ColorField: React.FC<{
  tokenKey: ThemeColorKey;
  value: string;
  onChange: (hex: string) => void;
}> = ({ tokenKey, value, onChange }) => {
  const { t } = useI18n();
  const meta = COLOR_FIELD_META[tokenKey];
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) onChange(hex);
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <ColorPicker
        value={value}
        onChange={onChange}
        label={t("{label}取色", { label: t(meta.label) })}
        className="w-7 h-7 flex-shrink-0 rounded-lg border border-line-strong/60 shadow-inner"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] font-medium text-body leading-tight">{t(meta.label)}</p>
        <p className="text-[10.5px] text-faint leading-tight mt-0.5 truncate" title={t(meta.hint)}>
          {t(meta.hint)}
        </p>
      </div>
      <input
        type="text"
        value={draft ?? value.toUpperCase()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(null);
        }}
        spellCheck={false}
        className="w-[84px] flex-shrink-0 px-1.5 py-1 text-[10.5px] font-mono text-center input-modern uppercase"
        aria-label={t("{label}色值", { label: t(meta.label) })}
      />
    </div>
  );
};

/* ---------- 实时预览 ---------- */

/**
 * 预览卡：完全用传入的令牌内联着色，不读全局 CSS 变量。
 * 这样即使某个变量还没写进 <html>，预览也能反映"即将变成什么样"。
 */
const ThemePreview: React.FC<{ tokens: ThemeTokens }> = ({ tokens }) => {
  const { t } = useI18n();
  const colors = tokens;
  const c = hexToCss;
  const r = Math.min(colors.radius, 14);

  return (
    <div
      className="rounded-xl border overflow-hidden select-none"
      style={{ background: c(colors.appBg), borderColor: c(colors.border), borderRadius: colors.radius + 4 }}
    >
      <div className="flex min-h-[132px]">
        {/* 侧边栏 */}
        <div className="w-[74px] flex-shrink-0 p-1.5 flex flex-col gap-1" style={{ background: c(colors.surfaceAlt) }}>
          <div className="flex items-center gap-1 px-1 pb-1">
            <span className="w-2.5 h-2.5 rounded" style={{ background: c(colors.accent) }} />
            <span className="text-[8px] font-semibold" style={{ color: c(colors.textInk) }}>FastNote</span>
          </div>
          {["笔记", "收藏", "回收站"].map((label, i) => (
            <div
              key={label}
              className="px-1.5 py-[3px] text-[8px]"
              style={{
                background: i === 0 ? c(colors.accent) : "transparent",
                color: i === 0 ? c(colors.onAccent) : c(colors.textMuted),
                borderRadius: Math.max(2, r - 4),
              }}
            >
              {t(label)}
            </div>
          ))}
        </div>

        {/* 正文 */}
        <div className="flex-1 min-w-0 p-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] font-semibold truncate" style={{ color: c(colors.textInk) }}>{t("今天的想法")}</span>
            <span
              className="text-[7.5px] px-1 py-[1px] rounded"
              style={{ background: c(colors.surfaceAlt), color: c(colors.textFaint) }}
            >{t("2 分钟前")}</span>
          </div>
          <p className="text-[8px] leading-[1.7]" style={{ color: c(colors.textBody) }}>{t("主题改完立刻生效，不用来回关窗口看效果。")}</p>
          <p className="text-[7.5px]" style={{ color: c(colors.textFaint) }}>{t("这行是弱化文字，用来放时间与附件信息。")}</p>

          <div
            className="mt-auto rounded-lg border p-1.5 flex items-center gap-1"
            style={{ background: c(colors.surface), borderColor: c(colors.border), borderRadius: r }}
          >
            <span className="text-[8px] flex-1" style={{ color: c(colors.textMuted) }}>{t("写点什么…")}</span>
            <span
              className="text-[7.5px] px-1.5 py-[2px] font-medium"
              style={{ background: c(colors.accent), color: c(colors.onAccent), borderRadius: Math.max(2, r - 4) }}
            >{t("保存")}</span>
          </div>

          <div className="flex items-center gap-1">
            <span
              className="text-[7px] px-1 py-[1px] rounded"
              style={{ background: c(colors.danger), color: "#ffffff" }}
            >{t("删除")}</span>
            <span
              className="text-[7px] px-1 py-[1px] rounded"
              style={{ background: c(colors.success), color: "#ffffff" }}
            >{t("已保存")}</span>
            <span
              className="text-[7px] px-1 py-[1px] rounded"
              style={{ background: c(colors.warning), color: "#ffffff" }}
            >{t("受限")}</span>
            <span
              className="ml-auto text-[7px] px-1 py-[1px] rounded"
              style={{ background: c(colors.accent), color: c(colors.onAccent), opacity: 0.22 }}
            >{t("选中")}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---------- 主组件 ---------- */

const ThemePanelBase: React.FC<{
  theme: ThemeSettings;
  onChange: (next: ThemeSettings) => void;
}> = ({ theme, onChange }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const resolved = resolveMode(theme.mode);
  /** 当前模式下的令牌：自定义面板与预览都用它 */
  const tokens = getTokensForMode(theme, resolved);
  const preset = getPreset(theme.presetId);
  const isCustom = theme.presetId === CUSTOM_PRESET_ID;
  /** 保存主题的命名输入 */
  const [savedName, setSavedName] = useState("");

  const modeOptions: { value: ThemeMode; label: string; icon: React.ReactNode; hint: string }[] = [
    { value: "light", label: t("浅色"), icon: <SunIcon />, hint: t("始终使用亮色令牌") },
    { value: "dark", label: t("深色"), icon: <MoonIcon />, hint: t("始终使用暗色令牌") },
    { value: "system", label: t("跟随系统"), icon: <SystemIcon />, hint: t("随操作系统的深浅色自动切换") },
  ];

  /**
   * 改单个令牌：从当前预设补齐另一模式，再改当前模式的那一项。
   * 这样切到另一个模式时看到的仍是一套完整的配色，不会只剩默认值。
   */
  const patchToken = (key: ThemeColorKey | "radius", value: string | number) => {
    const pair = getTokenPair(theme);
    const next = {
      light: { ...pair.light },
      dark: { ...pair.dark },
    };
    if (key === "radius") {
      next.light.radius = value as number;
      next.dark.radius = value as number;
    } else {
      next[resolved][key] = value as string;
    }
    onChange({ ...theme, presetId: CUSTOM_PRESET_ID, custom: next });
  };

  /** 把当前配色存成一条命名主题（同名覆盖，最多 MAX_SAVED_THEMES 条） */
  const saveCurrent = () => {
    const name = savedName.trim() || t("我的主题 {value1}", { value1: theme.saved.length + 1 });
    const pair = getTokenPair(theme);
    const entry: SavedTheme = {
      id: `t${Date.now().toString(36)}`,
      name: name.slice(0, 24),
      createdAt: new Date().toISOString(),
      mode: theme.mode,
      light: pair.light,
      dark: pair.dark,
    };
    const saved = [entry, ...theme.saved.filter((colors) => colors.name !== entry.name)].slice(0, MAX_SAVED_THEMES);
    onChange({ ...theme, saved });
    setSavedName("");
    showToast(t("已保存主题「{name}」", { name: entry.name }), "success");
  };

  /** 应用一条已保存主题：亮暗两套一起恢复，模式也恢复成保存时的选择 */
  const applySaved = (entry: SavedTheme) => {
    onChange({
      ...theme,
      mode: entry.mode,
      presetId: CUSTOM_PRESET_ID,
      custom: { light: entry.light, dark: entry.dark },
    });
    showToast(t("已应用主题「{name}」", { name: entry.name }), "success");
  };

  const removeSaved = (id: string) => {
    onChange({ ...theme, saved: theme.saved.filter((colors) => colors.id !== id) });
  };

  return (
    <div className="space-y-5">
      {/* ---- 外观模式 ---- */}
      <div>
        <p className="text-[11px] text-faint mb-2">{t("选择软件的明暗外观。三种选择不会改动你已经调好的配色，只切换使用哪一套令牌。")}</p>
        <div className="grid grid-cols-3 gap-2">
          {modeOptions.map((o) => {
            const active = theme.mode === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange({ ...theme, mode: o.value })}
                aria-pressed={active}
                title={o.hint}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-colors ${
                  active
                    ? "border-primary-500 bg-primary-50 text-primary-600"
                    : "border-line bg-surface text-body hover:bg-app"
                }`}
              >
                <span className={active ? "text-primary-500" : "text-faint"}>{o.icon}</span>
                <span className="text-xs font-medium">{o.label}</span>
              </button>
            );
          })}
        </div>
        {theme.mode === "system" && (
          <p className="mt-1.5 text-[10.5px] text-faint">{t("当前系统偏好：{value1}（改系统设置会立即跟随）", { value1: resolved === "dark" ? t("深色") : t("浅色") })}</p>
        )}
      </div>

      {/* ---- 预设主题 ---- */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-xs font-semibold text-ink">{t("预设主题")}</p>
          <p className="text-[10.5px] text-faint">{t("当前：{value1}", { value1: isCustom ? t("自定义") : t(preset.name) })}</p>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {THEME_PRESETS.map((p) => {
            const colors = p[resolved];
            const active = theme.presetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange({ ...theme, presetId: p.id })}
                aria-pressed={active}
                title={t(p.desc)}
                className={`group rounded-xl border p-2 text-left transition-colors ${
                  active
                    ? "border-primary-500 ring-1 ring-primary-500/20"
                    : "border-line hover:border-line-strong"
                }`}
                style={{ background: hexToCss(colors.surface) }}
              >
                {/* 色点：底色 / 次级填充 / 主题色 / 标题字 */}
                <div
                  className="h-7 rounded-lg mb-1.5 flex items-center gap-1 px-1.5"
                  style={{ background: hexToCss(colors.appBg), border: `1px solid ${hexToCss(colors.border)}` }}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: hexToCss(colors.accent) }} />
                  <span className="w-2 h-2 rounded-full" style={{ background: hexToCss(colors.surfaceAlt) }} />
                  <span className="w-2 h-2 rounded-full" style={{ background: hexToCss(colors.textInk) }} />
                  <span className="w-2 h-2 rounded-full" style={{ background: hexToCss(colors.textFaint) }} />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-medium" style={{ color: hexToCss(colors.textInk) }}>
                    {t(p.name)}
                  </span>
                  {active && <Icon name="editor-check" className="w-2.5 h-2.5 text-primary-500" />}
                </div>
                <p className="text-[9.5px] leading-tight mt-0.5 line-clamp-2" style={{ color: hexToCss(colors.textMuted) }}>
                  {t(p.desc)}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- 实时预览 ---- */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-xs font-semibold text-ink">{t("实时预览")}</p>
          <p className="text-[10.5px] text-faint">{t("{value1} · 改动即时生效", { value1: resolved === "dark" ? t("暗色令牌") : t("亮色令牌") })}</p>
        </div>
        <ThemePreview tokens={tokens} />
      </div>

      {/* ---- 自定义颜色 ---- */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-ink">{t("自定义颜色")}</p>
          {isCustom && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...theme,
                  presetId: "minimal",
                  custom: { light: { ...DEFAULT_LIGHT_TOKENS }, dark: { ...DEFAULT_DARK_TOKENS } },
                })
              }
              className="text-[10.5px] text-faint hover:text-danger transition-colors"
            >{t("恢复默认配色")}</button>
          )}
        </div>
        <p className="text-[11px] text-faint leading-relaxed mb-2">{t("正在编辑{mode}令牌；改任意一项会切换为「自定义」，另一模式的配色保持不变，切过去可以单独再调。", { mode: resolved === "dark" ? t("深色") : t("亮色") })}</p>

        <div className="space-y-3">
          {COLOR_GROUPS.map((group) => (
            <div key={group.title} className="rounded-xl border border-line bg-surface px-3 py-2">
              <p className="text-[10px] font-semibold text-faint uppercase tracking-wider pt-0.5 pb-1">
                {t(group.title)}
              </p>
              <div className="divide-y divide-line-soft">
                {group.keys.map((key) => (
                  <ColorField
                    key={key}
                    tokenKey={key}
                    value={tokens[key]}
                    onChange={(hex) => patchToken(key, hex)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* 圆角：一个基准推导 sm~3xl，调小是直角风，调大是圆润风 */}
          <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-medium text-body">{t("圆角")}</p>
                <p className="text-[10.5px] text-faint mt-0.5">{t("按钮、卡片、输入框的统一圆角基准")}</p>
              </div>
              <input
                type="range"
                min={0}
                max={16}
                step={1}
                value={tokens.radius}
                onChange={(e) => patchToken("radius", Number(e.target.value))}
                className="w-28 accent-[var(--color-accent)]"
                aria-label={t("圆角基准")}
              />
              <span className="w-9 text-right text-[11px] font-mono text-muted">{tokens.radius}px</span>
            </div>
            {/* 五档预设：每档是一个按钮，点一下直接落到该基准值；当前档位描主题色 */}
            <div className="flex items-center gap-2 mt-2">
              {RADIUS_PRESETS.map((p) => {
                const active = tokens.radius === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => patchToken("radius", p.value)}
                    aria-pressed={active}
                    title={t("圆角 {value}px", { value: p.value })}
                    className="flex-1 flex flex-col items-center gap-1 outline-none"
                  >
                    <span
                      className="w-full h-6 block transition-all"
                      style={{
                        background: hexToCss(tokens.surfaceAlt),
                        borderRadius: Math.min(p.value, 12),
                        boxShadow: `inset 0 0 0 ${active ? 2 : 1}px ${
                          active ? hexToCss(tokens.accent) : hexToCss(tokens.border)
                        }`,
                      }}
                    />
                    <span
                      className={`text-[10px] leading-none transition-colors ${
                        active ? "text-primary-600 font-medium" : "text-faint"
                      }`}
                    >
                      {t(p.label)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ---- 我的主题 ---- */}
      <div>
        <p className="text-xs font-semibold text-ink mb-1">{t("我的主题")}</p>
        <p className="text-[11px] text-faint leading-relaxed mb-2">{t("把当前配色（含亮暗两套）存下来，之后一键切换。最多保存 {MAX_SAVED_THEMES} 套。", { MAX_SAVED_THEMES: MAX_SAVED_THEMES })}</p>
        <div className="flex items-center gap-1.5">
          <input
            value={savedName}
            onChange={(e) => setSavedName(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") saveCurrent();
            }}
            placeholder={t("给这套主题起个名字（可留空）")}
            maxLength={24}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-[11.5px] input-modern"
          />
          <button
            type="button"
            onClick={saveCurrent}
            className="px-3 py-1.5 text-[11.5px] font-medium text-on-accent bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors"
          >{t("保存主题")}</button>
        </div>

        {theme.saved.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {theme.saved.map((entry) => {
              const colors = resolved === "dark" ? entry.dark : entry.light;
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {[colors.appBg, colors.surface, colors.accent, colors.textInk].map((color, i) => (
                      <span
                        key={i}
                        className="w-2.5 h-2.5 rounded-full border border-line-strong/40"
                        style={{ background: hexToCss(color) }}
                      />
                    ))}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-body" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-faint">
                    {entry.mode === "system" ? t("跟随系统") : entry.mode === "dark" ? t("深色") : t("浅色")}
                  </span>
                  <button
                    type="button"
                    onClick={() => applySaved(entry)}
                    className="flex-shrink-0 px-2 py-0.5 text-[10.5px] font-medium text-primary-600 rounded-md hover:bg-primary-50 transition-colors"
                  >{t("应用")}</button>
                  <button
                    type="button"
                    onClick={() => removeSaved(entry.id)}
                    className="flex-shrink-0 p-0.5 text-faint hover:text-danger transition-colors"
                    title={t("删除这套主题")}
                  >
                    <Icon name="ai-trash" className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-2.5 text-[11px] text-faint">{t("还没有保存过主题。调好颜色后点「保存主题」即可留住这套配色。")}</p>
        )}
      </div>
    </div>
  );
};

/**
 * memo 包一层：主题面板是设置弹窗里最重的一块（预设卡片 + 取色器 + 预览 + 已存主题），
 * 它的输入只有 theme 与 onChange —— 两者在「非主题」的设置改动（搜索、开关、目录跳转）下引用都不变，
 * 交给 memo 跳过这些无谓的重渲染。
 */
export const ThemePanel = memo(ThemePanelBase);
