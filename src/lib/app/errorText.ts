/**
 * 错误文案的统一出口：把 Tauri 抛出的东西压成一行可读文本，并在英文界面下做翻译。
 *
 * 为什么需要这一层：
 * - 各组件过去各自写 `const errorText = (e) => e instanceof Error ? e.message : String(e)`，
 *   11 份副本，改一处文案风格要改 11 次；
 * - Rust 命令的 `Err(String)` 是**中文硬编码**，`formatError` 原样展示，英文界面下必然露中文。
 *
 * 翻译策略是「模式优先、整句兜底」：Rust 的 166 处错误不可能逐条列，但它们的结构高度重复
 * （`XX失败：原因`、`XX不存在`、`XX不能为空`）。这里先把高频整句按精确文本翻掉，
 * 再用前缀表覆盖结构性句型。**原因部分（HTTP body、系统错误）保持原文**——那本来就不是中文。
 *
 * 未命中任何规则的返回原文：宁可显示中文，也不要吞掉错误或换成一句无信息量的兜底。
 */

import { getLocale } from "@/i18n";

/** 从任意抛出物里取出消息文本（不翻译） */
export const rawErrorText = (error: unknown): string => {
  if (error == null) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  // Tauri 有时抛的是对象（例如结构化错误），尽量给出可读的一行
  try {
    const text = JSON.stringify(error);
    return text === "{}" ? String(error) : text;
  } catch {
    return String(error);
  }
};

/** 整句精确映射：高频、且在英文界面下最容易看到的那些 */
const SENTENCES: Record<string, string> = {
  // AI
  "不支持的 API 兼容类型": "Unsupported API compatibility type",
  "没有从响应中解析到模型列表": "No model list found in the response",
  "没有从 AI 响应中解析到文本内容": "No text content found in the AI response",
  "请先在设置中勾选可用模型": "Pick an available model in settings first",
  "没有从 AI 响应中解析到文本内容。": "No text content found in the AI response.",
  // 语义检索
  "语义模型尚未下载": "The semantic model has not been downloaded",
  "语义模型尚未下载，请先在设置中下载": "The semantic model has not been downloaded; get it in settings first",
  "数据库被占用，请稍后重试": "The database is busy; try again in a moment",
  // 备份 / 恢复
  "这不是 FastNote 的备份文件": "This is not a FastNote backup file",
  "这不是 FastNote 导出的 SQLite 备份文件": "This is not a SQLite backup exported by FastNote",
  "备份由更新版本的 FastNote 创建，请先升级软件再恢复":
    "This backup was created by a newer FastNote; update the app before restoring",
  "备份文件不存在": "Backup file not found",
  "SQLite 备份文件已损坏，无法恢复": "The SQLite backup file is corrupted and cannot be restored",
  "不能用当前正在使用的数据库文件恢复":
    "You cannot restore from the database file that is currently in use",
  // 加密
  "密码错误": "Wrong password",
  "密码不能为空": "Password cannot be empty",
  // 通用
  "未知错误": "Unknown error",
};

/** 结构性句型里的「主语」翻译表：`XX失败：…` / `XX不存在` 用 */
const SUBJECTS: Record<string, string> = {
  保存: "Save",
  读取: "Read",
  写入: "Write",
  导入: "Import",
  导出: "Export",
  删除: "Delete",
  恢复: "Restore",
  备份: "Backup",
  解析: "Parse",
  加载: "Load",
  创建: "Create",
  更新: "Update",
  重命名: "Rename",
  移动: "Move",
  复制: "Copy",
  加密: "Encrypt",
  解密: "Decrypt",
  下载: "Download",
  安装: "Install",
  上传: "Upload",
  打开: "Open",
  关闭: "Close",
  清空: "Clear",
  校验: "Verify",
  迁移: "Migrate",
  同步: "Sync",
  获取: "Fetch",
  应用: "Apply",
  注册: "Register",
  注销: "Unregister",
  执行: "Run",
};

/** 结构性规则：按顺序匹配，命中即返回 */
const PATTERNS: { re: RegExp; to: (m: RegExpMatchArray) => string }[] = [
  // `AI 请求失败：404 …` —— 这类首字母缩写不查表，直接保留
  { re: /^(AI|API|HTTP|SQLite|WebDAV|JSON|URL) (.+)失败：([\s\S]*)$/, to: (m) => `${m[1]} ${m[2]} failed: ${m[3]}` },
  // `获取模型失败：…` / `保存配置失败：…`
  {
    re: /^(.+)失败：([\s\S]*)$/,
    to: (m) => {
      const subject = SUBJECTS[m[1]] ?? m[1];
      return `${subject} failed: ${m[2]}`;
    },
  },
  // `备份文件不存在` / `模型文件不存在`
  {
    re: /^(.+)不存在$/,
    to: (m) => `${SUBJECTS[m[1]] ?? m[1]} not found`,
  },
  // `…不能为空`
  { re: /^(.+)不能为空$/, to: (m) => `${SUBJECTS[m[1]] ?? m[1]} cannot be empty` },
  // `非法的…` / `无效的…`
  { re: /^(?:非法的|无效的)(.+)$/, to: (m) => `Invalid ${m[1]}` },
  // `请先…`
  { re: /^请先(.+)$/, to: (m) => `Please ${m[1]} first` },
];

/**
 * 把一条 Rust 错误翻成当前界面的语言。
 * 中文界面直接返回原文（没有必要把中文再"翻译"成中文）；英文界面按规则逐层尝试。
 */
export const translateErrorText = (text: string): string => {
  if (!text || getLocale() !== "en-US") return text;
  const exact = SENTENCES[text];
  if (exact) return exact;
  for (const { re, to } of PATTERNS) {
    const match = text.match(re);
    if (match) return to(match);
  }
  return text;
};

/**
 * 面向用户展示的错误文案：提取 + 按需翻译。
 *
 * 各组件统一用它，不要再自己写 `e instanceof Error ? e.message : String(e)`——
 * 那份副本既不会翻译，也挡住了以后统一加工（比如给错误加编号）的路。
 */
export const errorText = (error: unknown): string => translateErrorText(rawErrorText(error));
