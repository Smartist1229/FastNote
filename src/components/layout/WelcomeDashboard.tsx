/**
 * 首页面板：没有选中笔记时占据 App 的主内容区。
 *
 * 结构自上而下：问候语 → 概览三卡 → 快捷入口 → 最近更新（无笔记时换成空状态卡）。
 * 纯展示组件：不读库、不派发事件，统计数字与回调全部由 App 传入。
 *
 * 关键约束：
 * - 背景是主内容区的 bg-surface（白），因此卡片一律靠 border + bg-app 拉开层次，
 *   不能再用「白色卡片」——白叠白看不出边界。
 * - 颜色只用语义类名（bg-surface / text-faint / border-line …），换主题与切暗色全靠 CSS 变量。
 * - 圆角只用 rounded-*（映射到 --radius-*），不写死像素。
 * - 列表摘要由 note.content 现算（剥掉 Markdown 标记），不额外引字段，因此不动数据结构。
 */
import type { Note } from "@/interface/note";
import type { WelcomeDashboardProps } from "@/interface/welcome";
import { AiSparkleIcon } from "@/components/common/icons";
import { Icon } from "@/components/common/Icon";

/** 一周七天，日期行拼「周X」用 */
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 行首块级标记：标题 / 引用 / 列表 / 任务项 / 有序项 */
const BLOCK_MARK = /^(?:#{1,6}\s+|>\s+|[-*+]\s+|\[[ xX]\]\s+|\d+\.\s+)/;

/** 按小时分档的问候语（6 / 9 / 12 / 14 / 18 / 22 点为界） */
const greetingFor = (hour: number): string => {
  if (hour < 6) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  if (hour < 22) return "晚上好";
  return "夜深了";
};

/** 相对时间：1 分钟内「刚刚」，7 天内按分 / 时 / 天，再久只给 MM-DD（不带年份） */
const formatRelative = (iso: string): string => {
  // new Date 遇到非法字符串不抛错，只会得到 Invalid Date，必须显式判断
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;

  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}-${day}`;
};

/** 悬停用的完整时间：YYYY-MM-DD HH:mm */
const formatAbsolute = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 取正文首行做摘要：跳过代码块、分隔线、以及和标题重复的行（`# 标题` 很常见），
 * 剥掉强调 / 行内代码 / 链接等行内标记。取不到就返回空串，由调用方兜底文案。
 */
const toSnippet = (content: string, title: string, max = 56): string => {
  if (!content) return "";
  const heading = title.trim();
  let inFence = false;
  for (const raw of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // 围栏内、以及 front matter / 分隔线都不算正文
    if (inFence || /^(?:-{3,}|\*{3,})$/.test(line)) continue;
    const text = line
      .replace(BLOCK_MARK, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text || text === heading) continue;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return "";
};

/** 小节标题：左侧 11px 弱化小标，右侧可选的计数 */
const SectionTitle: React.FC<{ title: string; meta?: string }> = ({ title, meta }) => (
  <div className="flex items-baseline justify-between gap-3">
    <h2 className="text-[11px] font-semibold tracking-[0.08em] text-faint">{title}</h2>
    {meta ? <span className="text-[11px] tabular-nums text-faint-soft">{meta}</span> : null}
  </div>
);

/** 概览里的一个指标：图标 + 名称在上，数字在下 */
const StatTile: React.FC<{
  icon: string;
  label: string;
  value: number;
  onClick?: () => void;
  title?: string;
}> = ({ icon, label, value, onClick, title }) => {
  const shell =
    "w-full rounded-xl bg-app px-3.5 py-3 transition-colors duration-200 ease-soft text-left";
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-primary-50 text-primary-600">
          <Icon name={icon} className="h-3.5 w-3.5" />
        </span>
        <span className="truncate text-[11px] text-faint">{label}</span>
      </div>
      <div className="mt-2 text-[20px] font-semibold leading-none tabular-nums text-ink">{value}</div>
    </>
  );

  // 只有回收站可点（跳回收站），其余是纯展示，不给 hover 以免误导成可点
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={`${shell} hover:bg-surface-alt`}>
      {body}
    </button>
  ) : (
    <div className={shell}>{body}</div>
  );
};

