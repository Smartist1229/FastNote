/**
 * 全局轻提示（Toast）：Provider 挂在 App 根部，底部居中纵向堆叠，每条 3 秒后自动移除。
 * 不做进出场队列：新消息直接追加到数组末尾，超时后按 id 从数组中剔除。
 * showToast 用 useCallback 固定引用，可以安全放进依赖数组。
 */
import { createContext, useContext, useCallback, useMemo, useState, ReactNode } from "react";
import type { Toast, ToastContextType, ToastType } from "@/interface/ui";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";

/** 单条提示的存活时间（ms） */
const TOAST_DURATION_MS = 3000;

/**
 * 自增 id 序列。
 * 不能用 Date.now()：同一毫秒内连发两条会撞 id，React 的 key 冲突且先入队那条会被提前清掉。
 */
let toastSeq = 0;

/** 默认空实现：万一组件在 Provider 外调用 useToast，也只会静默失败，不会直接抛错 */
const ToastContext = createContext<ToastContextType>({ showToast: () => {} });

/** 取用全局提示：`const { showToast } = useToast()` */
export const useToast = () => useContext(ToastContext);

/** 挂在 App 根部；负责渲染当前堆叠的所有 toast，并在 3 秒后逐条清理 */
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  /**
   * 追加一条提示并安排超时移除。
   * 定时器放在 updater 之外：setToasts 的更新函数必须是纯函数，
   * StrictMode 会双调用，写在这里会导致计时器被注册两次。
   */
  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  /**
   * context 的 value 必须 memo：showToast 本身是稳定引用，但字面量 `{ showToast }`
   * 每次 Provider 渲染都会生成新对象。Provider 会因为 toasts 增删而重渲染（每条提示两次），
   * value 一变，所有 useToast 的消费组件（侧栏、编辑器、AI 面板…）都会跟着重渲染。
   */
  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* 容器 pointer-events-none 不挡页面点击，单条 toast 再恢复 auto 以便选中文字 */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`animate-slideUp pointer-events-auto px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium backdrop-blur-sm border ${
              toast.type === "success"
                ? "bg-success-soft/90 text-success-deep border-success-line/60"
                : toast.type === "error"
                ? "bg-danger-soft/90 text-danger-strong border-danger-line/60"
                : "bg-surface/90 text-body border-line/60"
            }`}
          >
            <div className="flex items-center gap-2">
              {toast.type === "success" && (
                <Icon name="toast-check" className="w-4 h-4 text-success" />
              )}
              {toast.type === "error" && (
                <Icon name="toast-error" className="w-4 h-4 text-danger" />
              )}
              {toast.type === "info" && (
                <Icon name="toast-info" className="w-4 h-4 text-faint" />
              )}
              <span className="selectable">{t(toast.message)}</span>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
