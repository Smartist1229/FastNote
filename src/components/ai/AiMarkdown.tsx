/**
 * AI 回复的 Markdown 渲染。
 *
 * 直接复用笔记用的那套编辑器，但走 `render` 模式：只输出渲染结果，
 * 工具栏 / 状态栏 / 查找框 / 大纲都不渲染，高度随内容增长，嵌在气泡里就像一段富文本。
 *
 * 配色由 config/markdownEditor.ts 从软件当前主题令牌换算，换主题时这里跟着变。
 * 代码块（配色预设、行号、语言标签、折叠）额外跟随「编辑器」分区的设置，与笔记里的外观一致。
 * memo 不可省：流式输出每 50ms 刷新一次内容，历史消息不能被反复重渲染。
 */
import { memo, useMemo } from "react";
import { MarkdownEditor } from "@/markdown-editor";
import { buildAiRenderConfig } from "@/config/markdownEditor";
import { DEFAULT_EDITOR_SETTINGS } from "@/config/appDefaults";
import type { EditorSettings } from "@/interface/settings";
import { useActiveThemeTokens, useResolvedThemeMode } from "@/lib/themeRuntime";
import { useI18n } from "@/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface AiMarkdownProps {
  content: string;
  /** 「编辑器」分区的设置：代码块配色 / 行号 / 语言标签等跟着它走，缺省用出厂默认值 */
  editorSettings?: EditorSettings;
}

export const AiMarkdown: React.FC<AiMarkdownProps> = memo(function AiMarkdown({ content, editorSettings }) {
  const { locale } = useI18n();
  const tokens = useActiveThemeTokens();
  const themeMode = useResolvedThemeMode();
  const settings = editorSettings ?? DEFAULT_EDITOR_SETTINGS;
  const config = useMemo(
    () => buildAiRenderConfig(settings, tokens, themeMode, locale),
    [settings, tokens, themeMode, locale],
  );

  return (
    <div className="ai-markdown">
      <MarkdownEditor
        value={content}
        mode="render"
        config={config}
        readOnly
        // 不接的话会走预览的 window.open(_self) —— 在 WebView 里就是整个窗口跳到那个网页
        onLinkClick={(href) => {
          if (href.startsWith("#")) return true;
          void openUrl(href).catch(() => undefined);
          return false;
        }}
      />
    </div>
  );
});

AiMarkdown.displayName = "AiMarkdown";
