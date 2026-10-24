/**
 * 统一图标组件：图标资源在 public/icons/<name>.svg，name 就是文件名（不含 .svg）。
 *
 * 用 CSS mask 把 svg 当镂空模板、backgroundColor 取 currentColor 填充，
 * 颜色因此完全跟随文字色，hover / 选中 / 禁用态都不必额外处理；尺寸由 className 控制（默认 w-4 h-4）。
 *
 * 传了 title 时它既是视觉提示也是无障碍名称；不传则 aria-hidden，避免纯装饰图标被读屏念出来。
 */
export const Icon: React.FC<{ name: string; className?: string; title?: string }> = ({
  name,
  className = "w-4 h-4",
  title,
}) => (
  <span
    className={`inline-block flex-none ${className}`}
    style={{
      WebkitMaskImage: `url(/icons/${name}.svg)`,
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      WebkitMaskSize: "contain",
      backgroundColor: "currentColor",
    }}
    title={title}
    aria-hidden={title ? undefined : true}
  />
);