/** 快捷入口卡片：图标 + 标题 + 一行说明，hover 时右侧箭头滑入 */
const ActionTile: React.FC<{
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick?: () => void;
  /** 主推入口：常驻淡强调底色 */
  primary?: boolean;
  /** 开关类入口的激活态（如 AI 面板已展开） */
  active?: boolean;
}> = ({ icon, title, desc, onClick, primary = false, active = false }) => (
  <button
    type="button"
    onClick={onClick}
    title={desc}
    aria-pressed={active || undefined}
    className={[
      "group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left",
      "transition-all duration-200 ease-soft hover:border-primary-300 hover:shadow-card",
      active
        ? "border-primary-300 bg-primary-50"
        : primary
          ? "border-primary-200 bg-primary-50/60"
          : "border-line bg-surface hover:bg-app",
    ].join(" ")}
  >
    <span
      className={[
        "flex h-9 w-9 flex-none items-center justify-center rounded-lg transition-colors duration-200",
        primary || active ? "bg-primary-100/70 text-primary-600" : "bg-surface-alt text-muted group-hover:bg-primary-50 group-hover:text-primary-600",
      ].join(" ")}
    >
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <span
        className={[
          "block truncate text-[13px] font-medium transition-colors duration-200 group-hover:text-primary-700",
          primary || active ? "text-primary-700" : "text-body",
        ].join(" ")}
      >
        {title}
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-faint">{desc}</span>
    </span>
    <Icon
      name="welcome-chevron-right"
      className="h-3.5 w-3.5 flex-none -translate-x-1 text-faint-soft opacity-0 transition-all duration-200 ease-soft group-hover:translate-x-0 group-hover:text-primary-400 group-hover:opacity-100"
    />
  </button>
);

/** 最近更新的一行：标题 + 摘要 + 时间 */
const RecentRow: React.FC<{ note: Note; onSelect: (note: Note) => void }> = ({ note, onSelect }) => (
  <button
    type="button"
    onClick={() => onSelect(note)}
    className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-200 first:rounded-t-xl last:rounded-b-xl hover:bg-app"
  >
    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-alt text-faint transition-colors duration-200 group-hover:bg-primary-50 group-hover:text-primary-600">
      <Icon name="sidebar-note" className="h-3.5 w-3.5" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-body transition-colors duration-200 group-hover:text-ink">
          {note.title || "无标题"}
        </span>
        {note.is_pinned ? <Icon name="sidebar-star-filled" className="h-3 w-3 flex-none text-warning" /> : null}
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-faint">
        {toSnippet(note.content, note.title) || "暂无内容"}
      </span>
    </span>
    <span
      className="flex-none text-[11px] tabular-nums text-faint-soft"
      title={formatAbsolute(note.updated_at)}
    >
      {formatRelative(note.updated_at)}
    </span>
  </button>
);

