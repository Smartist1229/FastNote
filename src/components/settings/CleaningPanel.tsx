/**
 * 设置 · 清理：可重建的派生数据（语义索引缓存 / 临时残留 / WebView2 缓存）与没人引用的图片。
 *
 * 三块内容的共同点是「删了不丢笔记，但删之前得让人知道代价」，所以清理都走确认框：
 * - 缓存：语义索引清空后要靠索引 worker 重建，重建期间语义搜索没有结果；
 * - 浏览器缓存：WebView2 的 Cache 与 Code Cache，删了按需重建；
 * - 图片：只删「没人引用 + 落盘超过宽限期」的文件，历史版本里的引用也算在用。
 *
 * **打开面板不自动扫描**：浏览器缓存要遍历上万个文件（实测 1.2 GB），自动扫会让
 * 「点开设置」本身变成卡顿点。默认显示「尚未扫描」，用户点扫描才去统计。
 *
 * 这里的确认框由本组件自己的 `useConfirm()` 提供——`confirm()` 只是把 Promise 挂起，
 * **必须把 `confirmDialog` 渲染出来**才会真的弹窗，否则点击后什么都不发生、Promise 永远不结算。
 */
import { useCallback, useState } from "react";
import { useI18n } from "@/i18n";
import {
  cacheUsage,
  clearCache,
  webviewUsage,
  cleanWebviewCache,
  type CacheUsage,
  type WebviewUsage,
} from "@/api/system/cache";
import { attachmentsUsage, gcAttachments, type AttachmentUsage } from "@/api/system/attachments";
import { getSemanticStatus } from "@/api/ai/semantic";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { useToast } from "@/components/common/Toast";
import { formatBytes } from "@/lib/text/format";
import { errorText } from "@/lib/app/errorText";

/** 宽限期与后端默认值一致：太短会删掉「刚撤销、正打算重新插入」的图 */
const GRACE_DAYS = 7;

const PRIMARY_BTN =
  "flex items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40";
const GHOST_BTN =
  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-faint transition-colors hover:bg-surface-alt hover:text-body disabled:cursor-not-allowed disabled:opacity-40";
/** 会掉登录态或不可撤销的动作：描边用 danger，避免和普通清理混成同一档 */
const DANGER_BTN =
  "flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40";

/** 一张卡片：标题 + 右侧操作 + 正文 */
const Card: React.FC<{
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, action, children }) => (
  <div className="overflow-hidden rounded-xl border border-line bg-surface">
    <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2">
      <p className="text-xs font-medium text-body">{title}</p>
      {action}
    </div>
    <div className="px-3.5 py-2.5">{children}</div>
  </div>
);

/** 正文与操作按钮之间隔一行，未扫描时只留说明 */
const Actions: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mt-2.5 flex flex-wrap items-center gap-1">{children}</div>
);

