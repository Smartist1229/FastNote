/**
 * 通用弹窗：受控组件，isOpen 为 false 时直接返回 null，子树的本地状态随之丢弃。
 * 只支持两种关闭方式——右上角按钮与 Esc；点遮罩不关闭，避免误点把正在填的表单关掉。
 * 不带焦点陷阱与滚动锁定，内容区（及其中的浮层）需自行处理；size 仅决定最大宽度。
 */
import { useEffect } from 'react';
import type { ModalProps } from "@/interface/ui";
import { Icon } from "@/components/common/Icon";

/** size → 最大宽度；外层已有 p-4，视口再窄也只是贴边不会溢出 */
const SIZE_CLASS: Record<NonNullable<ModalProps["size"]>, string> = {
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-3xl",
};

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = "lg" }) => {
  // 监听挂在 document 上：弹窗里的 input 通常 autofocus，Esc 要能从任意焦点位置生效
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
    >
      <div className={`modal-content bg-surface rounded-2xl shadow-2xl w-full ${SIZE_CLASS[size]} overflow-hidden`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button
            onClick={onClose}
            className="toolbar-btn hover:!bg-surface-alt"
            title="关闭"
          >
            <Icon name="modal-close" className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
};
