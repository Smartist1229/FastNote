/**
 * 全局轻提示（Toast）：Provider 挂在 App 根部，底部居中纵向堆叠，最多同时 3 条。
 * 每条存活 3 秒；到期前 200ms 标记 leaving 播离场动画，再等 200ms 从数组剔除。
 * 定时器全部写在 useCallback 里、绝不放进 setToasts updater（StrictMode 会双调用）。
 * showToast 用 useCallback 固定引用，可以安全放进依赖数组。
 */
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import type { Toast, ToastContextType, ToastType } from "@/interface/app/ui";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";

/** 单条提示的存活时间（ms） */
const TOAST_DURATION_MS = 3000;

/** 离场动画时长（ms）：到期前这么久开始淡出 */
const TOAST_LEAVE_MS = 200;

/** 同时最多显示的条数，超出时丢弃最旧的 */
const TOAST_MAX_VISIBLE = 3;

/** 本地扩展出「离场中」标记，不动 interface 里的公共 Toast */
type LiveToast = Toast & { leaving: boolean };

/**
 * 自增 id 序列。
 * 不能用 Date.now()：同一毫秒内连发两条会撞 id，React 的 key 冲突且先入队那条会被提前清掉。
 */
let toastSeq = 0;

/** 默认空实现：万一组件在 Provider 外调用 useToast，也只会静默失败，不会直接抛错 */
const ToastContext = createContext<ToastContextType>({ showToast: () => {} });

/** 取用全局提示：`const { showToast } = useToast()` */
export const useToast = () => useContext(ToastContext);

/** 三型配色：图标圆底与进度条都用语义 token，亮/暗色自动跟随；info 统一走主色 */
const TONE: Record<ToastType, { icon: string; wrap: string; progress: string }> = {
  success: {
    icon: "toast-check",
    wrap: "bg-success-soft text-success-strong",
    progress: "bg-success/80",
  },
  error: {
    icon: "toast-error",
    wrap: "bg-danger-soft text-danger-strong",
    progress: "bg-danger/80",
  },
  info: {
    icon: "toast-info",
    wrap: "bg-primary-50 text-primary-600",
    progress: "bg-primary-500/80",
  },
};

/** 挂在 App 根部；负责渲染当前堆叠的所有 toast，并管理各自的倒计时 */
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<LiveToast[]>([]);
  // 每条 toast 的两段定时器、剩余时长、开始计时时刻；只给事件回调读，渲染不依赖
  const timersRef = useRef(new Map<number, { leave: number; remove: number }>());
  const remainingRef = useRef(new Map<number, number>());
  const startedRef = useRef(new Map<number, number>());

  /** 清掉某条的计时状态（不改 state） */
  const clearTimer = useCallback((id: number) => {
    const timers = timersRef.current.get(id);
    if (timers) {
      window.clearTimeout(timers.leave);
      window.clearTimeout(timers.remove);
      timersRef.current.delete(id);
    }
    remainingRef.current.delete(id);
    startedRef.current.delete(id);
  }, []);

  /** 立即移除一条（关闭按钮 / 计时结束） */
  const removeToast = useCallback((id: number) => {
    clearTimer(id);
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, [clearTimer]);

  /**
   * 按剩余时长重新排两段定时器：先标记 leaving，再移除。
   * remainingRef 被清空即代表已进入离场阶段，悬停不再暂停。
   */
  const scheduleToast = useCallback((id: number, remaining: number) => {
    clearTimer(id);
    const leave = window.setTimeout(() => {
      remainingRef.current.delete(id);
      startedRef.current.delete(id);
      setToasts((prev) => prev.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
    }, Math.max(remaining - TOAST_LEAVE_MS, 0));
    const remove = window.setTimeout(() => removeToast(id), remaining);
    timersRef.current.set(id, { leave, remove });
    remainingRef.current.set(id, remaining);
    startedRef.current.set(id, performance.now());
  }, [clearTimer, removeToast]);

  /** 悬停暂停：扣掉已流逝的时间，移出时只继续剩余部分，不会永不消失 */
  const pauseToast = useCallback((id: number) => {
    const started = startedRef.current.get(id);
    if (started === undefined) return;
    const left = Math.max((remainingRef.current.get(id) ?? TOAST_DURATION_MS) - (performance.now() - started), 0);
    const timers = timersRef.current.get(id);
    if (timers) {
      window.clearTimeout(timers.leave);
      window.clearTimeout(timers.remove);
      timersRef.current.delete(id);
    }
    remainingRef.current.set(id, left);
    startedRef.current.delete(id);
  }, []);

  const resumeToast = useCallback((id: number) => {
    // 已进入离场阶段（remaining 被清掉）或仍在计时中，都不重启
    const left = remainingRef.current.get(id);
    if (left === undefined || startedRef.current.has(id)) return;
    scheduleToast(id, left);
  }, [scheduleToast]);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++toastSeq;
    setToasts((prev) => {
      const next = [...prev, { id, message, type, leaving: false }];
      // updater 保持纯函数：这里只做裁剪，定时器在下面注册
      return next.length > TOAST_MAX_VISIBLE ? next.slice(next.length - TOAST_MAX_VISIBLE) : next;
    });
    scheduleToast(id, TOAST_DURATION_MS);
  }, [scheduleToast]);

  // Provider 卸载时清掉全部定时器
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(({ leave, remove }) => {
        window.clearTimeout(leave);
        window.clearTimeout(remove);
      });
      timers.clear();
    };
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
      {/* 容器 pointer-events-none 不挡页面点击，单条 toast 再恢复 auto；bottom-6 避开底部状态栏 */}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none"
      >
        {toasts.map((toast) => {
          const tone = TONE[toast.type];
          return (
            <div
              key={toast.id}
              role={toast.type === "error" ? "alert" : undefined}
              onMouseEnter={() => pauseToast(toast.id)}
              onMouseLeave={() => resumeToast(toast.id)}
              className={`${
                toast.leaving ? "toast-leave" : "toast-enter"
              } toast-card group pointer-events-auto relative w-max max-w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line/60 bg-surface/90 px-3 py-[11px] text-body shadow-card-hover backdrop-blur-md`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`grid h-[26px] w-[26px] flex-none place-items-center rounded-full ${tone.wrap}`}
                >
                  <Icon name={tone.icon} className="w-3.5 h-3.5" />
                </span>
                {/* 右侧 pr-4 只为给关闭按钮留出贴边位置，不是整卡留白 */}
                <span className="selectable min-w-0 pr-4 text-[13px] font-medium leading-[1.5] text-body break-words">
                  {t(toast.message)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                data-editor-blur-ignore="true"
                aria-label={t("关闭")}
                className="absolute right-2.5 top-[10px] grid h-5 w-5 place-items-center rounded-full text-faint opacity-70 transition-opacity hover:text-body focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <Icon name="modal-close" className="w-2.5 h-2.5" />
              </button>
              {/* 底部 2px 倒计时条：内缩 1px、带底部圆角，整卡仍是完整圆角 */}
              <span
                aria-hidden="true"
                className="absolute inset-x-px bottom-px h-[2px] overflow-hidden rounded-b-[calc(var(--radius-2xl)-1px)]"
              >
                <span className={`toast-progress absolute inset-y-0 left-0 w-full ${tone.progress}`} />
              </span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};
