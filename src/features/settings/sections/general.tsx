/* 通用：语言、链接打开方式、启动行为、托盘、历史版本与安全锁定。 */

import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

export const buildGeneralRows = ({ appSettings, setApp }: SettingsRowsContext): SettingRow[] => [
  {
    section: "general",
    kind: "select",
    badges: badges("live"),
    title: "语言",
    desc: "统一应用到软件和编辑器；跟随系统时自动使用系统语言。",
    keywords: "语言 language locale 简体中文 English system",
    value: appSettings.general.language ?? "system",
    options: [
      { value: "system", label: "跟随系统" },
      { value: "zh-CN", label: "简体中文" },
      { value: "en-US", label: "English" },
    ],
    onChange: (v) => setApp("general", "language", v),
  },
  {
    section: "general",
    kind: "segment",
    badges: badges("live"),
    title: "链接打开方式",
    desc: "笔记与 AI 回复里的链接在哪里打开；mailto: 等非网页链接始终交给默认浏览器。",
    keywords: "链接 打开方式 浏览器 软件内 默认浏览器 外部 link open browser external",
    value: appSettings.general.linkOpenTarget ?? "system",
    options: [
      { value: "app", label: "软件内打开" },
      { value: "system", label: "默认浏览器" },
    ],
    onChange: (v) => setApp("general", "linkOpenTarget", v),
  },
  // 链接交给系统浏览器时，内置浏览器才有意义的两个开关整组隐藏；
  // 已存的值保留在设置里，切回「软件内打开」后原样恢复
  ...(appSettings.general.linkOpenTarget === "app"
    ? [
        {
          section: "general" as const,
          kind: "toggle" as const,
          badges: badges("live"),
          title: "允许多个浏览器窗口",
          desc: "开启后每次打开链接都新建一个浏览器窗口；关闭则复用同一个窗口。",
          keywords: "浏览器 多窗口 多开 复用 browser multi window tabs 软件内",
          value: appSettings.general.browserMultiWindow,
          onChange: (v: boolean) => setApp("general", "browserMultiWindow", v),
        },
        {
          section: "general" as const,
          kind: "toggle" as const,
          badges: badges("live"),
          title: "随机浏览器指纹",
          desc: "为每个浏览器窗口生成一份随机指纹（屏幕、显卡、Canvas / WebGL 等），窗口之间互不相同；同一窗口内身份保持不变。不模拟 TLS 指纹与 WebRTC 公网 IP。",
          keywords: "指纹 随机 浏览器 防关联 隐私 UA 时区 canvas webgl fingerprint random privacy",
          value: appSettings.general.browserRandomFingerprint,
          onChange: (v: boolean) => setApp("general", "browserRandomFingerprint", v),
        },
      ]
    : []),
  {
    section: "general",
    kind: "toggle",
    badges: badges("startup"),
    title: "启动时清空回收站",
    desc: "每次打开软件时，永久删除回收站里的全部笔记（不可恢复）。",
    keywords: "回收站 清空 清理 垃圾 startup",
    value: appSettings.general.cleanTrashOnStartup,
    onChange: (v) => setApp("general", "cleanTrashOnStartup", v),
  },
  {
    section: "general",
    kind: "toggle",
    badges: badges("startup", "danger"),
    title: "启用单例模式",
    desc: "同一时间只运行一个软件进程，再次启动时唤起已有窗口；多进程同时写同一个数据库容易丢数据。",
    keywords: "单例 多开 多进程 实例 single instance 单实例 重复启动",
    value: appSettings.general.singleInstance,
    onChange: (v) => setApp("general", "singleInstance", v),
  },
  {
    section: "general",
    kind: "toggle",
    badges: badges("live"),
    title: "开启 AI 能力",
    desc: "开启 AI 功能。AI 需要联网，并可能读取笔记内容，请注意隐私安全。",
    keywords: "AI 能力 开关 enable",
    value: appSettings.general.enableAI,
    onChange: (v) => setApp("general", "enableAI", v),
  },
  {
    section: "general",
    kind: "number",
    badges: badges("live"),
    title: "最近历史版本保留数",
    desc: "每篇笔记保留的最近自动版本数；手动「存版本」不计入上限。",
    keywords: "历史 版本 回滚 history version 快照 上限 固定",
    value: appSettings.general.noteHistoryLimit,
    min: 1,
    max: 100,
    unit: "个",
    onChange: (v) => setApp("general", "noteHistoryLimit", v),
  },
  {
    section: "general",
    kind: "number",
    badges: badges("live"),
    title: "自动历史版本间隔",
    desc: "距上一条历史超过这个间隔才记录新版本；内容无变化不重复记录。",
    keywords: "历史 版本 间隔 快照 history interval",
    value: appSettings.general.noteHistoryIntervalMinutes,
    min: 1,
    max: 60,
    unit: "分钟",
    onChange: (v) => setApp("general", "noteHistoryIntervalMinutes", v),
  },
  {
    section: "general",
    kind: "number",
    badges: badges("live"),
    title: "空闲自动锁定",
    desc: "无操作超过这个时长后锁定已解锁的加密笔记，需要重新输入密码；0 表示不锁定。",
    keywords: "加密 锁定 自动 lock idle 离开 安全 密码",
    value: appSettings.general.autoLockMinutes,
    min: 0,
    max: 120,
    step: 5,
    unit: "分钟",
    onChange: (v) => setApp("general", "autoLockMinutes", v),
  },

  // ---- 托盘与开机自启动：归属「通用」分区 ----
  {
    section: "general",
    kind: "toggle",
    badges: badges("live"),
    title: "显示托盘图标",
    desc: "关闭窗口时最小化到托盘，托盘右键菜单可退出软件。",
    keywords: "托盘 tray 图标 最小化 通知区",
    value: appSettings.general.trayEnabled,
    onChange: (v) => setApp("general", "trayEnabled", v),
  },
  // 未开启托盘时关闭按钮只会直接退出，这一项无从选择，整行不出现
  ...(appSettings.general.trayEnabled
    ? [
        {
          section: "general" as const,
          kind: "segment" as const,
          badges: badges("live"),
          title: "关闭窗口时",
          desc: "点击窗口关闭按钮的行为。",
          keywords: "关闭 退出 minimize exit 行为 托盘",
          value: appSettings.general.closeBehavior,
          options: [
            { value: "minimize", label: "最小化到托盘" },
            { value: "exit", label: "直接退出" },
          ],
          onChange: (v: string) => setApp("general", "closeBehavior", v),
        },
      ]
    : []),
  {
    section: "general",
    kind: "toggle",
    badges: badges("startup"),
    title: "开机自启动",
    desc: "计算机启动时自动运行 FastNote。",
    keywords: "开机 自启动 boot autostart",
    value: appSettings.general.autostart,
    onChange: (v) => setApp("general", "autostart", v),
  },
  // 开机后最小化到托盘同时依赖「开机自启动」与「托盘图标」，缺一个就整行隐藏
  ...(appSettings.general.autostart && appSettings.general.trayEnabled
    ? [
        {
          section: "general" as const,
          kind: "toggle" as const,
          badges: badges("startup"),
          title: "开机后最小化到托盘",
          desc: "开机自启动后不弹出主窗口，只在托盘显示图标。",
          keywords: "开机 自启动 最小化 tray 后台",
          value: appSettings.general.minimizeToTray,
          onChange: (v: boolean) => setApp("general", "minimizeToTray", v),
        },
      ]
    : []),
];

export const GeneralSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="general" rows={ctx.rowsOf("general")} groupRefs={ctx.groupRefs} />
);
