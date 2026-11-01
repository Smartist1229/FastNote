/* 服务商设置弹窗的组件层 Props：列表在弹窗内部维护，变更经回调同步给父级。 */

import type { AiProvider } from "./ai";

/**
 * AI 服务商设置弹窗的 Props。
 * 增删改由弹窗内直接调 Tauri 命令完成，随后把整份列表回抛，父级只做状态同步。
 */
export interface AiProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 全量服务商列表（来自 get_ai_providers，已含 enabled_models） */
  providers: AiProvider[];
  /** 当前选中的服务商 id；0 = 尚未选择（首次加载后取列表第一项） */
  selectedProviderId: number;
  /** 列表变更（增删改或重读）后回抛整份列表 */
  onProvidersChange: (providers: AiProvider[]) => void;
  onSelectedProviderChange: (id: number) => void;
}
