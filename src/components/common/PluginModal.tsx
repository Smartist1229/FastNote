/**
 * 插件系统的通用 Modal：宿主统一风格，插件通过 ctx.ui.modal({...}) Promise 化调用。
 *
 * 内部走一个全局队列（见 src/plugins/host.ts 的 showPluginModal），
 * 本组件用 useSyncExternalStore 订阅队列头，串着渲染（同一时刻只一个 Modal 可见）。
 *
 * 三种使用方式：
 *   1. 简单确认框：title + content(string) + confirmText/cancelText/danger，默认 modal 模式。
 *   2. 非模态浮层：mode="non-modal"，不铺遮罩、点外部自动关闭，适合右下角小型设置面板。
 *   3. 自定义内容 + 自定义按钮：content 传 (api) => ReactNode，api 提供 close/ok/cancel；
 *      可同时传 buttons 数组替代默认的 confirm/cancel 按钮。
 *      返回原生 DOM 节点（插件自己 createElement 拼的）也行：React 不认原生节点，
 *      这里用一个容器把它 appendChild 进去（见 DomMount），插件的 HTML 弹窗就是这么落地的。
 *   另：render 传 ctx.editor.render(md) 句柄或 Markdown 字符串时，用编辑器纯渲染模式展示正文。
 *
 * 取消按钮永远显示（除非传了自定义 buttons）；关闭按钮（右上角 ×）始终按取消结算。
 * 确认按钮 danger=true 时样式变红，其他复用 ConfirmDialog 的 danger 样式。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useI18n } from "@/i18n";
import type { TranslationParams } from "@/i18n";
import { Modal } from "@/components/common/Modal";
import { sanitizePluginHtml } from "@/plugins/sanitize";
import { MarkdownRenderView } from "@/components/common/MarkdownRender";
import {
  subscribePluginModal,
  snapshotPluginModal,
  resolvePluginModal,
} from "@/plugins/host";
import type {
  PluginModalApi,
  PluginModalOptions,
} from "@/interface/app/ui";

/**
 * 原生 DOM 节点的挂载容器：插件的 content 回调返回 Element / DocumentFragment 时用它。
 * React 不认 "把 DOM 节点当 child"（报 Objects are not valid as a React child），
 * 所以这里给个空 div，在 effect 里 appendChild；节点换了 / 弹窗卸载时摘掉。
 */
const DomMount: React.FC<{ node: Node }> = ({ node }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.appendChild(node);
    return () => {
      if (node.parentNode === host) host.removeChild(node);
    };
  }, [node]);
  return <div ref={hostRef} />;
};

/** 判断插件给的是不是原生 DOM 节点（Node 在浏览器里才有，避免 SSR / 测试环境炸） */
const isDomNode = (value: unknown): value is Node =>
  typeof Node !== "undefined" && value instanceof Node;

/** 渲染 modal：useSyncExternalStore 已经保证 subscribe 了队列变更 */
export const PluginModal: React.FC = () => {
  const { t } = useI18n();
  const options = useSyncExternalStore(subscribePluginModal, snapshotPluginModal, snapshotPluginModal);
  if (!options) return null;

  return <PluginModalInner options={options} t={t} />;
};

