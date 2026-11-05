/**
 * 统一图标组件：图标资源在 src/assets/icons/<name>.svg，name 就是文件名（不含 .svg）。
 *
 * 构建时通过 import.meta.glob 一次性把所有 SVG 内容内联进 bundle（as: 'raw' 返回原始字符串），
 * 渲染时把字符串编码成 data URL 塞进 CSS mask，彻底告别网络请求、Tauri asset protocol 缓存和闪烁。
 *
 * 颜色跟随 currentColor，hover / 选中 / 禁用态无需额外处理；尺寸由 className 控制（默认 w-4 h-4）。
 * 传了 title 时它既是视觉提示也是无障碍名称；不传则 aria-hidden。
 */

import type React from "react";

// 相对于本文件（src/components/common/Icon.tsx）：../../assets/icons/*.svg
// eager=true → 构建时立刻全部加载；as='raw' → 拿到原始字符串（不是 URL）
const _svgModules = import.meta.glob("../../assets/icons/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// 把 "../../assets/icons/sidebar-search.svg" → "sidebar-search"
const ICONS: Record<string, string> = {};
for (const [path, svgText] of Object.entries(_svgModules)) {
  const name = path.split("/").pop()!.replace(/\.svg$/, "");
  ICONS[name] = svgText;
}

export const Icon: React.FC<{ name: string; className?: string; title?: string }> = ({
  name,
  className = "w-4 h-4",
  title,
}) => {
  const svgText = ICONS[name];

  // 图标不存在时渲染空占位（不报错），避免整个 app crash
  if (!svgText) {
    return (
      <span
        className={`inline-block flex-none ${className}`}
        aria-hidden={title ? undefined : true}
        title={title}
      />
    );
  }

  // data URL：用 encodeURIComponent 把 SVG 字符串 URL 编码，utf8 支持中文
  const maskUrl = `url("data:image/svg+xml;utf8,${encodeURIComponent(svgText)}")`;

  return (
    <span
      className={`inline-block flex-none ${className}`}
      style={{
        WebkitMaskImage: maskUrl,
        maskImage: maskUrl,
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        WebkitMaskSize: "contain",
        backgroundColor: "currentColor",
      }}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
};
