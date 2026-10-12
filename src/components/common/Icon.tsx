/**
 * 统一图标组件。
 *
 * 图标本体放在 public/icons/<name>.svg（文件里只保留形状，颜色无关紧要），
 * 这里用 CSS mask 把它"挖"出来、再以 currentColor 填色 ——
 * 因此 hover / 选中 / 禁用态的变色行为与原来的内联 SVG 完全一致，
 * 而页面里只剩一行 <Icon name="copy" />，不再有几十行 path 数据。
 *
 * 新增图标：把 svg 丢进 public/icons/，name 直接用文件名（不含 .svg）。
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
