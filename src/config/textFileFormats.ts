/* 纯文本文件格式白名单：压缩包「其他文件格式」逐篇选后缀 与 Ctrl+S 保存笔记 共用同一份清单。
   只收录纯文本格式——内容本身就是文本，改后缀即可直接打开；
   二进制格式（docx / xlsx / pdf 等）不在其中，因为它们需要真正的格式转换，直接写文本会打不开。 */

export interface TextFormatOption {
  /** 后缀（小写，不带点） */
  ext: string;
  /** 简短名称，用于保存对话框的格式过滤器（要保证唯一） */
  name: string;
  /** 说明，用于后缀选择列表 */
  label: string;
}

export interface TextFormatGroup {
  name: string;
  formats: TextFormatOption[];
}

export const TEXT_FORMAT_GROUPS: TextFormatGroup[] = [
  {
    name: "通用文本",
    formats: [
      { ext: "txt", name: "基础文本", label: "记事本默认格式" },
      { ext: "md", name: "Markdown", label: "Markdown 标记文本" },
      { ext: "csv", name: "CSV 表格", label: "逗号分隔表格，Excel / WPS 可打开" },
      { ext: "json", name: "JSON 数据", label: "JSON 数据" },
      { ext: "xml", name: "XML 标记", label: "XML 标记文本" },
      { ext: "html", name: "网页", label: "HTML 网页源码" },
      { ext: "htm", name: "网页 HTM", label: "旧式 HTML 网页源码" },
      { ext: "css", name: "样式表", label: "CSS 样式表" },
      { ext: "svg", name: "矢量图", label: "矢量图，本质是 XML 纯文本" },
      { ext: "rst", name: "结构化文本", label: "reStructuredText 文档" },
      { ext: "tex", name: "LaTeX", label: "LaTeX 排版源码" },
    ],
  },
  {
    name: "配置文件",
    formats: [
      { ext: "ini", name: "INI 配置", label: "Windows 配置文件" },
      { ext: "conf", name: "CONF 配置", label: "Linux / 程序配置" },
      { ext: "config", name: "CONFIG 配置", label: "程序配置" },
      { ext: "properties", name: "Java 配置", label: "Java 配置文件" },
      { ext: "env", name: "环境变量", label: "环境变量配置" },
      { ext: "yaml", name: "YAML 配置", label: "YAML 配置" },
      { ext: "yml", name: "YML 配置", label: "YAML 配置，另一种后缀" },
      { ext: "toml", name: "TOML 配置", label: "TOML 配置" },
      { ext: "gitignore", name: "Git 忽略清单", label: "Git 忽略清单" },
      { ext: "plist", name: "macOS 配置", label: "macOS 配置，XML 格式" },
      { ext: "nginx", name: "Nginx 配置", label: "Nginx 配置，常命名为 nginx.conf" },
    ],
  },
  {
    name: "脚本与源码",
    formats: [
      { ext: "bat", name: "批处理", label: "Windows 批处理脚本" },
      { ext: "cmd", name: "命令脚本", label: "Windows 命令脚本" },
      { ext: "sh", name: "Shell 脚本", label: "Shell 脚本" },
      { ext: "py", name: "Python", label: "Python 源码" },
      { ext: "js", name: "JavaScript", label: "JavaScript 源码" },
      { ext: "php", name: "PHP", label: "PHP 网页源码" },
      { ext: "rb", name: "Ruby", label: "Ruby 源码" },
      { ext: "go", name: "Go", label: "Go 源码" },
      { ext: "kt", name: "Kotlin", label: "Kotlin 源码" },
      { ext: "lua", name: "Lua", label: "Lua 脚本" },
      { ext: "awk", name: "awk 脚本", label: "awk 脚本" },
      { ext: "gradle", name: "Gradle", label: "Gradle 构建脚本" },
    ],
  },
  {
    name: "数据、日志与字幕",
    formats: [
      { ext: "sql", name: "SQL", label: "SQL 数据库脚本" },
      { ext: "log", name: "日志", label: "日志文件" },
      { ext: "srt", name: "字幕", label: "字幕文件" },
      { ext: "ass", name: "高级字幕", label: "高级字幕" },
      { ext: "diff", name: "DIFF 补丁", label: "代码补丁" },
      { ext: "patch", name: "PATCH 补丁", label: "代码补丁" },
      { ext: "dockerfile", name: "Dockerfile", label: "Docker 构建文件" },
    ],
  },
];

/** 全部允许的后缀（小写、不含点） */
export const TEXT_FORMAT_EXTS: string[] = TEXT_FORMAT_GROUPS.flatMap((group) =>
  group.formats.map((format) => format.ext)
);

const TEXT_FORMAT_EXT_SET = new Set(TEXT_FORMAT_EXTS);

/** 逐篇自选后缀时，用户还没改过的笔记使用的默认值 */
export const DEFAULT_TEXT_EXT = "txt";

/** 规范化用户输入：去掉前导点、转小写、只保留字母数字 */
export const normalizeTextExt = (raw: string): string =>
  raw
    .trim()
    .replace(/^\.+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** 用户输入或选择的后缀是否在白名单内 */
export const isSupportedTextExt = (raw: string): boolean =>
  TEXT_FORMAT_EXT_SET.has(normalizeTextExt(raw));
