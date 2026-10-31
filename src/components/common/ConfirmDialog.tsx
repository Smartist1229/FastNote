import { useI18n } from "@/i18n";
import { useCallback, useRef, useState } from "react";
import type { ConfirmOptions } from "@/interface/ui";
import { Modal } from "@/components/common/Modal";

/** 确认弹窗本体：不对外导出，只由 useConfirm 渲染；options 为 null 时整体不渲染 */
const ConfirmDialog: React.FC<{
  isOpen: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ isOpen, options, onConfirm, onCancel }) => {
  const { t } = useI18n();
  if (!options) return null;
  const { title, message, confirmText = "确定", cancelText = "取消", danger } = options;
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={t(title)}>
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

  const confirm = useCallback((opts: ConfirmOptions) => {
    // 上一个还没结算时直接按「取消」放行，避免把调用方永久挂起
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(ok);
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      isOpen={!!options}
      options={options}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
};
