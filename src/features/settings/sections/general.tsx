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
    desc: "笔记、AI 回复和关于页里的链接在哪里打开。软件内打开会在独立窗口里显示网页（带后退、前进、刷新、地址栏和加载进度），不打断当前笔记；mailto: 等非网页链接仍交给默认浏览器。",
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
          desc: "「链接打开方式」为软件内打开时生效：开启后每次打开链接都会新建一个浏览器窗口，方便同时看多个页面；关闭后所有链接复用同一个窗口。无论开关如何，在浏览器窗口里点击的链接始终在该窗口内跳转。",
          keywords: "浏览器 多窗口 多开 复用 browser multi window tabs 软件内",
          value: appSettings.general.browserMultiWindow,
          onChange: (v: boolean) => setApp("general", "browserMultiWindow", v),
        },
        {
          section: "general" as const,
          kind: "toggle" as const,
          badges: badges("live"),
          title: "随机浏览器指纹",
          desc: "软件内打开的每个新浏览器窗口都会随机生成一份独立指纹（屏幕、显卡型号、Canvas / WebGL 噪声、硬件信息等），窗口之间互不相同；同一窗口内换页面不换身份，要换身份先关掉窗口。Chrome 版本取自本机浏览器内核的真实版本，避免按 API 探测出的内核版本与 UA 对不上。操作系统固定为本机系统（字体、显卡、平台版本才对得上），时区与语言跟随本机时区。UA、UA-CH（Sec-CH-UA）请求头与 Accept-Language 由内核按这份指纹生成并逐请求改写，主线程与 Worker 读到的身份一致。不模拟 TLS 指纹与 WebRTC 公网 IP。",
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
    desc: "开启后同一时间只允许运行一个软件进程：再次双击启动时不会再开新窗口，而是把已运行的窗口叫到前台。关闭后可以同时打开多个进程，但多个进程会同时读写同一个笔记数据库，极易互相覆盖、导致笔记保存失败或内容丢失，请确认清楚再关闭（默认开启）。",
    keywords: "单例 多开 多进程 实例 single instance 单实例 重复启动",
    value: appSettings.general.singleInstance,
    onChange: (v) => setApp("general", "singleInstance", v),
  },
  {
    section: "general",
    kind: "toggle",
    badges: badges("live"),
    title: "开启 AI 能力",
    desc: "开启后可为软件开启 AI 能力，但本软件默认不联网，如果开启需要联网与 AI 进行通信，AI 可能会读取所有笔记内容。请注意个人隐私与笔记安全。",
    keywords: "AI 能力 开关 enable",
    value: appSettings.general.enableAI,
    onChange: (v) => setApp("general", "enableAI", v),
  },
  {
    section: "general",
    kind: "number",
    badges: badges("live"),
    title: "最近历史版本保留数",
    desc: "每篇笔记保留多少个最近自动版本；最早一版始终额外保留，过去 30 天每天也会留一条，方便找回最初内容。手动「存版本」与固定的版本不计入上限、不会被自动清理。改小后，已有笔记会在下次编辑时收敛到新上限。",
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
    desc: "自动保存不会每次都记历史：距上一条历史满这个间隔才再记一条，内容没有变化也不重复记；打开笔记时的基线与手动「存版本」不受此间隔限制。调小记录更细，但更早的版本会被更快挤出保留窗口；调大更省空间，中间过程记录更少。",
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
    desc: "超过这段时间没有任何键盘、鼠标或滚轮操作，就清空内存里的解密密钥：已解锁的加密笔记与分组会回到锁定态，需要重新输入密码。设为 0 表示不自动锁定。",
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
    desc: "开启后，关闭窗口时软件将最小化到托盘；托盘图标的右键菜单可直接退出软件。",
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
          desc: "点击窗口关闭按钮时的行为。最小化到托盘：隐藏窗口但保留托盘图标；直接退出：关闭软件。",
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
          desc: "开启：开机自启动后不弹出主窗口，只在托盘显示图标，点击托盘图标再打开。关闭：开机后正常显示窗口。",
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
