/**
 * AI 能力演示模块：
 * - AI tool「plugin-demo.count-chars」（只读：handler 里只有 notes.getContent，需 ai.tool 权限；
 *   受独立开关 aiToolEnabled 门控；label / desc / description / args 全部走 i18n）
 * - 系统提示词注入（ai.prompt）：引导模型优先调用 count-chars
 * - 服务商模板（ai.provider）：只作「新建服务商」预填模板，用户填好 key 保存后才落库
 * - 读 / 写 AI 设置（ai.settings）：命令面板里读当前 maxRounds/streaming，再用 config 的
 *   demoCount 做增量写回 maxRounds（数字类型，白名单键）
 * 所有用户可见文案都通过 ctx.i18n 取值。
 */

/** AI 能力演示（受 aiDemoEnabled 门控；AI tool 另受 aiToolEnabled 门控） */
export const registerAi = (ctx, config) => {
  if (config.aiDemoEnabled === false) return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  // ① AI tool：只读统计笔记字符数 / 词数 / 行数
  if (config.aiToolEnabled !== false && ctx.ai && typeof ctx.ai.tool === "function") {
    try {
      ctx.ai.tool({
        id: "plugin-demo.count-chars",
        label: t("ai.toolLabel"),
        desc: t("ai.toolDesc"),
        description: t("ai.toolDescription"),
        args: { noteId: t("ai.argNoteId") },
        handler: async (args, toolCtx) => {
          const noteId = String(args.noteId ?? "").trim();
          if (!noteId) {
            return { error: ctx.i18n.t("ai.argError") };
          }
          try {
            const content = await toolCtx.notes.getContent(noteId);
            const chars = content.length;
            const words = content.trim() ? content.trim().split(/\s+/).filter(Boolean).length : 0;
            const lines = content ? content.split(/\r?\n/).length : 0;
            return { noteId, chars, words, lines, preview: content.slice(0, 100) };
          } catch (e) {
            return { error: ctx.i18n.t("ai.readError", { error: e }) };
          }
        },
      });
    } catch (e) {
      // 没声明 ai.tool 权限时 ctx.ai.tool 会抛错，catch 掉避免插件整体加载失败
      console.warn("[plugin-demo] AI tool 注册被拒绝（可能未声明 ai.tool 权限）：", e);
    }
  }

  // ② 系统提示词注入：append 到内置提示词末尾，引导模型优先调用本工具
  try {
    ctx.ai.systemPrompt({
      id: "plugin-demo.count-chars-hint",
      text: t("ai.promptLine"),
      position: "append",
    });
  } catch (e) {
    console.warn("[plugin-demo] 系统提示词注入被拒绝（可能未声明 ai.prompt 权限）：", e);
  }

  // ③ 服务商模板：只在「新建服务商」里预填，不落库；用户填好 API Key 保存后才写入 ai_providers 表
  try {
    ctx.ai.provider({
      id: "demo-openai-compatible",
      name: t("ai.providerName"),
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o-mini", "gpt-4o"],
      apiKeyHint: t("ai.providerHint"),
    });
  } catch (e) {
    console.warn("[plugin-demo] 服务商模板注册被拒绝（可能未声明 ai.provider 权限）：", e);
  }

  // ④ 读 AI 设置 + 用 config.demoCount 做增量写回 maxRounds
  ctx.command({
    id: "plugin-demo.ai-settings",
    label: t("ai.settingsCommand"),
    icon: "ai-settings-bold",
    run: async (c) => {
      const tr = c.i18n.t;
      try {
        const before = await c.ai.getSettings();
        c.ui.toast(
          tr("ai.settingsToast", {
            maxRounds: before.maxRounds,
            streaming: before.streaming,
          }),
          "info",
        );
        const raw = Number(config.demoCount);
        const base = Number.isFinite(raw) ? raw : 3;
        const next = Math.min(200, Math.max(0, base + 1));
        await c.ai.updateSettings({ maxRounds: next });
        const after = await c.ai.getSettings();
        c.ui.toast(
          tr("ai.settingsUpdated", { value: next, readBack: after.maxRounds }),
          "success",
        );
      } catch (e) {
        c.ui.toast(tr("ai.settingsUpdateFailed", { error: e }), "error");
      }
    },
  });
};
