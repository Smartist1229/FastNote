import { useEffect } from 'react';
import { Icon } from "./Icon";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** 宽度档位：默认 lg；设置窗口这类带侧栏的内容用 2xl 才放得下 */
  size?: "lg" | "xl" | "2xl";
}

const SIZE_CLASS: Record<NonNullable<ModalProps["size"]>, string> = {
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-3xl",
};

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = "lg" }) => {
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
      <div className={`modal-content bg-white rounded-2xl shadow-2xl w-full ${SIZE_CLASS[size]} overflow-hidden`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          <button
            onClick={onClose}
            className="toolbar-btn hover:!bg-slate-100"
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
