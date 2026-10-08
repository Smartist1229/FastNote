import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { Icon } from "./Icon";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType>({ showToast: () => {} });

export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const showToast = useCallback((message: string, type: ToastType = "info") => {
    setToasts((prev) => {
      const id = Date.now();
      setTimeout(() => {
        setToasts((p) => p.filter((t) => t.id !== id));
      }, 3000);
      return [...prev, { id, message, type }];
    });
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`animate-slideUp pointer-events-auto px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium backdrop-blur-sm border ${
              toast.type === "success"
                ? "bg-emerald-50/90 text-emerald-700 border-emerald-200/60"
                : toast.type === "error"
                ? "bg-red-50/90 text-red-600 border-red-200/60"
                : "bg-white/90 text-slate-700 border-slate-200/60"
            }`}
          >
            <div className="flex items-center gap-2">
              {toast.type === "success" && (
                <Icon name="toast-check" className="w-4 h-4 text-emerald-500" />
              )}
              {toast.type === "error" && (
                <Icon name="toast-error" className="w-4 h-4 text-red-500" />
              )}
              {toast.type === "info" && (
                <Icon name="toast-info" className="w-4 h-4 text-slate-400" />
              )}
              {toast.message}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
