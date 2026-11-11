/* 清理：可重建的派生数据（语义索引缓存 / 临时残留）与没人引用的图片。 */

import { CleaningPanel } from "@/components/settings/CleaningPanel";
import type { SettingsSectionContext } from "../context";

/** 这个分区没有设置行，只有两个动作按钮与占用读数，所以不消费 ctx */
export const CleaningSection: React.FC<{ ctx: SettingsSectionContext }> = () => <CleaningPanel />;
