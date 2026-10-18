/**
 * 大纲面板：由解析结果的顶层标题生成，点击跳转到对应行。
 *
 * 跳转行为交给上层（`onSelect`）：在源码/分栏模式下滚编辑器，在阅读/实时模式下滚预览，
 * 面板本身不关心当前是哪种模式。
 */
import type { MarkdownEditorConfig, OutlineItem } from "../types";

interface OutlineProps {
  items: OutlineItem[];
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  activeLine: number;
  onSelect: (item: OutlineItem) => void;
}

export const Outline: React.FC<OutlineProps> = ({ items, config, labels, activeLine, onSelect }) => {
  const visible = items.filter((item) => item.level <= config.outline.maxDepth);
  // 当前高亮：最后一个行号不超过光标行的标题
  let activeId = "";
  for (const item of visible) {
    if (item.line <= activeLine) activeId = item.id;
  }

  return (
    <aside
      className={`mde-outline is-${config.outline.position}`}
      style={{ width: config.outline.width }}
      aria-label={config.outline.title}
    >
      <div className="mde-outline-head">{config.outline.title}</div>
      <div className="mde-outline-body">
        {visible.length === 0 ? (
          <div className="mde-outline-empty">{labels.outlineEmpty}</div>
        ) : (
          visible.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`mde-outline-item${item.id === activeId ? " is-active" : ""}`}
              style={{
                paddingLeft: config.outline.indent ? 12 + (item.level - 1) * 12 : 12,
                fontWeight: item.level === 1 ? 600 : 400,
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item)}
              title={item.text}
            >
              {item.text || labels.outlineEmpty}
            </button>
          ))
        )}
      </div>
    </aside>
  );
};
