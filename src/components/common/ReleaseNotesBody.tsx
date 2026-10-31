/**
 * 更新说明正文：复用编辑器的纯渲染视图（与 AI 回复里同一套，见 AiMarkdown）。
 *
 * 发布流程按 Conventional Commits 生成 Markdown，粗体、列表、链接都交给渲染器，
 * 不再自己维护一份「只认几种语法」的解析器。纯渲染模式高度随内容、无外壳，适合嵌在弹窗里。
 * 字号比正文略小；说明里不需要用户自定义的代码块外观，所以用默认编辑器设置构造配置。
 *
 * 单独成文件并由 UpdateDialog 懒加载：编辑器（含 Mermaid / KaTeX 的动态入口）体积大，
 * 更新弹窗却很少打开，静态引用会把整块渲染层拖进首屏主包。
 */
import { useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "@/i18n";
import { MarkdownEditor } from "@/markdown-editor";
import { buildAiRenderConfig } from "@/config/markdownEditor";
import { DEFAULT_EDITOR_SETTINGS } from "@/config/appDefaults";
import { useActiveThemeTokens, useResolvedThemeMode } from "@/lib/themeRuntime";

const ReleaseNotesBody: React.FC<{ notes: string }> = ({ notes }) => {
  const { locale } = useI18n();
  const tokens = useActiveThemeTokens();
  const themeMode = useResolvedThemeMode();
  const config = useMemo(() => {
    const base = buildAiRenderConfig(DEFAULT_EDITOR_SETTINGS, tokens, themeMode, locale);
    return {
      ...base,
      preview: {
        ...base.preview,
        typography: {
          ...base.preview?.typography,
          fontSize: 12,
          lineHeight: 1.7,
          paragraphSpacing: 0.5,
        },
      },
    };
  }, [tokens, themeMode, locale]);

  return (
    <div className="mt-1.5 max-h-[240px] overflow-y-auto chat-scrollbar pr-1">
      <MarkdownEditor
        value={notes}
        mode="render"
        config={config}
        readOnly
        // 不接的话会走预览的 window.open(_self)，WebView 里整个窗口会跳到那个网页
        onLinkClick={(href) => {
          if (href.startsWith("#")) return true;
          void openUrl(href).catch(() => undefined);
          return false;
        }}
      />
    </div>
  );
};

export default ReleaseNotesBody;
