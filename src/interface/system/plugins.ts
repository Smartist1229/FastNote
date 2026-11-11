/* 插件系统的数据层类型：插件清单（plugin.json）。 */

/** 插件可申请的权限白名单（与 Rust 端 ALLOWED_PERMISSIONS 保持同步）。
 * 权限标识符用点分格式 `domain.action`；label / desc 是中文展示用。 */
export const PERMISSION_INFO: Record<
  string,
  { label: string; desc: string }
> = {
  "notes.read": {
    label: "读取笔记",
    desc: "读取您的笔记正文内容",
  },
  "notes.write": {
    label: "写入笔记",
    desc: "创建、修改或删除您的笔记",
  },
  "editor.insert": {
    label: "编辑器插入",
    desc: "在光标位置插入文本或标记",
  },
  "config.read_write": {
    label: "读写插件配置",
    desc: "读取和保存该插件自身的设置项",
  },
  "ai.tool": {
    label: "AI Agent 工具",
    desc: "向 AI 助手贡献只读工具（只能读取笔记内容）",
  },
  "ai.prompt": {
    label: "修改 AI 提示词",
    desc: "向 AI 注入额外的系统提示词指令",
  },
  "ai.provider": {
    label: "注册 AI 服务商",
    desc: "在 AI 服务商设置中提供预填模板（API Key 仍需您自己填写）",
  },
  "ai.settings": {
    label: "修改 AI 设置",
    desc: "读取和修改 AI 的行为参数（如生成长度、流式开关等）",
  },
  "settings.section": {
    label: "添加设置分区",
    desc: "在设置窗口中添加该插件自己的设置分区（值保存在插件配置里）",
  },
  "db.read_write": {
    label: "插件私有数据表",
    desc: "创建、删除并读写该插件自己的数据表（表名带插件前缀，碰不到宿主与其它插件的数据）",
  },
  "window.open": {
    label: "打开插件窗口",
    desc: "用插件目录里的页面单独开一个窗口（插件停用时会一起关掉）",
  },
  "shortcut.register": {
    label: "注册快捷键",
    desc: "注册全局快捷键并接管对应的按键组合（插件停用时自动注销）",
  },
  "fs.read_write": {
    label: "插件文件存储",
    desc: "在该插件自己的数据目录里读写文件（<数据目录>/plugin-data/<插件>/，单文件 4MB 上限）",
  },
  "net.fetch": {
    label: "联网（宿主代理）",
    desc: "通过宿主代理访问 plugin.json 里 netDomains 声明的主机（不支持任意域名）",
  },
};

/**
 * 配置项控件种类：
 *   boolean → 开关；string → 文本框；number → 数字框；select → 下拉；
 *   shortcut → 组合键捕获框（值仍是 "Ctrl+Alt+P" 这样的字符串）
 */
export type PluginConfigFieldKind = "boolean" | "string" | "number" | "select" | "shortcut";

/** select 字段的可选项 */
export interface PluginConfigOption {
  value: string;
  label: string;
  /** 各语言下的候选文案，规则同 PluginConfigField.labelI18n */
  labelI18n?: Record<string, string>;
}

/**
 * 插件配置字段（plugin.json 的 config 数组项）。
 * default 在缺失配置时由后端补上；options 仅 select 用，min / max / step 仅 number 用。
 *
 * labelI18n / descriptionI18n：按语言覆盖文案，键可以是 `"en"` 或 `"en-US"`。
 * 没有它的话，设置界面只能拿 label 的中文去查**宿主**词典——插件文案不在宿主词典里，
 * 英文界面下就会显示中文。
 */
export interface PluginConfigField {
  key: string;
  label: string;
  labelI18n?: Record<string, string>;
  kind: PluginConfigFieldKind;
  default?: unknown;
  description?: string;
  descriptionI18n?: Record<string, string>;
  options?: PluginConfigOption[];
  min?: number;
  max?: number;
  step?: number;
}

/**
 * 插件清单，与后端 PluginManifest（serde camelCase）严格一致。
 * id 是插件身份，dirName 是落盘目录名（实例键）；前端一切运行时操作都用 dirName。
 * entry / style 是插件目录内的相对路径；author / description 可为空串。
 */
export interface PluginManifest {
  id: string;
  /** 实例键：插件目录名（唯一），启用状态 / 卸载 / 读资源都以它为准 */
  dirName: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** 插件图标的本应用协议 URL；由宿主探测 icon.png / icon.svg / icon.webp / icon.jpg 后填充 */
  iconUrl?: string;
  /** 入口脚本，如 "main.js" */
  entry?: string;
  /** 样式文件，如 "style.css" */
  style?: string;
  /** 未持久化过启用状态时的默认开关 */
  defaultEnabled: boolean;
  minAppVersion?: string;
  /**
   * 运行方式：
   *   - "inpage"（默认）：跑在主页面里，能力全开，但插件要自己可信；
   *   - "sandbox"：跑在独立源的隐藏 iframe 里，只能通过 RPC 申请能力（安全边界真实）。
   */
  runtime?: "inpage" | "sandbox";
  /** 插件 API 版本：插件按哪一版 ctx 契约编写（宿主只接受 <= 自身支持版本） */
  apiVersion?: number;
  /** 联网白名单（ctx.net.fetch 用）：主机名或后缀，如 "api.example.com"；空表示不允许联网 */
  netDomains?: string[];
  /** 展示用标签 */
  tags?: string[];
  /** 项目主页（空串表示没有） */
  homepage?: string;
  license?: string;
  /** 可持久化配置的 schema；为空表示该插件没有配置项 */
  config?: PluginConfigField[];
  /** 插件声明的权限标识符数组（domain.action 格式）；为空表示不需要特殊权限 */
  permissions?: string[];
  /** 插件自带语言包：语言标识（如 zh / en）→ 插件目录内的 .json 相对路径 */
  i18n?: Record<string, string>;
}
