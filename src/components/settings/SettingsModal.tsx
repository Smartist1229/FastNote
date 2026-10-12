import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getName, getVersion } from "@tauri-apps/api/app";
import {
  AppSettings,
  AiSettings,
  AiProvider,
  AiPromptEntry,
  DEFAULT_AI_SETTINGS,
} from "@/types";
import { FONT_SIZE_MIN, FONT_SIZE_MAX } from "@/config/appDefaults";
import { AiProviderSettings } from "@/components/ai/AiProviderModal";
import { Icon } from "@/components/common/Icon";
import { useToast } from "@/components/common/Toast";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { exportBackup, importBackup, BackupSummary } from "@/api";

/* ────────────────────────────── 分区定义 ────────────────────────────── */

export type SettingsSection =
  | "general"
  | "editor"
  | "view"
  | "layout"
  | "provider"
  | "chat"
  | "context"
  | "memory"
  | "backup"
  | "about";

interface SectionMeta {
  key: SettingsSection;
  label: string;
  icon: string;
  group: "软件" | "AI" | "数据" | "其他";
}

const SECTIONS: SectionMeta[] = [
  { key: "general", label: "通用", icon: "ai-bolt", group: "软件" },
  { key: "editor", label: "编辑器", icon: "ai-edit", group: "软件" },
  { key: "view", label: "笔记列表", icon: "sidebar-list", group: "软件" },
  { key: "layout", label: "界面布局", icon: "sidebar-edit-square", group: "软件" },
  { key: "provider", label: "AI 服务商", icon: "settings-provider", group: "AI" },
  { key: "chat", label: "对话行为", icon: "settings-chat", group: "AI" },
  { key: "context", label: "上下文", icon: "settings-context", group: "AI" },
  { key: "memory", label: "记忆与提示词", icon: "settings-memory", group: "AI" },
  { key: "backup", label: "备份与恢复", icon: "app-backup", group: "数据" },
  { key: "about", label: "关于", icon: "toast-info", group: "其他" },
];

const GROUPS: SectionMeta["group"][] = ["软件", "AI", "数据", "其他"];

/** 自定义面板分区（不是数据驱动的开关/输入行，但同样参与搜索） */
const CUSTOM_KEYS: SettingsSection[] = ["provider", "memory", "backup", "about"];

/** 关于页展示的固定信息 */
const APP_AUTHOR = "Smartist";
const APP_NAME_FALLBACK = "FastNote";

/* ────────────────────────────── 行模型 ────────────────────────────── */

/** live = 改完立刻生效；startup = 只影响软件初始化阶段 */
type Scope = "live" | "startup";

interface RowBase {
  section: SettingsSection;
  title: string;
  desc: string;
  scope: Scope;
  /** 供搜索命中的额外关键词 */
  keywords?: string;
}

type SettingRow =
  | (RowBase & { kind: "toggle"; value: boolean; onChange: (v: boolean) => void })
  | (RowBase & {
      kind: "number";
      value: number;
      min: number;
      max: number;
      step?: number;
      unit?: string;
      onChange: (v: number) => void;
    })
  | (RowBase & {
      kind: "select";
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
    });

/* ────────────────────────────── 基础控件 ────────────────────────────── */

const ScopeBadge: React.FC<{ scope: Scope }> = ({ scope }) => (
  <span
    className={`px-1.5 py-[1px] rounded text-[10px] font-medium border flex-shrink-0 ${
      scope === "live"
        ? "bg-emerald-50 text-emerald-600 border-emerald-200/60"
        : "bg-amber-50 text-amber-600 border-amber-200/60"
    }`}
    title={scope === "live" ? "修改后立即生效" : "在软件下次启动时生效"}
  >
    {scope === "live" ? "实时生效" : "重启生效"}
  </span>
);

