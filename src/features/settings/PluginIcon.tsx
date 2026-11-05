/* 插件图标：固定盒子尺寸 + object-fit contain，保证不同分辨率的图标显示大小一致。 */

import type { FC } from "react";

import { Icon } from "@/components/common/Icon";

interface PluginIconProps {
  /** 插件图标的本应用协议 URL；为空时渲染内置默认图标 */
  url?: string;
  /** 盒子边长（px） */
  size?: number;
  className?: string;
}

export const PluginIcon: FC<PluginIconProps> = ({ url, size = 20, className = "" }) => (
  <span
    className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[4px] ${className}`}
    style={{ width: size, height: size }}
  >
    {url ? (
      <img src={url} alt="" className="h-full w-full object-contain" draggable={false} />
    ) : (
      <Icon name="plugin-default" className="h-full w-full text-faint" />
    )}
  </span>
);
