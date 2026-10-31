/**
 * 状态栏：字数/字符/行数/阅读时长/光标位置/当前模式，全部可按配置开关。
 */
import type { MarkdownEditorConfig, MarkdownEditorMode, MarkdownStats } from "../types";

interface StatusBarProps {
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  stats: MarkdownStats;
  mode: MarkdownEditorMode;
}

export const StatusBar: React.FC<StatusBarProps> = ({ config, labels, stats, mode }) => {
  const bar = config.statusBar;
  const items: { key: string; text: string; title?: string }[] = [];
  if (bar.words) items.push({ key: "words", text: `${stats.words} ${labels.words}` });
  if (bar.chars) items.push({ key: "chars", text: `${stats.charsNoSpace} ${labels.chars}` });
  if (bar.lines) items.push({ key: "lines", text: `${stats.lines} ${labels.lines}` });
  if (bar.cursor) items.push({ key: "cursor", text: `${labels.cursor} ${stats.cursor.line}:${stats.cursor.column}` });
  if (bar.readingTime) items.push({ key: "reading", text: `≈ ${stats.readingMinutes} ${labels.readingTime}` });

  return (
    <div className="mde-status">
      <div className="mde-status-left">
        {items.map((item, index) => (
          <span className="mde-status-item" key={item.key}>
            {index > 0 && <span className="mde-status-dot" aria-hidden="true" />}
            {item.text}
          </span>
        ))}
      </div>
      {bar.mode && <span className="mde-status-mode">{labels[`mode.${mode}`]}</span>}
    </div>
  );
};
