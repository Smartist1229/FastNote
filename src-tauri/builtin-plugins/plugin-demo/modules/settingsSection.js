/**
 * 设置分区模块：ctx.settings.section 在设置窗口「插件」分组下注册两个分区——
 * 「插件演示」（groups 分类：界面入口 / 弹窗与笔记 / AI / 样式与特效）与
 * 「插件演示 · 高级」（演示字段分组）。
 *
 * 同一插件注册多个分区时，宿主设置导航会以插件名为父级、分区为二级菜单；
 * 只有一个分区时不显示父级（与旧行为一致）。这是本插件配置的唯一 UI
 * （宿主不会为主动贡献分区的插件再自动生成配置分区），所以两个分区合计必须
 * 覆盖 plugin.json 的 config 全部 18 个键，否则删除配置弹窗后这些项没有入口。
 *
 * fields 与 plugin.json 的 config schema 同构，kind / default / options / min / max / step
 * 必须与 manifest.config 完全一致（后端按 manifest schema 过滤写入，不一致会被丢弃）。
 * 分区里改一项立即写进 config.json；group title / description、label / description、
 * select 选项文案全部跟随软件语言（ctx.i18n）。
 */

/** 按 manifest.config 构造一个完整 field：label / description 走 i18n，其余字段与 manifest 一致 */
const makeField = (t, key, kind, extra = {}) => ({
  key,
  label: t(`settings.fields.${key}`),
  kind,
  description: t(`settings.fields.${key}Desc`),
  ...extra,
});

export const registerSettingsSection = (ctx, config) => {
  if (config.settingsSectionEnabled === false) return;
  if (!ctx.settings || typeof ctx.settings.section !== "function") return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  try {
    // ── 分区一：主分区（字段按功能分类，覆盖 13 个 config 键） ──
    ctx.settings.section({
      id: "main",
      title: t("settings.sectionTitle"),
      icon: "toolbox",
      groups: [
        {
          id: "entry",
          title: t("settings.groups.entry"),
          description: t("settings.groups.entryDesc"),
          fields: [
            makeField(t, "menuEnabled", "boolean", { default: true }),
            makeField(t, "groupMenuEnabled", "boolean", { default: true }),
            makeField(t, "commandEnabled", "boolean", { default: true }),
            makeField(t, "toolbarEnabled", "boolean", { default: true }),
          ],
        },
        {
          id: "modalNotes",
          title: t("settings.groups.modalNotes"),
          description: t("settings.groups.modalNotesDesc"),
          fields: [
            makeField(t, "modalEnabled", "boolean", { default: true }),
            makeField(t, "notesEnabled", "boolean", { default: true }),
            makeField(t, "hooksEnabled", "boolean", { default: true }),
          ],
        },
        {
          id: "ai",
          title: t("settings.groups.ai"),
          description: t("settings.groups.aiDesc"),
          fields: [
            makeField(t, "aiToolEnabled", "boolean", { default: true }),
            makeField(t, "aiDemoEnabled", "boolean", { default: true }),
          ],
        },
        {
          id: "style",
          title: t("settings.groups.style"),
          description: t("settings.groups.styleDesc"),
          fields: [
            makeField(t, "theme", "select", {
              default: "none",
              options: [
                { value: "none", label: t("settings.options.themeNone") },
                { value: "accent", label: t("settings.options.themeAccent") },
                { value: "focus", label: t("settings.options.themeFocus") },
              ],
            }),
            makeField(t, "effectEnabled", "boolean", { default: false }),
            makeField(t, "hideStats", "boolean", { default: false }),
            makeField(t, "greeting", "string", { default: "你好！" }),
          ],
        },
      ],
    });

    // ── 分区二：高级 / 演示字段（覆盖剩余 5 个 config 键，也演示分区内小分组） ──
    ctx.settings.section({
      id: "advanced",
      title: t("settings.advancedTitle"),
      icon: "ai-settings",
      groups: [
        {
          id: "demo",
          title: t("settings.demoGroupTitle"),
          description: t("settings.demoGroupDesc"),
          fields: [
            makeField(t, "settingsSectionEnabled", "boolean", { default: true }),
            makeField(t, "demoBool", "boolean", { default: true }),
            makeField(t, "demoText", "string", { default: "hello" }),
            makeField(t, "demoMode", "select", {
              default: "simple",
              options: [
                { value: "simple", label: t("settings.options.demoSimple") },
                { value: "advanced", label: t("settings.options.demoAdvanced") },
              ],
            }),
            makeField(t, "demoCount", "number", { default: 3, min: 1, max: 10, step: 1 }),
          ],
        },
      ],
    });
  } catch (e) {
    // 没声明 settings.section 权限时会抛错，catch 掉避免插件整体加载失败
    console.warn("[plugin-demo] 设置分区注册被拒绝（可能未声明 settings.section 权限）：", e);
  }
};
