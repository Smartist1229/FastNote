/**
 * 编辑区选中文本后浮出的 AI 工具条（润色 / 翻译 / 总结）。
 *
 * 不改编辑器组件：用 document 级 selectionchange 观察选区，只认完全落在
 * `.mde-content`（源码编辑区）里的选区，浮层自己用 fixed 定位贴在选区上方。
 *
 * 三条硬约束：
 * - 不打断输入：按下按钮时 preventDefault，编辑器不失焦、选区也不会被收起；
 *   拖选过程中不显示，松手后才出现，避免浮层挡住鼠标；
 * - 不自动发送：只把拼好的提示词追加到 AI 面板的草稿末尾，发不发由用户按回车决定；
 * - 不碰只读场景：历史预览、AI 回复的渲染区都没有可编辑的 `.mde-content`，天然不触发。
 */
import { useEffect, useRef, useState } from "react";
import { getLocale, useI18n } from "@/i18n";
import { Icon } from "@/components/common/Icon";

export type SelectionAiAction = "polish" | "translate" | "summarize";

interface Anchor {
  text: string;
  top: number;
  bottom: number;
  center: number;
}

/** 选区里已经有三反引号时换成四反引号围栏，避免把用户的代码截断 */
const fenced = (text: string) => {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}\n${text}\n${fence}`;
};

/**
 * 把动作 + 选中文本拼成提示词。
 * 这里不走 t()：这段文字是发给模型的任务描述，跟着界面语言走即可，
 * 也不需要出现在翻译词典里。
 */
export const buildSelectionPrompt = (action: SelectionAiAction, text: string): string => {
  const body = fenced(text);
  const zh = getLocale() === "zh-CN";
  if (action === "polish") {
    return zh
      ? `请润色下面这段文字，保持原意与原有语气，让表达更通顺自然。只返回润色后的文本：\n\n${body}`
      : `Polish the following text. Keep the original meaning and tone, and make it read more naturally. Return only the revised text:\n\n${body}`;
  }
  if (action === "translate") {
    return zh
      ? `请把下面这段文字翻译成英文。只返回译文：\n\n${body}`
      : `Translate the following text into Chinese. Return only the translation:\n\n${body}`;
  }
  return zh
    ? `请用简洁的要点总结下面这段文字，语言与原文保持一致。只返回总结：\n\n${body}`
    : `Summarize the following text in concise bullet points, in the same language as the original. Return only the summary:\n\n${body}`;
};

const ACTIONS: { action: SelectionAiAction; label: string }[] = [
  { action: "polish", label: "润色" },
  { action: "translate", label: "翻译" },
  { action: "summarize", label: "总结" },
];

export const SelectionAiToolbar: React.FC<{ onPrompt: (text: string) => void }> = ({ onPrompt }) => {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    /** 拖选期间不弹：松手前浮层会一直追着鼠标跑，还容易吃掉 mouseup */
    let dragging = false;

    const update = () => {
      frameRef.current = null;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setAnchor(null);
        return;
      }
      const text = selection.toString();
      // 单个字符多半是误触（点选、双击标点），不值得弹一次浮层
      if (text.trim().length < 2) {
        setAnchor(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const resolve = (node: Node) =>
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement;
      const box = resolve(range.startContainer)?.closest(".mde-content");
      // 起止点必须落在同一个编辑区：跨区选择（编辑器 → 预览 / AI 面板）不处理
      if (!box || box !== resolve(range.endContainer)?.closest(".mde-content")) {
        setAnchor(null);
        return;
      }
      // 只读状态下 contenteditable 是 false，此时给 AI 工具条没有意义
      if (!(box as HTMLElement).isContentEditable) {
        setAnchor(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setAnchor(null);
        return;
      }
      setAnchor({
        text,
        top: rect.top,
        bottom: rect.bottom,
        center: rect.left + rect.width / 2,
      });
    };

    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(update);
    };

    const onSelectionChange = () => {
      if (dragging) return;
      schedule();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".mde-content")) return;
      dragging = true;
      setAnchor(null);
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      schedule();
    };

    /** 滚动 / 缩放后选区矩形已经失效，直接收起，等用户重新选择 */
    const dismiss = () => setAnchor(null);

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("keyup", onSelectionChange);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("keyup", onSelectionChange);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  if (!anchor) return null;

  const above = anchor.top > 56;
  const center = Math.min(Math.max(anchor.center, 120), window.innerWidth - 120);
  const style = above
    ? { left: center, top: anchor.top - 8, transform: "translate(-50%, -100%)" }
    : { left: center, top: anchor.bottom + 8, transform: "translateX(-50%)" };

  return (
    <div className="selection-ai-bar" style={style} role="toolbar" aria-label={t("AI 工具条")}>
      <Icon name="ai-chat" className="w-3.5 h-3.5 flex-none text-primary-500" />
      {ACTIONS.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          className="selection-ai-action"
          // 关键：把焦点与选区留在编辑器里，否则点一下按钮选区就没了
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const prompt = buildSelectionPrompt(action, anchor.text);
            setAnchor(null);
            onPrompt(prompt);
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
};
