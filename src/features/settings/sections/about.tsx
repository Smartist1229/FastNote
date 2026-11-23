/* 关于：软件名 / 作者 / 版本 / 更新检查（第一块）与特别感谢 / 开源项目（第二块）。 */

import { useEffect, useRef, useState } from "react";
import { getName, getVersion } from "@tauri-apps/api/app";
import type { EnumOption } from "@/interface/settings/settings";
import {
  APP_AUTHOR,
  APP_NAME_FALLBACK,
  APP_RELEASES_URL,
  OPEN_SOURCE_PROJECTS,
  SPECIAL_THANKS,
} from "@/config/app/about";
import { openExternalLink } from "@/lib/app/externalLink";
import { exportDiagnostics, getLogDir, openAppFolder } from "@/api/system/system";
import { errorText } from "@/lib/app/errorText";
import { useToast } from "@/components/common/Toast";
import { save } from "@tauri-apps/plugin-dialog";
import { checkForUpdates, openUpdateDialog, useUpdater } from "@/stores/updaterStore";
import { formatSpeed } from "@/lib/text/format";
import { useI18n } from "@/i18n";
import { SelectInput } from "../controls";
import type { SettingsSectionContext } from "../context";

/** 运行期间自动检查更新的间隔选项（分钟）；0 = 关闭，默认值与 appDefaults 保持一致 */
const UPDATE_CHECK_INTERVAL_OPTIONS: EnumOption[] = [
  { value: "0", label: "关闭" },
  { value: "5", label: "5 分钟" },
  { value: "10", label: "10 分钟" },
  { value: "15", label: "15 分钟" },
  { value: "30", label: "30 分钟" },
  { value: "60", label: "1 小时" },
];

/** 「已是最新版本」显示多久后自动收起（毫秒）：看一眼就够，不长期占位 */
const UP_TO_DATE_HIDE_MS = 5000;

/**
 * 检查时间：当天只显示时分，跨天补上月日。
 * 软件可能连开好几天，「10:42」却不说是哪天，等于没写。
 */
