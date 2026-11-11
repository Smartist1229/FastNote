/**
 * 命令面板域：Ctrl+P 跳转 / Ctrl+Shift+P 命令面板的开关、标签数据与命令表。
 *
 * 面板是纯派生视图：笔记来自内存全量列表，命令表按当前渲染状态现场组装；
 * 标签列表只在面板打开时拉一次。paletteNonce 让每次打开都重新挂载，
 * 免得上次的查询词、选中项、标签筛选残留。
 */
import { useCallback, useEffect, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Category, Note, Tag } from "@/interface/note/note";
import type { PropertiesTarget } from "@/interface/app/ui";
import type { SettingsSection } from "@/interface/settings/settingsModal";
import type { ThemeSettings } from "@/interface/settings/theme";
import type { NoteEditorActions } from "@/interface/note/editor";
import type { PaletteCommand, PaletteMode } from "@/components/common/CommandPalette";
import { SETTINGS_SECTIONS } from "@/config/app/settingsSections";
import { resolveShortcutBindings, shortcutKeyText } from "@/config/shortcuts";
import { keyText } from "@/lib/text/keyLabel";
import * as tagsApi from "@/api/note/tags";
import { useI18n } from "@/i18n";
import { useShortcutAction } from "@/features/shortcuts/useShortcutAction";
import { pluginHost } from "@/plugins/host";
import { pluginContributions } from "@/plugins/contributions";

export interface UsePaletteParams {
  categories: Category[];
  selectedCategoryId: string | null;
  editorNote: Note | null;
  selectedNote: Note | null;
  overlayActive: boolean;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  sortBy: string;
  sortOrder: string;
  theme: ThemeSettings;
  /** 数据库里的键位覆盖值（`app.config.shortcuts`）：命令面板提示按它实时显示 */
  shortcutBindings: Record<string, string>;
  aiPanelOpen: boolean;
  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  sidebarView: 'groups' | 'favorites';
  setSidebarView: Dispatch<SetStateAction<'groups' | 'favorites'>>;
  enableAI: boolean;
  handleCreateNote: (categoryId?: string | null, title?: string) => Promise<void>;
  handleCreateCategoryNamed: (name: string) => Promise<void>;
  handleOpenTrash: () => Promise<void>;
  handleOpenTextFileDialog: () => Promise<void>;
  toggleAiPanel: () => void;
  handleSortByChange: (value: string) => void;
  handleToggleSortOrder: () => void;
  handleThemeChange: (next: ThemeSettings) => void;
  lockEverything: (reason?: "manual" | "idle") => Promise<void>;
  hasUnlockedEncryption: boolean;
  loadData: () => Promise<void>;
  openSettings: (section?: SettingsSection) => void;
  exportNoteRef: RefObject<(() => void) | null>;
  setPropertiesTarget: Dispatch<SetStateAction<PropertiesTarget | null>>;
  editorActionsRef: RefObject<NoteEditorActions | null>;
}