const Switch: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({ value, onChange }) => (
  <button
    onClick={() => onChange(!value)}
    role="switch"
    aria-checked={value}
    className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors relative ${value ? "bg-primary-500" : "bg-slate-300"}`}
  >
    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${value ? "left-[18px]" : "left-0.5"}`} />
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
  const [text, setText] = useState(String(value));

  // 外部值变化（恢复默认、滚轮缩放等）时同步显示，但不会打断正在输入的文本
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(n)));
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
        className="w-20 px-2 py-1 text-xs text-right input-modern bg-slate-50/60 focus:bg-white transition-colors"
      />
      {unit ? <span className="text-[11px] text-slate-400 w-8">{unit}</span> : null}
    </div>
  );
};

const SelectInput: React.FC<{
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}> = ({ value, options, onChange }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="px-2.5 py-1 text-xs input-modern bg-slate-50/60 focus:bg-white cursor-pointer pr-7 text-slate-600"
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

const RowView: React.FC<{ row: SettingRow }> = ({ row }) => (
  <div className="flex items-start justify-between gap-6 py-3">
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-700">{row.title}</span>
        <ScopeBadge scope={row.scope} />
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed mt-1">{row.desc}</p>
    </div>
    <div className="flex-shrink-0 pt-0.5">
      {row.kind === "toggle" && <Switch value={row.value} onChange={row.onChange} />}
      {row.kind === "number" && (
        <NumberInput
          value={row.value}
          min={row.min}
          max={row.max}
          step={row.step ?? 1}
          unit={row.unit}
          onChange={row.onChange}
        />
      )}
      {row.kind === "select" && (
        <SelectInput value={row.value} options={row.options} onChange={row.onChange} />
      )}
    </div>
  </div>
);

/* ────────────────────────────── 备份工具函数 ────────────────────────────── */

/** 备份文件名里的时间戳：20261006-1930 */
const fileStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** ISO 时间去秒，展示成 2026-10-06 19:30 */
const prettyTime = (iso: string | null) => {
  if (!iso) return "未知";
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
};

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

const newPromptId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ────────────────────────────── 主组件 ────────────────────────────── */

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 打开时定位到的分区；不传则定位到第一个分区 */
  defaultSection?: SettingsSection;
  appSettings: AppSettings;
  /** 软件设置变更：实时持久化 + 实时生效，由 App 统一处理 */
  onAppSettingChange: (
    category: keyof AppSettings,
    field: string,
    value: boolean | number | string,
  ) => void;
  /** 恢复软件设置默认值 */
  onResetAppSettings: () => void;
  aiSettings: AiSettings;
  onAiSettingsChange: (next: AiSettings) => void;
  aiProviders: AiProvider[];
  aiSelectedProviderId: number;
  onAiProvidersChange: (list: AiProvider[]) => void;
  onAiSelectedProviderChange: (id: number) => void;
  aiPrompts: AiPromptEntry[];
  onAiPromptsChange: (next: AiPromptEntry[]) => void;
}