export const CleaningPanel: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();

  // null = 还没扫描过。这里不用 0 兜底：0 B 和「没扫」在界面上是两件事
  const [cache, setCache] = useState<CacheUsage | null>(null);
  const [webview, setWebview] = useState<WebviewUsage | null>(null);
  const [usage, setUsage] = useState<AttachmentUsage | null>(null);

  const [scanning, setScanning] = useState({ cache: false, webview: false, images: false });
  const [busy, setBusy] = useState<"cache" | "webview" | "sites" | "images" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scanningAny = scanning.cache || scanning.webview || scanning.images;
  const busyAny = busy !== null;

  /* ---------------- 扫描 ---------------- */

  const scanCache = useCallback(async () => {
    setScanning((s) => ({ ...s, cache: true }));
    try {
      setCache(await cacheUsage());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setScanning((s) => ({ ...s, cache: false }));
    }
  }, []);

  const scanWebview = useCallback(async () => {
    setScanning((s) => ({ ...s, webview: true }));
    try {
      setWebview(await webviewUsage());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setScanning((s) => ({ ...s, webview: false }));
    }
  }, []);

  const scanImages = useCallback(async () => {
    setScanning((s) => ({ ...s, images: true }));
    try {
      setUsage(await attachmentsUsage());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setScanning((s) => ({ ...s, images: false }));
    }
  }, []);

  const handleScanAll = async () => {
    // 三个互不依赖，并发扫；浏览器那项最慢，但另外两项会先出结果
    await Promise.all([scanCache(), scanWebview(), scanImages()]);
  };

  /* ---------------- 单项清理 ---------------- */

  const handleCleanCache = async () => {
    const ok = await confirm({
      title: t("清理缓存"),
      message: t(
        "会清空语义检索的向量索引（约 {size}）和临时目录里的残留文件。索引可以重建，但重建完成前语义搜索没有结果。",
        { size: formatBytes(cache?.indexBytes ?? 0) },
      ),
      confirmText: t("开始清理"),
      danger: true,
    });
    if (!ok) return;

    setBusy("cache");
    try {
      const report = await clearCache();
      const freed = report.dbFreed + report.tempFreed;
      let message =
        report.indexChunks > 0 || report.tempFiles > 0
          ? t("已清理 {chunks} 个索引分块、{files} 个临时文件，释放 {size}", {
              chunks: report.indexChunks,
              files: report.tempFiles,
              size: formatBytes(freed),
            })
          : t("没有可清理的缓存");

      /*
       * 清空索引后如果「自动建立索引」开着，worker 会把全部笔记重新索引一遍，
       * 占用很快回到原样。不说清楚的话，用户会以为清理没生效。
       */
      if (report.indexChunks > 0) {
        const status = await getSemanticStatus().catch(() => null);
        if (status?.enabled) {
          message += ` · ${t("「自动建立索引」已开启，索引会在后台重建")}`;
        }
      }

      showToast(message, "success");
      await scanCache();
    } catch (e) {
      showToast(t("清理失败：{error}", { error: errorText(e) }), "error");
    } finally {
      setBusy(null);
    }
  };

  /**
   * `sites` 决定要不要连 Cookie / 本地存储一起清。
   *
   * 运行期间 WebView2 正拿着这些文件，删不掉的那部分后端会登记到下次启动。
   * 所以报告里 `pending` 为真时得说清楚「重启才彻底」，否则用户会以为没生效。
   */
  const handleCleanWebview = async (sites: boolean) => {
    const ok = await confirm({
      title: sites ? t("清理缓存与站点数据") : t("清理浏览器缓存"),
      message: sites
        ? t(
            "会清空内置浏览器的 Cookie、本地存储与 IndexedDB，所有登录过的网站都要重新登录。主窗口的主题与语言缓存不受影响。",
          )
        : t(
            "会清空主窗口与内置浏览器的资源缓存与编译缓存。笔记、设置与各网站的登录状态都不受影响，只是清完后第一次启动会稍慢一点。",
          ),
      confirmText: t("开始清理"),
      danger: true,
    });
    if (!ok) return;

    setBusy(sites ? "sites" : "webview");
    try {
      const report = await cleanWebviewCache(sites);
      let message =
        sites && report.siteFreed > 0
          ? t("已释放 {size}，其中站点数据 {size2}", {
              size: formatBytes(report.freed),
              size2: formatBytes(report.siteFreed),
            })
          : t("已释放 {size}", { size: formatBytes(report.freed) });

      if (report.pending) {
        message += ` · ${t("部分文件正被使用，已登记在下次启动时继续清理")}`;
      }

      showToast(message, "success");
      await scanWebview();
    } catch (e) {
      showToast(t("清理失败：{error}", { error: errorText(e) }), "error");
    } finally {
      setBusy(null);
    }
  };

  const handleCleanImages = async () => {
    const ok = await confirm({
      title: t("清理未使用的图片"),
      message: t(
        "只删除「没有被任何笔记或历史版本引用」且「落盘超过 {days} 天」的图片。此操作不可撤销。",
        { days: GRACE_DAYS },
      ),
      confirmText: t("开始清理"),
      danger: true,
    });
    if (!ok) return;

    setBusy("images");
    try {
      const report = await gcAttachments(GRACE_DAYS);
      showToast(
        report.removed > 0
          ? t("已清理 {count} 个文件，释放 {size}", {
              count: report.removed,
              size: formatBytes(report.freed),
            })
          : t("没有可清理的图片"),
        "success",
      );
      await scanImages();
    } catch (e) {
      showToast(t("清理失败：{error}", { error: errorText(e) }), "error");
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- 全部清理 ---------------- */

  /**
   * 三项依次执行，不并发：`clear_cache` 与 `gc_attachments` 都要拿数据库锁，
   * 同时发只会互相等，顺序调用反而更快，进度也可预期。
   *
   * 这里**不包含站点数据**：那是会掉登录态的操作，必须由用户单独确认。
   */
  const handleCleanAll = async () => {
    const ok = await confirm({
      title: t("清理全部"),
      message: t(
        "会依次清空语义索引与临时残留、清除 WebView2 缓存、删除落盘超过 {days} 天且没人引用的图片。前两项都可以重建，图片删除后无法恢复。站点数据与各网站登录状态不受影响。",
        { days: GRACE_DAYS },
      ),
      confirmText: t("开始清理"),
      danger: true,
    });
    if (!ok) return;

    setBusy("all");
    try {
      const cacheReport = await clearCache();
      const webviewReport = await cleanWebviewCache(false);
      const imageReport = await gcAttachments(GRACE_DAYS);

      const cacheFreed = cacheReport.dbFreed + cacheReport.tempFreed;
      const total = cacheFreed + webviewReport.freed + imageReport.freed;

      let message = t("共释放 {size}：缓存 {size2} · 浏览器 {size3} · 图片 {size4}", {
        size: formatBytes(total),
        size2: formatBytes(cacheFreed),
        size3: formatBytes(webviewReport.freed),
        size4: formatBytes(imageReport.freed),
      });
      if (webviewReport.pending) {
        message += ` · ${t("部分浏览器缓存文件正被使用，已登记在下次启动时继续清理")}`;
      }

      showToast(message, "success");
      await Promise.all([scanCache(), scanWebview(), scanImages()]);
    } catch (e) {
      showToast(t("清理失败：{error}", { error: errorText(e) }), "error");
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- 渲染 ---------------- */

  /** 卡片右上角：未扫是「扫描」，扫过是「重新扫描」，扫描中显示状态 */
  const scanButton = (
    key: "cache" | "webview" | "images",
    scanned: boolean,
    run: () => Promise<void>,
  ) => (
    <button
      type="button"
      className={GHOST_BTN}
      onClick={() => void run()}
      disabled={scanningAny || busyAny}
    >
      {scanning[key] ? t("扫描中…") : scanned ? t("重新扫描") : t("扫描")}
    </button>
  );

  /** 未扫描时卡片正文统一走这里，避免三处各写一遍 */
  const notScanned = (
    <p className="text-[10.5px] leading-relaxed text-faint">
      {t("尚未扫描，点右上角的「扫描」统计占用。")}
    </p>
  );

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-danger/30 bg-danger-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
          {t("读取失败：{error}", { error })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={PRIMARY_BTN}
          onClick={() => void handleScanAll()}
          disabled={scanningAny || busyAny}
        >
          {scanningAny ? t("扫描中…") : t("扫描全部")}
        </button>
        <button
          type="button"
          className={DANGER_BTN}
          onClick={() => void handleCleanAll()}
          disabled={scanningAny || busyAny}
        >
          {busy === "all" ? t("清理中…") : t("清理全部")}
        </button>
      </div>

      <Card title={t("缓存")} action={scanButton("cache", cache !== null, scanCache)}>
        {scanning.cache ? (
          <p className="text-[11px] text-faint">{t("统计中…")}</p>
        ) : cache === null ? (
          notScanned
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[19px] font-medium tabular-nums text-body">
                {formatBytes(cache.indexBytes + cache.tempBytes)}
              </span>
              <span className="text-[11px] text-faint">{t("可清理")}</span>
              <span className="ml-auto text-[11px] tabular-nums text-faint">
                {t("{count} 个索引分块", { count: cache.indexChunks })}
              </span>
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              {t("索引 {size} · 临时残留 {size2}（{count} 项）", {
                size: formatBytes(cache.indexBytes),
                size2: formatBytes(cache.tempBytes),
                count: cache.tempFiles,
              })}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              {t(
                "语义索引是笔记的向量副本，可以随时重建；临时残留是恢复备份前留下的整库快照，正常退出会自己删掉，崩溃才会剩下。",
              )}
            </p>
          </>
        )}

        <Actions>
          <button
            type="button"
            className={PRIMARY_BTN}
            onClick={() => void handleCleanCache()}
            disabled={cache === null || scanningAny || busyAny}
          >
            {busy === "cache" ? t("清理中…") : t("清理缓存")}
          </button>
        </Actions>
      </Card>

      <Card title={t("浏览器缓存")} action={scanButton("webview", webview !== null, scanWebview)}>
        {scanning.webview ? (
          <p className="text-[11px] text-faint">{t("统计中…")}</p>
        ) : webview === null ? (
          notScanned
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[19px] font-medium tabular-nums text-body">
                {formatBytes(webview.appBytes + webview.browserBytes)}
              </span>
              <span className="text-[11px] text-faint">{t("可清理")}</span>
              <span className="ml-auto text-[11px] tabular-nums text-faint">
                {t("站点数据 {size}", { size: formatBytes(webview.siteBytes) })}
              </span>
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              {t("界面 {size} · 内置浏览器 {size2}", {
                size: formatBytes(webview.appBytes),
                size2: formatBytes(webview.browserBytes),
              })}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              {t(
                "每个网页视图都会把资源和编译结果缓存到磁盘，删了会按需重建。软件运行期间这些文件被内核占着，部分要等下次启动才删得掉。",
              )}
            </p>
            {webview.pending && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-warning">
                {t("上次清理还有残留，下次启动会继续。")}
              </p>
            )}
          </>
        )}

        <Actions>
          <button
            type="button"
            className={PRIMARY_BTN}
            onClick={() => void handleCleanWebview(false)}
            disabled={webview === null || scanningAny || busyAny}
          >
            {busy === "webview" ? t("清理中…") : t("清理缓存")}
          </button>
          <button
            type="button"
            className={DANGER_BTN}
            onClick={() => void handleCleanWebview(true)}
            disabled={webview === null || scanningAny || busyAny}
          >
            {busy === "sites" ? t("清理中…") : t("清理缓存与站点数据")}
          </button>
        </Actions>
      </Card>

      <Card title={t("图片")} action={scanButton("images", usage !== null, scanImages)}>
        {scanning.images ? (
          <p className="text-[11px] text-faint">{t("统计中…")}</p>
        ) : usage === null ? (
          notScanned
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[19px] font-medium tabular-nums text-body">
                {formatBytes(usage.bytes)}
              </span>
              <span className="text-[11px] text-faint">{t("正文引用的图片")}</span>
              <span className="ml-auto text-[11px] tabular-nums text-faint">
                {t("{count} 张", { count: usage.count })}
              </span>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
              {t(
                "图片按内容去重后存在本地；删笔记或改正文都不会自动删掉文件，所以需要在这里清一次。",
              )}
            </p>
          </>
        )}

        <Actions>
          <button
            type="button"
            className={PRIMARY_BTN}
            onClick={() => void handleCleanImages()}
            disabled={usage === null || scanningAny || busyAny}
          >
            {busy === "images" ? t("清理中…") : t("清理未使用的图片")}
          </button>
        </Actions>
      </Card>

      <p className="px-1 text-[10.5px] leading-relaxed text-faint-soft">
        {t("清理只删可以重建或没人引用的数据，笔记本身不会被删除。")}
      </p>

      {confirmDialog}
    </div>
  );
};
