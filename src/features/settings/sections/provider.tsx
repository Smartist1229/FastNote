/* AI 服务商：复用 AiProviderModal 里的面板，共用设置窗口的开关状态。 */

import { AiProviderSettings } from "@/components/ai/AiProviderModal";
import type { SettingsSectionContext } from "../context";

export const ProviderSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <div className="rounded-xl border border-line p-3.5">
    <AiProviderSettings
      isOpen={ctx.isOpen}
      onClose={ctx.onClose}
      providers={ctx.aiProviders}
      selectedProviderId={ctx.aiSelectedProviderId}
      onProvidersChange={ctx.onAiProvidersChange}
      onSelectedProviderChange={ctx.onAiSelectedProviderChange}
    />
  </div>
);
