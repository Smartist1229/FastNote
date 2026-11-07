/**
 * 类型声明的**真源在模板目录**里：`plugin-template/plugin-api.d.ts`。
 *
 * 放那里的原因：模板是「分发给插件作者」的最小单元——整目录拷走就自带类型，
 * 不用再额外记一个「还要去仓库根拷个文件」。这个根目录同名文件只是转发，
 * 方便老链接 / 老文档继续用。
 */
export * from "./plugin-template/plugin-api";