/**
 * 统一的「设置」窗口。
 *
 * - 锚点式布局：左侧目录（跟随滚动高亮）+ 右侧设置项，点击目录平滑滚动。
 * - 固定宽高；顶部搜索可过滤设置项，无命中的分区自动隐藏。
 * - 设置项区分「实时生效」与「重启生效」两种作用范围。
 * - AI 服务商、AI 记忆、备份与恢复都融合在这里，而不是简单拼接旧弹窗。
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  defaultSection,
  appSettings,
  onAppSettingChange,
  onResetAppSettings,
  aiSettings,
  onAiSettingsChange,
  aiProviders,
  aiSelectedProviderId,
  onAiProvidersChange,
  onAiSelectedProviderChange,
  aiPrompts,
  onAiPromptsChange,
}) => {
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SettingsSection>(defaultSection ?? "general");
  /** 关于页：软件名与版本（版本由 Tauri 自动获取） */
  const [appName, setAppName] = useState(APP_NAME_FALLBACK);
  const [appVersion, setAppVersion] = useState("");

  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({});
  /** 点击目录后短暂锁定高亮，避免平滑滚动过程里高亮一路跳变 */
  const lockRef = useRef(false);
  const lockTimerRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  /* ── 记忆编辑的内部状态 ── */
  const [memoryDraft, setMemoryDraft] = useState("");
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [editingPromptText, setEditingPromptText] = useState("");

  /* ── 备份的内部状态 ── */
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const [lastExport, setLastExport] = useState<{ summary: BackupSummary; path: string } | null>(null);
  /** 导出备份时是否一并写入（解密后的）AI 服务商 API Key */
  const [backupIncludeApiKey, setBackupIncludeApiKey] = useState(false);

  /* ── 顶部「已保存」提示：平时隐藏，发生修改后才短暂出现 ── */
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

  const setAi = useCallback(
    <K extends keyof AiSettings>(field: K, value: AiSettings[K]) => {
      onAiSettingsChange({ ...aiSettings, [field]: value });
      flashSaved();
    },
    [aiSettings, onAiSettingsChange, flashSaved],
  );

  /* ── 数据驱动的设置行 ── */
  const rows: SettingRow[] = useMemo(
    () => [
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
        section: "editor",
        kind: "number",
        scope: "live",
        title: "默认字号",
        desc: "编辑器打开时的默认正文字号；按住 Ctrl/⌘ 滚轮可临时缩放，点工具栏上的字号即可还原到这里设置的值。",
        keywords: "字体 字号 font size 默认",
        value: appSettings.editor.fontSize,
        min: FONT_SIZE_MIN,
        max: FONT_SIZE_MAX,
        unit: "px",
        onChange: (v) => setApp("editor", "fontSize", v),
      },
      {
        section: "editor",
        kind: "toggle",
        scope: "live",
        title: "Ctrl/⌘ + 滚轮缩放字号",
        desc: "在编辑器区域内按住 Ctrl/⌘ 滚动鼠标，可临时放大或缩小正文字号。",
        keywords: "滚轮 zoom wheel 缩放",
        value: appSettings.editor.ctrlScrollZoom,
        onChange: (v) => setApp("editor", "ctrlScrollZoom", v),
      },
      {
        section: "view",
        kind: "select",
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
        kind: "select",
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
      {
        section: "layout",
        kind: "toggle",
        scope: "startup",
        title: "启动时打开 AI 对话面板",
        desc: "只是启动时的布局状态，不跟随运行时的开关操作；下次打开软件才会生效。",
        keywords: "ai 面板 对话 布局 panel 启动",
        value: appSettings.layout.aiPanelOpen,
        onChange: (v) => setApp("layout", "aiPanelOpen", v),
      },
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
        desc: "写操作（创建/修改/删除）执行前先弹确认框，面板里仍可临时切换。",
        keywords: "确认 confirm 操作",
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
    ],
    [appSettings, aiSettings, setApp, setAi],
  );

  /* ── 搜索过滤 ── */
  const q = query.trim().toLowerCase();

  const customSearch = useMemo<Record<string, string>>(
    () => ({
      provider:
        "服务商 模型 api key 密钥 openai google claude 接口 base url http " +
        aiProviders.map((p) => p.name).join(" "),
      memory: "记忆 提示词 prompt 长期记忆 前置 要求 memory",
      backup: "备份 恢复 导出 导入 数据 json 迁移 backup restore",
      about: "关于 版本 作者 应用名 about version author name",
    }),
    [aiProviders],
  );

  const visibleSections = useMemo(
    () =>
      SECTIONS.filter((s) => {
        if (!q) return true;
        if (CUSTOM_KEYS.includes(s.key)) {
          return `${s.label} ${customSearch[s.key] ?? ""}`.toLowerCase().includes(q);
        }
        return rows.some(
          (r) => r.section === s.key && `${r.title} ${r.desc} ${r.keywords ?? ""}`.toLowerCase().includes(q),
        );
      }),
    [q, rows, customSearch],
  );

  const visibleRowsOf = useCallback(
    (section: SettingsSection) =>
      rows.filter(
        (r) =>
          r.section === section &&
          (!q || `${r.title} ${r.desc} ${r.keywords ?? ""}`.toLowerCase().includes(q)),
      ),
    [rows, q],
  );

  /* ── 打开时：重置状态并定位到目标分区 ── */
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSavedFlash(false);
    const target = defaultSection ?? "general";
    setActive(target);
    // 等一帧，确保分区节点已挂载后再定位
    const raf = requestAnimationFrame(() => {
      const container = contentRef.current;
      const el = sectionRefs.current[target];
      if (container && el) container.scrollTop = Math.max(0, el.offsetTop - 8);
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, defaultSection]);

  /* ── 关于页：打开设置时读取应用名与版本号 ── */
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

  /* ── 搜索变化后，把高亮收回到首个可见分区 ── */
  useEffect(() => {
    if (!isOpen) return;
    if (visibleSections.length === 0) return;
    if (!visibleSections.some((s) => s.key === active)) {
      setActive(visibleSections[0].key);
    }
  }, [visibleSections, isOpen, active]);

  /* ── 滚动监听：左侧目录跟随高亮 ── */
  const handleScroll = useCallback(() => {
    if (lockRef.current) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = contentRef.current;
      if (!container) return;
      const top = container.scrollTop + 20;
      let current: SettingsSection | null = null;
      for (const s of visibleSections) {
        const el = sectionRefs.current[s.key];
        if (el && el.offsetTop <= top) current = s.key;
      }
      // 滚到最底部时，兜底高亮最后一个分区（避免最后一段永远选不中）
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        current = visibleSections[visibleSections.length - 1]?.key ?? current;
      }
      if (current) setActive(current);
    });
  }, [visibleSections]);

  const scrollToSection = useCallback((key: SettingsSection) => {
    const container = contentRef.current;
    const el = sectionRefs.current[key];
    if (!container || !el) return;
    setActive(key);
    lockRef.current = true;
    if (lockTimerRef.current !== null) window.clearTimeout(lockTimerRef.current);
    lockTimerRef.current = window.setTimeout(() => {
      lockRef.current = false;
      lockTimerRef.current = null;
    }, 460);
    container.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: "smooth" });
  }, []);

  useEffect(() => {
    return () => {
      if (lockTimerRef.current !== null) window.clearTimeout(lockTimerRef.current);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  /* ── 记忆：增删改 ── */
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

  /* ── 备份：导出 / 导入 ── */
  const handleExport = async () => {
    try {
      const path = await save({
        defaultPath: `fastnote-backup-${fileStamp()}.json`,
        filters: [{ name: "FastNote 备份", extensions: ["json"] }],
      });
      if (!path) return;
      setBackupBusy("export");
      const summary = await exportBackup(path, backupIncludeApiKey);
      setLastExport({ summary, path });
      showToast(
        `已导出 ${summary.notes} 篇笔记${backupIncludeApiKey ? "（含 API Key）" : ""}`,
        "success",
      );
    } catch (e) {
      showToast(`导出失败：${errorText(e)}`, "error");
    } finally {
      setBackupBusy(null);
    }
  };

  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "FastNote 备份", extensions: ["json"] }],
      });
      if (!selected || typeof selected !== "string") return;

      const ok = await confirm({
        title: "从备份恢复",
        message: `恢复会用备份文件覆盖当前的**全部**笔记、分组、回收站、AI 对话记录与设置。当前数据将被清空，无法撤销，建议先导出一份备份。\n\n备份文件：${baseName(selected)}`,
        confirmText: "覆盖并恢复",
        danger: true,
      });
      if (!ok) return;

      setBackupBusy("import");
      const summary = await importBackup(selected);
      showToast(`恢复完成：${summary.notes} 篇笔记，界面即将刷新`, "success");
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setBackupBusy(null);
      showToast(`恢复失败：${errorText(e)}`, "error");
    }
  };

  if (!isOpen) return null;

  const enabledPromptCount = aiPrompts.filter((p) => p.enabled).length;

  return (
    <>
      <div
        className="modal-overlay fixed inset-0 flex items-center justify-center z-50 p-4"
        style={{ background: "var(--color-overlay)" }}
      >
        <div className="modal-content bg-white rounded-2xl shadow-2xl w-[860px] h-[600px] max-w-[94vw] max-h-[92vh] flex flex-col overflow-hidden">
          {/* 头部 */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Icon name="ai-settings-bold" className="w-4 h-4 text-primary-500" />
              <h3 className="text-base font-semibold text-slate-800">设置</h3>
            </div>
            <div className="flex items-center gap-3">
              <span
                aria-live="polite"
                className={`hidden sm:flex items-center gap-1.5 text-[11px] text-slate-400 transition-opacity duration-500 ${
                  savedFlash ? "opacity-100" : "opacity-0"
                }`}
              >
                <Icon name="editor-check" className="w-3 h-3 text-emerald-500" />
                更改已自动保存
              </span>
              <button onClick={onClose} className="toolbar-btn hover:!bg-slate-100" title="关闭设置">
                <Icon name="modal-close" className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* 左侧目录 */}
            <div className="w-[186px] flex-shrink-0 border-r border-slate-100 flex flex-col bg-slate-50/40">
              <div className="p-2.5 flex-shrink-0">
                <div className="relative">
                  <Icon
                    name="sidebar-search"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-300 pointer-events-none"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索设置..."
                    className="w-full pl-8 pr-2 py-1.5 text-xs input-modern"
                  />
                </div>
              </div>
              <nav className="flex-1 overflow-y-auto chat-scrollbar px-2 pb-3">
                {GROUPS.map((group) => {
                  const items = visibleSections.filter((s) => s.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div key={group} className="mb-1">
                      <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold text-slate-300 uppercase tracking-wider">
                        {group}
                      </div>
                      {items.map((s) => (
                        <button
                          key={s.key}
                          onClick={() => scrollToSection(s.key)}
                          className={`w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-xs font-medium transition-colors ${
                            active === s.key
                              ? "bg-primary-50 text-primary-600"
                              : "text-slate-500 hover:bg-slate-100/70"
                          }`}
                        >
                          <Icon
                            name={s.icon}
                            className={`w-3.5 h-3.5 flex-shrink-0 ${active === s.key ? "opacity-100" : "opacity-70"}`}
                          />
                          <span className="truncate">{s.label}</span>
                          {active === s.key && (
                            <span className="ml-auto w-1 h-1 rounded-full bg-primary-500 flex-shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
                {visibleSections.length === 0 && (
                  <p className="px-3 py-6 text-center text-[11px] text-slate-400">没有匹配的设置项</p>
                )}
              </nav>
            </div>

            {/* 右侧设置项 */}
            <div
              ref={contentRef}
              onScroll={handleScroll}
              className="relative flex-1 min-w-0 overflow-y-auto chat-scrollbar px-6 py-5"
            >
              {visibleSections.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-400">
                  <Icon name="sidebar-search" className="w-8 h-8 text-slate-200" />
                  <p className="text-sm">没有找到相关设置</p>
                  <p className="text-[11px] text-slate-300">换个关键词试试</p>
                </div>
              ) : (
                visibleSections.map((s) => {
                  const sectionRows = visibleRowsOf(s.key);
                  return (
                    <section
                      key={s.key}
                      ref={(el) => {
                        sectionRefs.current[s.key] = el;
                      }}
                      data-section={s.key}
                      className="mb-8 last:mb-2"
                    >
                      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-100">
                        <span className="w-6 h-6 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                          <Icon name={s.icon} className="w-3.5 h-3.5 text-primary-500" />
                        </span>
                        <h4 className="text-sm font-semibold text-slate-700">{s.label}</h4>
                      </div>

                      {/* 数据驱动的行 */}
                      {sectionRows.length > 0 && (
                        <div className="divide-y divide-slate-100">
                          {sectionRows.map((row) => (
                            <RowView key={`${row.section}.${row.title}`} row={row} />
                          ))}
                        </div>
                      )}

                      {/* 软件默认值 */}
                      {s.key === "general" && (
                        <div className="pt-3">
                          <button
                            onClick={onResetAppSettings}
                            className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                          >
                            恢复软件默认设置
                          </button>
                        </div>
                      )}

                      {/* AI 默认值 */}
                      {s.key === "context" && (
                        <div className="pt-3">
                          <button
                            onClick={() => onAiSettingsChange({ ...DEFAULT_AI_SETTINGS })}
                            className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                          >
                            恢复 AI 默认设置
                          </button>
                        </div>
                      )}

                      {/* AI 服务商 */}
                      {s.key === "provider" && (
                        <div className="rounded-xl border border-slate-200 p-3.5">
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

                      {/* AI 记忆 / 前置提示词 */}
                      {s.key === "memory" && (
                        <div className="space-y-3">
                          <p className="text-[11px] text-slate-400 leading-relaxed">
                            启用中的每一条都会加在<strong className="text-slate-500">每次请求</strong>的系统提示词末尾，
                            既可作默认要求（如「回答先给结论」），也可当作长期记忆。
                          </p>

                          <div className="space-y-2">
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
                              placeholder="输入一条要求或记忆，回车添加（Shift+回车换行）"
                              className="w-full resize-none px-3 py-2 text-xs input-modern bg-slate-50/50 focus:bg-white transition-colors"
                            />
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] text-slate-400">回车即可添加</span>
                              <button
                                onClick={addPrompt}
                                disabled={!memoryDraft.trim()}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                添加
                              </button>
                            </div>
                          </div>

                          {/* 条目多了就内部滚动，避免把整页设置撑得特别长 */}
                          <div className="space-y-2 max-h-[260px] overflow-y-auto chat-scrollbar pr-1 -mr-1">
                            {aiPrompts.length === 0 && (
                              <div className="py-6 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl">
                                还没有内容。添加一条试试，例如「回答尽量简短，先给结论」。
                              </div>
                            )}
                            {aiPrompts.map((entry) => (
                              <div
                                key={entry.id}
                                className={`group rounded-xl border px-3 py-2 transition-colors ${
                                  entry.enabled ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/60"
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
                                      className="w-full resize-none px-2.5 py-1.5 text-xs input-modern bg-white"
                                    />
                                    <div className="flex justify-end gap-1.5">
                                      <button
                                        onClick={() => setEditingPromptId(null)}
                                        className="px-2.5 py-1 text-[11px] text-slate-500 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                                      >
                                        取消
                                      </button>
                                      <button
                                        onClick={savePromptEdit}
                                        className="px-2.5 py-1 text-[11px] text-white bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors"
                                      >
                                        保存
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-start gap-2">
                                    <button
                                      onClick={() => togglePrompt(entry.id)}
                                      title={entry.enabled ? "已启用，点击停用" : "已停用，点击启用"}
                                      aria-pressed={entry.enabled}
                                      className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${
                                        entry.enabled
                                          ? "bg-primary-500 border-primary-500 text-white"
                                          : "bg-white border-slate-300"
                                      }`}
                                    >
                                      {entry.enabled && <Icon name="memory-check" className="w-3 h-3" />}
                                    </button>
                                    <p
                                      className={`flex-1 min-w-0 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                                        entry.enabled ? "text-slate-700" : "text-slate-400"
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
                                        className="px-1.5 py-1 text-[11px] text-slate-400 hover:text-primary-500 rounded-md hover:bg-primary-50 transition-colors"
                                      >
                                        编辑
                                      </button>
                                      <button
                                        onClick={() => removePrompt(entry.id)}
                                        className="px-1.5 py-1 text-[11px] text-slate-400 hover:text-red-500 rounded-md hover:bg-red-50 transition-colors"
                                      >
                                        删除
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>

                          <p className="text-[11px] text-slate-400">
                            共 {aiPrompts.length} 条，其中{" "}
                            <strong className="text-slate-600">{enabledPromptCount}</strong> 条已启用
                          </p>
                        </div>
                      )}

                      {/* 备份与恢复 */}
                      {s.key === "backup" && (
                        <div className="space-y-3">
                          <p className="text-[11px] text-slate-400 leading-relaxed">
                            备份内容包含笔记、分组、回收站、AI 对话记录与设置；可选择是否一并备份
                            AI 服务商的 API Key。
                          </p>

                          <div className="flex items-start justify-between gap-6 px-3 py-2.5 rounded-xl bg-slate-50 border border-slate-100">
                            <div className="min-w-0">
                              <span className="text-xs font-medium text-slate-700">备份 API Key</span>
                              <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                                勾选后会把服务商的 API Key 解密成
                                <b className="text-slate-500">明文</b>
                                写入备份文件（请妥善保管）；不勾选则只保留服务商配置、不含 Key。
                              </p>
                            </div>
                            <div className="flex-shrink-0 pt-0.5">
                              <Switch value={backupIncludeApiKey} onChange={setBackupIncludeApiKey} />
                            </div>
                          </div>

                          <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                            <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                              <Icon name="app-backup" className="w-4 h-4 text-primary-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-700">导出备份</p>
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                保存为一个 JSON 文件，可放到网盘或 U 盘带走。
                              </p>
                              {lastExport && (
                                <p className="text-[11px] text-emerald-600 mt-1 truncate" title={lastExport.path}>
                                  已导出：{baseName(lastExport.path)} · {lastExport.summary.notes} 篇笔记 ·{" "}
                                  {lastExport.summary.messages} 条对话消息
                                </p>
                              )}
                            </div>
                            <button
                              onClick={handleExport}
                              disabled={backupBusy !== null}
                              className="btn-primary px-3 py-1.5 text-xs flex-shrink-0 disabled:opacity-50"
                            >
                              {backupBusy === "export" ? "导出中..." : "导出"}
                            </button>
                          </div>

                          <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                            <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
                              <Icon name="app-restore" className="w-4 h-4 text-amber-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-700">从备份恢复</p>
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                选择备份文件后覆盖当前数据；备份里带 API Key 时会重新加密写入，同机恢复会保留已填好的 Key。
                              </p>
                            </div>
                            <button
                              onClick={handleImport}
                              disabled={backupBusy !== null}
                              className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-100 rounded-xl hover:bg-amber-200 transition-colors flex-shrink-0 disabled:opacity-50"
                            >
                              {backupBusy === "import" ? "恢复中..." : "选择文件"}
                            </button>
                          </div>

                          {lastExport?.summary.exported_at && (
                            <p className="text-[11px] text-slate-400">
                              本次导出时间：{prettyTime(lastExport.summary.exported_at)}
                            </p>
                          )}
                        </div>
                      )}

                      {/* 关于：软件名 / 作者 / 版本 */}
                      {s.key === "about" && (
                        <div className="rounded-xl border border-slate-200 p-4">
                          <div className="flex items-center gap-3">
                            <img
                              src="/icons/app-logo.png"
                              alt={`${appName} 图标`}
                              draggable={false}
                              className="rounded-lg object-contain flex-shrink-0 select-none"
                              style={{ width: 30, height: 30 }}
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-slate-800">{appName}</p>
                              <p className="text-[11px] text-slate-400 mt-0.5">作者：{APP_AUTHOR}</p>
                            </div>
                          </div>
                          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[12px]">
                            <span className="text-slate-400">版本</span>
                            <span className="text-slate-600 font-medium">{appVersion || "—"}</span>
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
    </>
  );
};