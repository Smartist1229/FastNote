import { useI18n } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConfirmOptions } from "@/interface/app/ui";
import { Modal } from "@/components/common/Modal";

/** 确认弹窗本体：不对外导出，只由 useConfirm 渲染；options 为 null 时整体不渲染 */
const ConfirmDialog: React.FC<{
  isOpen: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** 挂载即回调：给 useConfirm 判断「调用方到底有没有把这个弹窗渲染出来」 */
  onMount: () => void;
}> = ({ isOpen, options, onConfirm, onCancel, onMount }) => {
  const { t } = useI18n();
  useEffect(() => {
    onMount();
  }, [onMount]);
  if (!options) return null;
  const { title, message, confirmText = "确定", cancelText = "取消", danger } = options;
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={t(title)} zIndex={100}>
      {/* Enter 绑定在容器上靠冒泡生效，因此确认按钮必须 autoFocus，否则键盘无法确认 */}
      <div className="space-y-4" onKeyDown={(e) => { if (e.key === "Enter") onConfirm(); }}>
        <p className="text-sm text-body leading-relaxed">{typeof message === "string" ? t(message) : message}</p>
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
      </div>
    </Modal>
  );
};

/**
 * 主题化确认弹窗，对外提供 Promise 化的 confirm：`const ok = await confirm({...})`。
 * 用法：在组件顶层 `const { confirm, confirmDialog } = useConfirm();`，
 * 再把 `{confirmDialog}` 渲染到 JSX 里即可。
 *
 * confirm 与 confirmDialog 都是稳定引用；同一时刻只存在一个待确认项，
 * 重复调用会先把上一个 Promise 以 false 结算，调用方不会永远挂着。
 */
export const useConfirm = () => {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  /** 当前待结算的 Promise resolve；null 表示没有弹窗在等结果 */
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  /** confirmDialog 是否真的进了渲染树：只调用不渲染的话弹窗永远不会出现 */
  const mountedRef = useRef(false);

  const confirm = useCallback((opts: ConfirmOptions) => {
    /*
     * 忘了把 confirmDialog 放进 JSX 是这套 API 最容易踩的坑：
     * confirm() 会把 Promise 挂起，但没人渲染弹窗，界面毫无反应、调用方永远等不到结果。
     * 开发期直接报出来，生产环境保持安静。
     */
    if (import.meta.env.DEV && !mountedRef.current) {
      console.warn(
        "[confirm] confirm() 被调用了，但 confirmDialog 没有渲染到 JSX 里：弹窗不会出现，Promise 不会结算。",
      );
    }
    // 上一个还没结算时直接按「取消」放行，避免把调用方永久挂起
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const markMounted = useCallback(() => {
    mountedRef.current = true;
  }, []);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(ok);
  }, []);

  /*
   * 挂到 body：设置窗口是可拖动的浮窗（带 transform）且内容区 overflow-hidden，
   * 留在子树里的 fixed 遮罩会以卡片为定位基准并被裁掉，看起来"点了没反应"，
   * 而待确认的 Promise 还占着动作守卫，连带之后所有按钮都失效。
   */
  const confirmDialog = createPortal(
    <ConfirmDialog
      isOpen={!!options}
      options={options}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
      onMount={markMounted}
    />,
    document.body,
  );

  return { confirm, confirmDialog };
};