export const WelcomeDashboard: React.FC<WelcomeDashboardProps> = ({
  totalNotes,
  categoryCount,
  trashCount,
  recentNotes,
  onCreateNote,
  onOpenTrash,
  onOpenTextFile,
  onSelectNote,
  onToggleAiPanel,
  isAiPanelOpen = false,
}) => {
  const now = new Date();
  const dateLine = `${now.getMonth() + 1}月${now.getDate()}日 · 周${WEEKDAYS[now.getDay()]}`;
  const hasNotes = totalNotes > 0;
  const recent = recentNotes.slice(0, 5);

  const actions: React.ReactNode[] = [
    <ActionTile
      key="new"
      primary
      icon={<Icon name="welcome-plus" className="h-4 w-4" />}
      title="新建笔记"
      desc="从空白页开始写"
      onClick={onCreateNote}
    />,
  ];
  if (onToggleAiPanel) {
    actions.push(
      <ActionTile
        key="ai"
        active={isAiPanelOpen}
        icon={<AiSparkleIcon className="h-4 w-4" />}
        title="AI 助手"
        desc={isAiPanelOpen ? "面板已展开，点击收起" : "让 AI 帮你写和整理"}
        onClick={onToggleAiPanel}
      />,
    );
  }
  if (onOpenTextFile) {
    actions.push(
      <ActionTile
        key="file"
        icon={<Icon name="ai-file-text" className="h-4 w-4" />}
        title="打开文本文件"
        desc="编辑电脑上的文件，实时保存"
        onClick={onOpenTextFile}
      />,
    );
  }
  actions.push(
    <ActionTile
      key="trash"
      icon={<Icon name="app-trash" className="h-4 w-4" />}
      title="回收站"
      desc={trashCount > 0 ? `${trashCount} 篇待处理` : "找回已删除的笔记"}
      onClick={onOpenTrash}
    />,
  );

  return (
    <div className="h-full w-full min-w-0 overflow-y-auto overflow-x-hidden bg-surface">
      {/* 底部留白放在内层而不是滚动容器上：内容高过容器时，容器的 padding 落不到最后一项之后 */}
      <div className="mx-auto w-full max-w-[760px] px-8 pb-10 pt-9">
        {/* 问候语 */}
        <header className="animate-slideUp flex items-start gap-3.5">
          <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-glow">
            <Icon name="welcome-edit" className="h-5 w-5 text-on-accent" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">
              {greetingFor(now.getHours())}
            </h1>
            <p className="mt-1 truncate text-[13px] text-muted">
              {dateLine}
              {hasNotes ? ` · 已记录 ${totalNotes} 篇笔记` : " · 开始记录你的第一个想法"}
            </p>
          </div>
        </header>

        {/* 概览：全是 0 说明是全新用户，展示一排 0 反而像报错，直接跳过 */}
        {hasNotes && (
          <section className="mt-8 animate-slideUp" style={{ animationDelay: "0.05s" }}>
            <div className="grid grid-cols-3 gap-2.5">
              <StatTile icon="sidebar-note" label="笔记" value={totalNotes} />
              <StatTile icon="sidebar-folder" label="分组" value={categoryCount} />
              <StatTile
                icon="app-trash"
                label="回收站"
                value={trashCount}
                onClick={onOpenTrash}
                title="打开回收站"
              />
            </div>
          </section>
        )}

        {/* 快捷入口 */}
        <section className="mt-8 animate-slideUp" style={{ animationDelay: "0.1s" }}>
          <SectionTitle title="快捷开始" />
          <div className="mt-3 grid grid-cols-2 gap-2.5">{actions}</div>
        </section>

        {/* 最近更新 */}
        {recent.length > 0 && (
          <section className="mt-8 animate-slideUp" style={{ animationDelay: "0.15s" }}>
            <SectionTitle title="最近更新" meta={`${recent.length} 篇`} />
            <div className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line-soft bg-surface">
              {recent.map((note) => (
                <RecentRow key={note.id} note={note} onSelect={onSelectNote} />
              ))}
            </div>
          </section>
        )}

        {/* 空状态：替代最近更新，给出唯一的下一步动作 */}
        {!hasNotes && (
          <section className="mt-8 animate-slideUp" style={{ animationDelay: "0.15s" }}>
            <div className="flex flex-col items-center rounded-2xl border border-dashed border-line bg-app px-8 py-12 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-50 text-primary-500">
                <Icon name="welcome-file-empty" className="h-7 w-7" />
              </span>
              <p className="mt-4 text-[15px] font-semibold text-ink">还没有笔记</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
                写下第一篇，或者把电脑上的文本文件拖进来
              </p>
              <button
                type="button"
                onClick={onCreateNote}
                className="btn-primary mt-5 flex items-center gap-1.5 px-4 py-2 text-[13px]"
              >
                <Icon name="welcome-plus" className="h-4 w-4" />
                创建第一篇笔记
              </button>
            </div>
          </section>
        )}

        <p className="mt-9 text-center text-[11px] text-faint-soft">
          把 .md / .txt 文件拖到左侧分组即可导入
        </p>
      </div>
    </div>
  );
};
