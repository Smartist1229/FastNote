/**
 * AI 回复的 Markdown 渲染。
 *
 * 直接复用笔记用的那套编辑器，但走 `render` 模式：只输出渲染结果，
 * 工具栏 / 状态栏 / 查找框 / 大纲都不渲染，高度随内容增长，嵌在气泡里就像一段富文本。
 *
 * 配色由 config/markdownEditor.ts 从软件当前主题令牌换算，换主题时这里跟着变。
 * memo 不可省：流式输出每 50ms 刷新一次内容，历史消息不能被反复重渲染。
 */
import { memo, useMemo } from "react";
import { MarkdownEditor } from "@/markdown-editor";
import { buildAiRenderConfig } from "@/config/markdownEditor";
import { useActiveThemeTokens, useResolvedThemeMode } from "@/lib/themeRuntime";
import { openUrl } from "@tauri-apps/plugin-opener";

export const AiMarkdown: React.FC<{ content: string }> = memo(function AiMarkdown({ content }) {
  const tokens = useActiveThemeTokens();
  const themeMode = useResolvedThemeMode();
  const config = useMemo(() => buildAiRenderConfig(tokens, themeMode), [tokens, themeMode]);

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
