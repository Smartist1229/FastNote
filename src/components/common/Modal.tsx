/**
 * 通用弹窗：受控组件，isOpen 为 false 时直接返回 null，子树的本地状态随之丢弃。
 * 关闭方式只有右上角按钮——点遮罩不关（避免误点把正在填的表单关掉），Esc 也不关
 * （非模态时面板不持有焦点，Esc 多半是用户想关编辑器里的东西）。
 * 不带焦点陷阱与滚动锁定，内容区（及其中的浮层）需自行处理；size 仅决定最大宽度。
 * 卡片始终被限制在视口内（`max-h-full`，外层 p-4 之外不越界），内容放不下时内容区自己滚——
 * 窗口没最大化或屏幕矮的时候，底部内容不会再被推出可视区。
 * 要固定尺寸就传 width / height：宽度走内联 style（不再套 size 的 max-w），
 * 高度传了之后卡片固定高、内容区自己滚，弹窗不会再被内容撑大或缩水。
 *
 * 传了 `floating` 就切成非模态浮窗：不铺遮罩、整层 pointer-events 关掉，
 * 只有卡片本身可点——底下的界面照常可交互；标题栏可拖动挪位置（每次打开回到居中）。
 * 目前没有任何调用方用它（设置窗自己实现的浮窗外壳，属性窗已经改回模态）；
 * 确认框这类必须挡住全屏的仍走模态。
 */
import { useI18n } from "@/i18n";
import type { ModalProps } from "@/interface/ui";
import { Icon } from "@/components/common/Icon";
import { useDraggable } from "@/components/common/useDraggable";

/** size → 最大宽度；外层已有 p-4，视口再窄也只是贴边不会溢出 */
const SIZE_CLASS: Record<NonNullable<ModalProps["size"]>, string> = {
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-3xl",
};

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = "lg", width, height, floating = false, zIndex }) => {
  const { t } = useI18n();
  // hooks 不能条件调用：非浮窗时 enabled=false，startDrag 直接返回
  const drag = useDraggable(floating && isOpen);

  if (!isOpen) return null;

  /** 固定宽度时不套 w-full / max-w：max-width 会把内联的 width 夹回去 */
  const widthClass = width == null ? `w-full ${SIZE_CLASS[size]}` : "";

  return (
    <div
      className={
        floating
          ? "fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          : "modal-overlay fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      }
      style={zIndex == null ? undefined : { zIndex }}
    >
      <div
        ref={drag.panelRef}
        className={`modal-content relative rounded-2xl flex flex-col overflow-hidden ${widthClass} ${
          floating ? "floating-panel bg-surface pointer-events-auto max-h-[92vh]" : "bg-surface shadow-2xl max-h-full"
        }`}
        style={{
          ...(floating ? drag.style : undefined),
          ...(width != null ? { width } : undefined),
          ...(height != null ? { height } : undefined),
        }}
      >
        <div
          className={`flex items-center justify-between px-5 py-4 border-b border-line-soft flex-shrink-0${
            floating ? " cursor-grab active:cursor-grabbing select-none" : ""
          }`}
          onPointerDown={floating ? drag.startDrag : undefined}
        >
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button
            onClick={onClose}
            className="toolbar-btn hover:bg-surface-alt!"
            title={t("关闭")}
          >
            <Icon name="modal-close" className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto chat-scrollbar p-5">{children}</div>
      </div>
    </div>
  );
};