const formatCheckTime = (at: number, locale: string): string => {
  const date = new Date(at);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${time}`;
};

export const AboutSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => {
  const { t, locale } = useI18n();
  const { showToast } = useToast();
  const { appSettings, setApp, onRequestRootPasswordChange } = ctx;
  const updater = useUpdater();

  /** 软件名与版本（版本由 Tauri 自动获取） */
  const [appName, setAppName] = useState(APP_NAME_FALLBACK);
  const [appVersion, setAppVersion] = useState("");
  /** 「作者」的连续点击时间戳：5 次 / 2 秒内触发隐藏的根密码修改入口 */
  const authorClicksRef = useRef<number[]>([]);
  /**
   * 「已是最新版本」是否可见。
   *
   * 这只是手动检查的一次性反馈，不该长期钉在面板上：显示几秒后自动收起。
   * 只有手动检查才点亮它 —— 后台定时检查也会把 phase 置成 current，
   * 那种情况下每轮都闪一下等于噪音。
   */
  const [showUpToDate, setShowUpToDate] = useState(false);
  const manualCheckedAt = updater.lastCheck?.mode === "manual" ? updater.lastCheck.at : null;
  useEffect(() => {
    if (updater.phase !== "current" || manualCheckedAt == null) {
      setShowUpToDate(false);
      return;
    }
    setShowUpToDate(true);
    const timer = window.setTimeout(() => setShowUpToDate(false), UP_TO_DATE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [updater.phase, manualCheckedAt]);

  /* 打开「关于」时读取应用名与版本号 */
  useEffect(() => {
    let cancelled = false;
    Promise.all([getName(), getVersion()])
      .then(([name, version]) => {
        if (cancelled) return;
        if (name) setAppName(name);
        setAppVersion(version);
      })
      .catch((e) => console.error("读取应用信息失败:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  /** 打开日志目录：路径由后端算（安装目录 log，不可写时在数据目录）。打不开就算了，不打断操作 */
  const openLogDir = async () => {
    try {
      await openAppFolder(await getLogDir());
    } catch {
      /* 目录不存在或没有权限：日志本身不影响使用 */
    }
  };

  /**
   * 导出诊断包：环境信息 + 最近两份日志，**不含数据库与笔记正文**。
   *
   * 这是给普通用户的出口 —— 「打开日志目录然后自己压缩再发给我」等于没有出口。
   */
  const handleExportDiagnostics = async () => {
    try {
      const path = await save({
        defaultPath: `fastnote-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      await exportDiagnostics(path);
      showToast(t("诊断包已导出：{value1}", { value1: path }), "success");
    } catch (e) {
      showToast(t("导出诊断包失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const handleAuthorClick = () => {
    if (!onRequestRootPasswordChange) return;
    const now = Date.now();
    const clicks = authorClicksRef.current.filter((at) => now - at < 2000);
    clicks.push(now);
    authorClicksRef.current = clicks;
    if (clicks.length >= 5) {
      authorClicksRef.current = [];
      onRequestRootPasswordChange();
    }
  };

  return (
    <div className="space-y-3">
      {/* 第一块：软件信息（应用名 / 作者 / 版本 / 更新与诊断） */}
      <div className="rounded-xl border border-line p-4">
        <div className="flex items-center gap-3">
          <img
            src="/icons/app-logo.png"
            alt={t("{appName} 图标", { appName: appName })}
            draggable={false}
            className="rounded-lg object-contain flex-shrink-0 select-none"
            style={{ width: 30, height: 30 }}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{appName}</p>
            <p
              onClick={handleAuthorClick}
              className="mt-0.5 text-[11px] text-faint select-none cursor-default"
            >
              {t("作者：{APP_AUTHOR}", { APP_AUTHOR: APP_AUTHOR })}
            </p>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-line-soft">
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="text-faint">{t("版本")}</span>
            <div className="flex items-center gap-2">
              <span className="text-body font-medium">{appVersion || "—"}</span>
              <button
                type="button"
                onClick={() => void checkForUpdates()}
                disabled={
                  updater.phase === "checking" ||
                  updater.phase === "downloading" ||
                  updater.phase === "ready" ||
                  updater.phase === "installing"
                }
                className="px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updater.phase === "checking" ? t("检查中...") : t("检查更新")}
              </button>
            </div>
          </div>

          {/* 运行期间的自动检查：启动时的静默检查不受此间隔影响 */}
          <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
            <span className="text-faint">{t("自动检查更新")}</span>
            <SelectInput
              compact
              label={t("自动检查更新间隔")}
              value={String(appSettings.general.updateCheckIntervalMinutes)}
              options={UPDATE_CHECK_INTERVAL_OPTIONS}
              onChange={(value) => setApp("general", "updateCheckIntervalMinutes", Number(value))}
            />
          </div>

          {/* 自动检查完全静默，这里留一行痕迹：最近一次是何时、由谁触发 */}
          {updater.lastCheck && (
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
              <span className="text-faint">{t("上次检查")}</span>
              <span className="text-body">
                {formatCheckTime(updater.lastCheck.at, locale)}
                <span className="text-faint">
                  {" · "}
                  {updater.lastCheck.mode === "auto" ? t("自动") : t("手动")}
                </span>
              </span>
            </div>
          )}

          {/* 更新地址：想自己去发布页看版本/下载安装包时用 */}
          <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
            <span className="text-faint">{t("更新地址")}</span>
            <button
              type="button"
              onClick={() => void openExternalLink(APP_RELEASES_URL).catch(() => undefined)}
              title={APP_RELEASES_URL}
              className="text-primary-600 hover:text-primary-700 hover:underline transition-colors"
            >
              {t("打开更新地址")}
            </button>
          </div>

          {/* 日志目录：出问题时把这里的文件发过来，比「你重试一下」有用 */}
          <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
            <span className="text-faint">{t("日志与诊断")}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void openLogDir()}
                className="text-primary-600 hover:text-primary-700 hover:underline transition-colors"
              >
                {t("打开日志目录")}
              </button>
              <button
                type="button"
                onClick={() => void handleExportDiagnostics()}
                className="text-primary-600 hover:text-primary-700 hover:underline transition-colors"
              >
                {t("导出诊断包")}
              </button>
            </div>
          </div>

          {showUpToDate && (
            <p className="mt-2 text-[11px] text-success-strong">{t("已是最新版本")}</p>
          )}

          {updater.phase === "error" && (
            <p className="mt-2 text-[11px] text-danger-strong break-words">
              {t("检查更新失败：{value1}", { value1: updater.error || t("未知") })}
            </p>
          )}

          {updater.phase === "available" && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-[11px] text-primary-600">
                {t("发现新版本 {value1}", { value1: updater.version || "" })}
                {updater.activeLine && (
                  <span className="text-faint">
                    {" "}
                    · {updater.activeLine === "cnb" ? t("CNB（国内）") : "GitHub"}
                    {/* 手选的线路可能当前连不上：仍然会用它下载，但要让人知道状态 */}
                    {updater.lines.find((line) => line.id === updater.activeLine)?.error
                      ? ` · ${t("连不上")}`
                      : ""}
                  </span>
                )}
                {updater.skippedVersion === updater.version && (
                  <span className="text-faint"> · {t("已跳过")}</span>
                )}
              </p>
              <button
                type="button"
                onClick={openUpdateDialog}
                className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
              >
                {t("查看更新说明")}
              </button>
            </div>
          )}

          {updater.phase === "downloading" && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-[11px] text-primary-600">
                {updater.progress == null
                  ? t("正在下载更新...")
                  : t("正在下载更新... {value1}%", { value1: updater.progress })}
                {updater.speed != null && (
                  <span className="text-faint"> · {formatSpeed(updater.speed)}</span>
                )}
              </p>
              <button
                type="button"
                onClick={openUpdateDialog}
                className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
              >
                {t("查看进度")}
              </button>
            </div>
          )}

          {/* 下载完成：安装包已缓存，可随时从弹窗里安装 */}
          {(updater.phase === "ready" || updater.phase === "installing") && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-[11px] text-primary-600">
                {updater.phase === "installing"
                  ? t("正在安装更新...")
                  : t("更新已下载，等待安装")}
              </p>
              <button
                type="button"
                onClick={openUpdateDialog}
                className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 transition-colors"
              >
                {t("查看进度")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 第二块：特别感谢 / 开源项目（引用来源，与软件信息分开看） */}
      <div className="rounded-xl border border-line p-4">
        {/* 特别感谢：标题进 i18n，条目名与链接原样展示（不翻译、不去 https） */}
        <p className="text-[11px] font-medium text-muted">{t("特别感谢")}</p>
        <div className="mt-1.5 space-y-0.5">
          {SPECIAL_THANKS.map((item) => (
            <button
              key={item.name}
              onClick={() => void openExternalLink(item.url).catch(() => undefined)}
              className="w-full flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg text-[11px] text-left hover:bg-app transition-colors group"
            >
              <span className="min-w-0 truncate text-body group-hover:text-primary-600 transition-colors">
                {item.name}
              </span>
              <span className="flex-shrink-0 max-w-[62%] truncate text-faint">{item.url}</span>
            </button>
          ))}
        </div>

        {/* 开源项目：条目较多，用固定高度滚动区承载 */}
        <div className="mt-3 pt-3 border-t border-line-soft">
          <p className="text-[11px] font-medium text-muted">{t("开源项目")}</p>
          <div className="mt-1.5 max-h-[150px] overflow-y-auto chat-scrollbar pr-1 space-y-0.5">
            {OPEN_SOURCE_PROJECTS.map((p) => (
              <button
                key={p.name}
                onClick={() => void openExternalLink(p.url).catch(() => undefined)}
                className="w-full flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg text-[11px] text-left hover:bg-app transition-colors group"
              >
                <span className="min-w-0 truncate text-body group-hover:text-primary-600 transition-colors">
                  {p.name}
                </span>
                <span className="flex-shrink-0 max-w-[62%] truncate text-faint">{p.url}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
