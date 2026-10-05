import { useCallback, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  /** 弹窗标题 */
  title: string;
  /** 正文说明 */
  message: ReactNode;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作（删除/清空等不可恢复）：确认按钮用红色 */
  danger?: boolean;
}

/** 受控的确认弹窗：样式与「删除分类」弹窗保持一致 */
const ConfirmDialog: React.FC<{
  isOpen: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ isOpen, options, onConfirm, onCancel }) => {
  if (!options) return null;
  const { title, message, confirmText = "确定", cancelText = "取消", danger } = options;
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title}>
      <div className="space-y-4" onKeyDown={(e) => { if (e.key === "Enter") onConfirm(); }}>
        <p className="text-sm text-slate-600 leading-relaxed">{message}</p>
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onCancel} className="btn-ghost px-4 py-2 text-sm">
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={
              danger
                ? "px-4 py-2 text-sm font-medium text-white bg-red-500 rounded-xl hover:bg-red-600 transition-colors shadow-sm"
                : "btn-primary px-4 py-2 text-sm"
            }
          >
            {confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/**
 * 用主题化弹窗替换原生 confirm()：`const ok = await confirm({...})`。
 * 用法：在组件顶层 `const { confirm, confirmDialog } = useConfirm();`，
 * 再把 `{confirmDialog}` 渲染到 JSX 里即可。
 */
export const useConfirm = () => {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
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