const PluginModalInner: React.FC<{
  options: PluginModalOptions;
  t: (key: string, params?: TranslationParams) => string;
}> = ({ options, t }) => {
  const {
    title,
    content,
    render,
    html,
    confirmText = "确定",
    cancelText = "取消",
    danger = false,
    mode = "modal",
    closeOnExternalClick = true,
    buttons,
    size,
    height,
  } = options;

  const isModal = mode === "modal";
  /** render（Markdown 正文）模式：与历史版本对比弹窗同规格——2xl 宽、固定高、内容区滚动 */
  const isRender = render != null;
  /** html 模式：沙箱插件只能交字符串，宿主消毒后插入（直接 innerHTML 会把沙箱白干） */
  const isHtml = typeof html === "string";

  /** PluginModalApi：插件 content 函数会拿到，用于主动关闭弹窗 */
  const apiRef = useRef<PluginModalApi>({
    close: (result?: unknown) => {
      if (result === false) resolvePluginModal(false);
      else resolvePluginModal(true, result);
    },
    ok: (value?: unknown) => resolvePluginModal(true, value),
    cancel: () => resolvePluginModal(false),
  });

  /** 自定义 content：render 优先（编辑器纯渲染）；字符串渲染 <p>；函数调用并传入 PluginModalApi */
  let body: React.ReactNode;
  if (isHtml) {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto chat-scrollbar rounded-lg border border-line-soft bg-surface p-3">
        <div className="plugin-html" dangerouslySetInnerHTML={{ __html: sanitizePluginHtml(html) }} />
      </div>
    );
  } else if (isRender) {
    const markdown = typeof render === "string" ? render : render.markdown;
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto chat-scrollbar rounded-lg border border-line-soft bg-surface p-3">
        <MarkdownRenderView markdown={markdown} />
      </div>
    );
  } else if (typeof content === "function") {
    const node = content(apiRef.current);
    // 插件自己拼的 DOM（弹窗自绘）走挂载容器，React 元素原样交给 React
    body = isDomNode(node) ? <DomMount node={node} /> : node;
  } else if (typeof content === "string") {
    body = <p className="text-sm text-body leading-relaxed">{t(content)}</p>;
  }

  /**
   * 非模态浮层：Modal floating 本身没有遮罩、pointer-events-none 让底下 UI 可点。
   * 点弹窗外关闭用 document pointerdown 监听实现——只要事件不是在弹窗 DOM 里触发的就 ok=false。
   */
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isModal || !closeOnExternalClick) return;
    const handler = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      if (cardRef.current && !cardRef.current.contains(e.target)) {
        resolvePluginModal(false);
      }
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [isModal, closeOnExternalClick]);

  const onConfirm = () => resolvePluginModal(true);
  const onCancel = () => resolvePluginModal(false);

  /** 渲染底部按钮区：自定义 buttons 有就用它，否则 confirm/cancel 双按钮 */
  const renderButtons = () => {
    if (buttons && buttons.length > 0) {
      return (
        <div className="flex gap-2 justify-end pt-1">
          {buttons.map((btn, idx) => {
            const handle = () => {
              const keepOpen = btn.onClick?.();
              if (keepOpen !== false) resolvePluginModal(true);
            };
            const isDanger = btn.danger === true;
            const className = isDanger
              ? "px-4 py-2 text-sm font-medium text-on-accent bg-danger rounded-xl hover:bg-danger-strong transition-colors shadow-xs"
              : "btn-primary px-4 py-2 text-sm";
            // 最后一个按钮拿 autoFocus，插件不传顺序就走"主操作在右"惯例
            return (
              <button
                key={idx}
                onClick={handle}
                autoFocus={idx === buttons!.length - 1}
                className={idx === buttons!.length - 1 && !isDanger ? className : isDanger ? className : "btn-ghost px-4 py-2 text-sm"}
              >
                {t(btn.label)}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel} className="btn-ghost px-4 py-2 text-sm">
          {t(cancelText)}
        </button>
        <button
          onClick={onConfirm}
          autoFocus
          className={
            danger
              ? "px-4 py-2 text-sm font-medium text-on-accent bg-danger rounded-xl hover:bg-danger-strong transition-colors shadow-xs"
              : "btn-primary px-4 py-2 text-sm"
          }
        >
          {t(confirmText)}
        </button>
      </div>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={title ? t(title) : ""}
      zIndex={100}
      floating={!isModal}
      size={size ?? (isRender || isHtml ? "2xl" : undefined)}
      height={height ?? (isRender || isHtml ? "min(78vh, 760px)" : undefined)}
    >
      {isRender ? (
        <div ref={cardRef} className="flex h-full min-h-0 flex-col">
          {body}
          <div className="flex-shrink-0 pt-3">{renderButtons()}</div>
        </div>
      ) : (
        <div ref={cardRef} className="space-y-4">
          <div onKeyDown={(e) => {
            if (e.key === "Enter" && (!buttons || buttons.length === 0)) onConfirm();
          }}>
            {body}
          </div>
          {renderButtons()}
        </div>
      )}
    </Modal>
  );
};
