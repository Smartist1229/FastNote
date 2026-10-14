/* AI 服务商设置弹窗的 Props。 */

import type { AiProvider } from "./ai";

export interface AiProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: AiProvider[];
  selectedProviderId: number;
  onProvidersChange: (providers: AiProvider[]) => void;
  onSelectedProviderChange: (id: number) => void;
}