export function usePalette({
  categories,
  selectedCategoryId,
  editorNote,
  selectedNote,
  overlayActive,
  searchQuery,
  setSearchQuery,
  sortBy,
  sortOrder,
  theme,
  shortcutBindings,
  aiPanelOpen,
  isSidebarCollapsed,
  setIsSidebarCollapsed,
  sidebarView,
  setSidebarView,
  enableAI,
  handleCreateNote,
  handleCreateCategoryNamed,
  handleOpenTrash,
  handleOpenTextFileDialog,
  toggleAiPanel,
  handleSortByChange,
  handleToggleSortOrder,
  handleThemeChange,
  lockEverything,
  hasUnlockedEncryption,
  loadData,
  openSettings,
  exportNoteRef,
  setPropertiesTarget,
  editorActionsRef,
}: UsePaletteParams) {
  const { t } = useI18n();

  /**
   * 当前生效键位（只读派生）。命令里的 `keys` 与页签提示都从这里取，
   * 不在 UI 里写死 "Ctrl+S" —— 设置里改完立刻一致。
   */
  const bindings = resolveShortcutBindings(shortcutBindings);
  const keyHintOf = (actionId: string) => keyText(shortcutKeyText(bindings, actionId));

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("jump");
  const [paletteNonce, setPaletteNonce] = useState(0);
  const [paletteTags, setPaletteTags] = useState<Tag[]>([]);

  /** 打开命令面板；每次打开换一个 key，避免上次的查询词与选中项残留 */
  const openPalette = useCallback((mode: PaletteMode) => {
    setPaletteMode(mode);
    setPaletteNonce((nonce) => nonce + 1);
    setPaletteOpen(true);
  }, []);

  /**
   * 快捷键：默认 Ctrl/⌘+P 跳转、Ctrl/⌘+Shift+P 命令面板。
   *
   * 键位不再写死在这里：动作注册到快捷键运行时（`features/shortcuts`），
   * 用户在设置里改成什么就按什么，冲突检测也走同一份清单。
   * 分发改在 window 捕获阶段进行，仍然早于编辑器自己的处理。
   */
  useShortcutAction("app.jump", () => openPalette("jump"));
  useShortcutAction("app.command", () => openPalette("command"));

  /** 标签列表：只在面板打开时拉一次（标签会随 AI 打标签变化，不值得常驻内存） */
  useEffect(() => {
    if (!paletteOpen) return;
    let alive = true;
    tagsApi
      .listTags()
      .then((list) => {
        if (alive) setPaletteTags(list);
      })
      .catch(() => {
        if (alive) setPaletteTags([]);
      });
    return () => {
      alive = false;
    };
  }, [paletteOpen]);

  /**
   * 命令面板的命令表。
   *
   * 刻意**不用 useMemo**：每条命令的 run 都闭包着当次渲染的状态（当前笔记、排序、主题），
   * 缓存一份旧闭包反而会执行到过期数据；面板关闭时直接给空数组，开销为零。
   * 每条都写 hint（面板里的说明行）与 keywords（别名 / 英文 / 拼音首字母），
   * 保证「记得有这个功能但想不起叫什么」也能搜到；token 是面板里可输入的标准指令，
   * 带 arg 的命令（如 create_note）选中后只填入 token，等用户补参数再执行。
   */
  const paletteCommands: PaletteCommand[] = paletteOpen
    ? [
        /* ---------- 笔记 ---------- */
        {
          id: "note.create",
          token: "create_note",
          title: t("新建笔记"),
          hint: t("在「{name}」里新建笔记，参数是笔记标题", {
            name: categories.find((c) => c.id === selectedCategoryId)?.name ?? t("未分类"),
          }),
          group: t("笔记"),
          icon: "sidebar-plus",
          keywords: "new note 新建 创建 create",
          arg: { placeholder: t("笔记标题"), hint: t("省略则叫「无标题」") },
          run: (title) => void handleCreateNote(undefined, title),
        },
        {
          id: "note.createCategory",
          token: "create_category",
          title: t("新建分组"),
          hint: t("直接创建分组，参数是分组名称"),
          group: t("笔记"),
          icon: "sidebar-folder-plus",
          keywords: "new category 分组 分类 创建 folder",
          arg: { placeholder: t("分组名称"), hint: t("省略则打开新建弹窗") },
          run: (name) => void handleCreateCategoryNamed(name ?? ""),
        },
        {
          id: "note.export",
          token: "export_note",
          title: t("导出当前笔记"),
          hint: t("另存为 Markdown 文件"),
          group: t("笔记"),
          icon: "editor-export",
          keys: shortcutKeyText(bindings, "app.save") || undefined,
          keywords: "export 导出 保存 另存为 save file",
          disabled: !editorNote || editorNote.enc_mode !== 0,
          disabledReason:
            editorNote && editorNote.enc_mode !== 0
              ? t("加密笔记不支持导出，请先永久解密")
              : t("先打开一篇笔记"),
          run: () => exportNoteRef.current?.(),
        },
        {
          id: "note.properties",
          token: "note_properties",
          title: t("当前笔记属性"),
          hint: t("改标题、移动分组、管理标签、AI 访问权限"),
          group: t("笔记"),
          icon: "ai-settings",
          keywords: "properties 属性 详情 标签 权限",
          disabled: !selectedNote || overlayActive,
          disabledReason: overlayActive ? t("AI 预览 / 电脑文件没有笔记属性") : t("先打开一篇笔记"),
          run: () => {
            if (selectedNote) setPropertiesTarget({ kind: "note", note: selectedNote });
          },
        },
        {
          id: "note.history",
          token: "note_history",
          title: t("当前笔记：历史版本"),
          hint: t("在属性窗里查看、预览、恢复、删除或清空这篇笔记的历史版本"),
          group: t("笔记"),
          icon: "sidebar-clock",
          keywords: "history 历史 版本 回滚 恢复 snapshot",
          disabled: !selectedNote || overlayActive,
          disabledReason: overlayActive ? t("AI 预览 / 电脑文件没有历史版本") : t("先打开一篇笔记"),
          run: () => {
            if (selectedNote) setPropertiesTarget({ kind: "note", note: selectedNote });
          },
        },
        {
          id: "note.trash",
          token: "open_trash",
          title: t("打开回收站"),
          hint: t("查看、还原或彻底删除已删除的笔记"),
          group: t("笔记"),
          icon: "sidebar-trash",
          keywords: "trash 回收站 删除 还原 recycle",
          run: () => void handleOpenTrash(),
        },
        {
          id: "note.openFile",
          token: "open_file",
          title: t("打开电脑上的文本文件…"),
          hint: t("直接在编辑器里编辑 md / txt，保存时写回原文件"),
          group: t("笔记"),
          icon: "welcome-file-empty",
          keywords: "open file 打开 电脑 本地 txt md 文件",
          run: () => void handleOpenTextFileDialog(),
        },

        /* ---------- 视图 ---------- */
        {
          id: "view.sidebar",
          token: "toggle_sidebar",
          title: isSidebarCollapsed ? t("显示侧边栏") : t("隐藏侧边栏"),
          hint: t("分组与笔记列表"),
          group: t("视图"),
          icon: "sidebar-list",
          keywords: "sidebar 侧边栏 收起 展开 toggle",
          run: () => setIsSidebarCollapsed((collapsed) => !collapsed),
        },
        {
          id: "view.groups",
          token: "view_groups",
          title: t("切换到分组视图"),
          hint: t("按分组浏览全部笔记"),
          group: t("视图"),
          icon: "sidebar-folder",
          keywords: "groups 分组 视图",
          disabled: sidebarView === "groups",
          disabledReason: t("当前已经是分组视图"),
          run: () => setSidebarView("groups"),
        },
        {
          id: "view.favorites",
          token: "view_favorites",
          title: t("切换到收藏视图"),
          hint: t("只看置顶 / 收藏的笔记"),
          group: t("视图"),
          icon: "sidebar-star",
          keywords: "favorites 收藏 置顶 star pinned",
          disabled: sidebarView === "favorites",
          disabledReason: t("当前已经是收藏视图"),
          run: () => setSidebarView("favorites"),
        },
        {
          id: "view.aiPanel",
          token: "toggle_ai_panel",
          title: aiPanelOpen ? t("关闭 AI 面板") : t("打开 AI 面板"),
          hint: t("与 AI 对话，可读写当前笔记"),
          group: t("视图"),
          icon: "ai-chat",
          keywords: "ai 面板 chat 对话 助手",
          disabled: !enableAI,
          disabledReason: t("AI 能力已在设置里关闭"),
          run: toggleAiPanel,
        },

        /* ---------- 编辑器 ---------- */
        {
          id: "editor.code",
          token: "editor_code",
          title: t("编辑器：源码视图"),
          hint: t("只看 Markdown 源文"),
          group: t("编辑器"),
          icon: "ai-edit",
          keywords: "mode code 源码 编辑 视图",
          disabled: !editorNote,
          disabledReason: t("先打开一篇笔记"),
          run: () => editorActionsRef.current?.setMode("code"),
        },
        {
          id: "editor.split",
          token: "editor_split",
          title: t("编辑器：分栏视图"),
          hint: t("左边源码、右边预览"),
          group: t("编辑器"),
          icon: "sidebar-edit-square",
          keywords: "mode split 分栏 预览 视图",
          disabled: !editorNote,
          disabledReason: t("先打开一篇笔记"),
          run: () => editorActionsRef.current?.setMode("split"),
        },
        {
          id: "editor.read",
          token: "editor_read",
          title: t("编辑器：阅读视图"),
          hint: t("只看渲染结果"),
          group: t("编辑器"),
          icon: "sidebar-eye",
          keywords: "mode read 阅读 预览 视图",
          disabled: !editorNote,
          disabledReason: t("先打开一篇笔记"),
          run: () => editorActionsRef.current?.setMode("read"),
        },
        {
          id: "editor.fullscreen",
          token: "toggle_fullscreen",
          title: t("编辑器全屏 / 退出全屏"),
          hint: t("隐藏侧边栏与 AI 面板，只留正文"),
          group: t("编辑器"),
          icon: "sidebar-edit-square",
          keys: shortcutKeyText(bindings, "editor.fullscreen") || undefined,
          keywords: "fullscreen 全屏 沉浸",
          disabled: !editorNote,
          disabledReason: t("先打开一篇笔记"),
          run: () => editorActionsRef.current?.toggleFullscreen(),
        },
        {
          id: "editor.find",
          token: "find_in_note",
          title: t("在笔记中查找"),
          hint: keyHintOf("editor.find")
            ? t("{key} 也能打开", { key: keyHintOf("editor.find") })
            : undefined,
          group: t("编辑器"),
          icon: "ai-search",
          keys: shortcutKeyText(bindings, "editor.find") || undefined,
          keywords: "find search 查找 搜索",
          disabled: !editorNote,
          disabledReason: t("先打开一篇笔记"),
          run: () => editorActionsRef.current?.openSearch(false),
        },
        {
          id: "editor.replace",
          token: "replace_in_note",
          title: t("查找并替换"),
          hint: t("阅读视图下不可用"),
          group: t("编辑器"),
          icon: "ai-replace",
          keys: shortcutKeyText(bindings, "editor.replace") || undefined,
          keywords: "replace 替换 查找",
          disabled: !editorNote,
          disabledReason: t("先打开一篇笔记"),
          run: () => editorActionsRef.current?.openSearch(true),
        },

        /* ---------- 排序 ---------- */
        ...[
          { id: "sort.updated", token: "sort_updated", value: "updated_at", title: t("按更新时间排序"), hint: t("最近改过的排在前面"), keywords: "sort updated 排序 更新 时间" },
          { id: "sort.created", token: "sort_created", value: "created_at", title: t("按创建时间排序"), hint: t("按新建顺序排列"), keywords: "sort created 排序 创建 时间" },
          { id: "sort.title", token: "sort_title", value: "title", title: t("按标题排序"), hint: t("按标题字母 / 拼音顺序"), keywords: "sort title 排序 标题 名称" },
        ].map<PaletteCommand>((option) => ({
          id: option.id,
          token: option.token,
          title: option.title,
          hint: option.hint,
          group: t("排序"),
          icon: "sidebar-clock",
          keywords: option.keywords,
          disabled: sortBy === option.value,
          disabledReason: t("当前就是这种排序"),
          run: () => handleSortByChange(option.value),
        })),
        {
          id: "sort.order",
          token: "toggle_sort_order",
          title: sortOrder === "asc" ? t("改为降序排列") : t("改为升序排列"),
          hint: t("在当前的排序字段上翻转方向"),
          group: t("排序"),
          icon: "ai-arrow-down",
          keywords: "order asc desc 升序 降序 排序",
          run: handleToggleSortOrder,
        },

        /* ---------- 主题 ---------- */
        ...[
          { id: "theme.light", token: "theme_light", mode: "light" as const, title: t("主题：明亮"), hint: t("浅色外观"), keywords: "theme light 明亮 浅色 白色" },
          { id: "theme.dark", token: "theme_dark", mode: "dark" as const, title: t("主题：暗黑"), hint: t("深色外观"), keywords: "theme dark 暗黑 深色 夜间" },
          { id: "theme.system", token: "theme_system", mode: "system" as const, title: t("主题：跟随系统"), hint: t("随操作系统的深浅色切换"), keywords: "theme system auto 跟随 系统 自动" },
        ].map<PaletteCommand>((option) => ({
          id: option.id,
          token: option.token,
          title: option.title,
          hint: option.hint,
          group: t("主题"),
          icon: "settings-theme",
          keywords: option.keywords,
          disabled: theme.mode === option.mode,
          disabledReason: t("当前就是这个主题"),
          run: () => handleThemeChange({ ...theme, mode: option.mode }),
        })),

        /* ---------- 加密 ---------- */
        {
          id: "vault.lockAll",
          token: "lock_all",
          title: t("锁定全部加密内容"),
          hint: t("清空本次运行缓存的密钥，再打开加密笔记要重新输密码"),
          group: t("加密"),
          icon: "security-sealed",
          keywords: "lock 锁定 加密 全部 密钥 seal vault",
          disabled: !hasUnlockedEncryption,
          disabledReason: t("当前没有解锁中的加密内容"),
          run: () => void lockEverything("manual"),
        },

        /* ---------- 设置 ---------- */
        {
          id: "settings.open",
          token: "settings",
          aliases: ["setting"],
          title: t("打开设置"),
          hint: t("后面可跟分区名直接定位，如 settings theme"),
          group: t("设置"),
          icon: "ai-settings",
          keywords: "settings 设置 配置 偏好 preferences options",
          subcommands: SETTINGS_SECTIONS.filter(
            (section) => enableAI || !["provider", "chat", "context", "memory", "access"].includes(section.key),
          ).map((section) => ({
            value: section.key,
            title: t(section.label),
            icon: section.icon,
            keywords: `settings 设置 ${section.key} ${section.label}`,
          })),
          run: (section) => openSettings((section ?? "general") as SettingsSection),
        },

        /* ---------- 数据 ---------- */
        {
          id: "data.refresh",
          token: "refresh_notes",
          title: t("刷新笔记列表"),
          hint: t("重新从数据库读取分组与笔记"),
          group: t("数据"),
          icon: "sidebar-refresh",
          keywords: "refresh reload 刷新 重新加载",
          run: () => void loadData(),
        },
        {
          id: "data.clearSearch",
          token: "clear_search",
          title: t("清空侧边栏搜索"),
          hint: t("把搜索框与搜索结果一起清掉"),
          group: t("数据"),
          icon: "ai-close",
          keywords: "clear 清空 搜索 search",
          disabled: !searchQuery,
          disabledReason: t("当前没有搜索关键词"),
          run: () => setSearchQuery(""),
        },

        /* ---------- 插件 ---------- */
        // 插件贡献的命令：按插件名（manifest.name）自动分组；无插件时这段是空数组
        ...pluginContributions.commands().map<PaletteCommand>((cmd) => ({
          id: `plugin.${cmd.pluginId}.${cmd.id}`,
          token: cmd.id,
          title: t(cmd.label),
          group: cmd.group,
          icon: cmd.icon ?? "toolbox",
          keywords: `plugin 插件 ${cmd.group} ${cmd.pluginId} ${cmd.id}`,
          run: () => {
            void Promise.resolve(cmd.run(pluginHost.createPluginContext(cmd.pluginId))).catch((e) =>
              console.error("插件命令执行失败：", e),
            );
          },
        })),
      ]
    : [];

  /** 页签提示用当前生效键位；空串交给面板回退到默认文案 */
  const paletteTabHints: Partial<Record<PaletteMode, string>> = {
    jump: keyHintOf("app.jump"),
    command: keyHintOf("app.command"),
  };

  return {
    paletteOpen,
    setPaletteOpen,
    paletteMode,
    paletteNonce,
    paletteTags,
    paletteCommands,
    paletteTabHints,
    openPalette,
  };
}
