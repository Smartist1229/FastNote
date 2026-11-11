/**
 * 编辑器纯渲染视图：把 Markdown 文本用编辑器同一套解析与排版渲染出来（只读）。
 *
 * 用途：插件 ctx.editor.render(md) → ctx.ui.modal({ render }) 的宿主渲染端，
 * 也用于任何需要"只读展示 Markdown"的宿主场景。
 * 配置复用 buildNoteEditorConfig（行为取默认编辑器设置，配色跟随当前主题令牌），
 * 不改 src/markdown-editor 内部。
 */
import { useMemo } from "react";

import { useI18n } from "@/i18n";
import { DEFAULT_EDITOR_SETTINGS } from "@/config/app/appDefaults";
import { buildNoteEditorConfig } from "@/config/editor/markdownEditor";
import { useActiveThemeTokens, useResolvedThemeMode } from "@/lib/theme/themeRuntime";
import { MarkdownPreview, parseMarkdown, resolveConfig, resolveLabels } from "@/markdown-editor";
import { resolveImageSource } from "@/lib/markdown/imageSrc";

export interface MarkdownRenderProps {
  markdown: string;
}

export const MarkdownRenderView: React.FC<MarkdownRenderProps> = ({ markdown }) => {
  const { locale } = useI18n();
  const mode = useResolvedThemeMode();
  const tokens = useActiveThemeTokens();

  const config = useMemo(
    () =>
      resolveConfig(
        buildNoteEditorConfig(DEFAULT_EDITOR_SETTINGS, tokens, mode, DEFAULT_EDITOR_SETTINGS.fontSize ?? 16, locale),
      ),
    [tokens, mode, locale],
  );
  const doc = useMemo(() => parseMarkdown(markdown), [markdown]);
  const labels = useMemo(() => resolveLabels(config), [config]);

  return (
    <MarkdownPreview
      doc={doc}
      config={config}
      labels={labels}
      readOnly
      resolveImage={resolveImageSource}
    />
  );
};
