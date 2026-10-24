/**
 * 设置 · 语义搜索：本地模型选择、下载进度与向量索引状态。
 *
 * 取舍：
 * - 模型文件由后端下载到数据目录（优先安装目录下的 data），前端只显示状态与进度，不碰文件系统；
 * - 同一时间只允许一个下载任务；进度条只在传输/校验期间出现，结束即收起；
 * - 进度靠 Tauri 事件推送，弹窗卸载时统一 unlisten（切走分区即卸载）；
 * - 模型没下载时只提示，不在开启开关时自动下载，避免被动消耗流量与磁盘；
 * - 切换模型后旧向量不会被读取（后端按模型过滤）；开启自动索引时后台会重建；
 * - 删除模型会连同全部向量一起清空，所以走二次确认。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as semanticApi from "@/api/semantic";
import { openAppFolder } from "@/api/system";
import { Icon } from "@/components/common/Icon";
import { ProgressBar } from "@/components/common/ProgressBar";
import { useToast } from "@/components/common/Toast";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { CustomModelImportForm } from "@/components/settings/CustomModelImportForm";
import { useActionGuard } from "@/hooks/useActionGuard";
import { formatBytes, formatSpeed } from "@/lib/format";
import type {
  SemanticIndexProgress,
  SemanticModelInfo,
  SemanticModelProgress,
  SemanticStatus,
} from "@/interface/semantic";

const percent = (done: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;

const StatRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-3 px-3.5 py-2.5">
    <span className="w-20 flex-shrink-0 pt-[1px] text-[11px] text-faint">{label}</span>
    <div className="min-w-0 flex-1 text-xs text-body">{children}</div>
  </div>
);

const Badge: React.FC<{
  tone: "primary" | "success" | "warning" | "neutral";
  children: React.ReactNode;
}> = ({ tone, children }) => {
  const style =
    tone === "primary"
      ? "border-primary-200 bg-primary-50 text-primary-600"
      : tone === "success"
        ? "border-success-line/60 bg-success-soft text-success"
        : tone === "warning"
          ? "border-warning-line/60 bg-warning-soft text-warning"
          : "border-line bg-app text-faint";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-[1px] text-[10px] font-medium ${style}`}
    >
      {children}
    </span>
  );
};

const ToggleRow: React.FC<{
  title: string;
  desc: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}> = ({ title, desc, checked, onChange }) => (
  <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3.5 py-3">
    <div className="min-w-0">
      <p className="text-xs font-medium text-body">{title}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{desc}</p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors relative ${
        checked ? "bg-primary-500" : "bg-surface-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-surface shadow transition-all ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  </div>
);

interface SemanticPanelProps {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  /** 模型下载完成/笔记改动后是否自动建索引（general.semanticAutoIndex） */
  autoIndex: boolean;
  onAutoIndexChange: (value: boolean) => void;
  /** 当前选中的模型 id（持久化在 general.semanticModel） */
  modelId: string;
  onModelChange: (modelId: string) => void;
}

export const SemanticPanel: React.FC<SemanticPanelProps> = ({
  enabled,
  onEnabledChange,
  autoIndex,
  onAutoIndexChange,
  modelId,
  onModelChange,
}) => {
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const guard = useActionGuard();

  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [modelProgress, setModelProgress] = useState<SemanticModelProgress | null>(null);
  const [indexProgress, setIndexProgress] = useState<SemanticIndexProgress | null>(null);
  /** 平滑后的下载速度（字节/秒） */
  const [speed, setSpeed] = useState(0);
  /** 正在执行的面板操作：期间禁用全部按钮，避免连点 */
  const [pending, setPending] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const aliveRef = useRef(true);
  const statusRef = useRef<SemanticStatus | null>(null);
  const enabledRef = useRef(enabled);
  const autoIndexRef = useRef(autoIndex);
  const speedSampleRef = useRef<{ time: number; bytes: number; speed: number } | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    autoIndexRef.current = autoIndex;
  }, [autoIndex]);

  const applyStatus = useCallback((next: SemanticStatus | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** 同步一次状态；卸载后不再 setState */
  const refresh = useCallback(async () => {
    try {
      const next = await semanticApi.getSemanticStatus();
      if (aliveRef.current) applyStatus(next);
    } catch (e) {
      console.error("读取语义搜索状态失败:", e);
    }
  }, [applyStatus]);

  /** 本地先改下载标记，避免「已结束」到状态回查之间的闪动 */
  const patchDownloading = useCallback(
    (downloading: boolean, id: string | null) => {
      setStatus((prev) => {
        const next = prev ? { ...prev, downloading, downloading_model: id } : prev;
        statusRef.current = next;
        return next;
      });
    },
    [],
  );

  /* 状态查询 + 事件订阅：只在面板挂载期间有效 */
  useEffect(() => {
    aliveRef.current = true;
    void refresh();

    const unlisteners: Array<() => void> = [];
    let disposed = false;
    void (async () => {
      const offModel = await semanticApi.onSemanticModelProgress((progress) => {
        if (!aliveRef.current) return;

        if (progress.stage === "download") {
          const now = performance.now();
          const prev = speedSampleRef.current;
          let nextSpeed = 0;
          if (prev && progress.downloaded >= prev.bytes && now > prev.time) {
            const instant = ((progress.downloaded - prev.bytes) * 1000) / (now - prev.time);
            nextSpeed = prev.speed > 0 ? prev.speed * 0.7 + instant * 0.3 : instant;
          }
          speedSampleRef.current = { time: now, bytes: progress.downloaded, speed: nextSpeed };
          setSpeed(nextSpeed);
          setModelProgress(progress);
          return;
        }

        if (progress.stage === "verify") {
          speedSampleRef.current = null;
          setSpeed(0);
          setModelProgress(progress);
          return;
        }

        // done / error：进度条立即收起，再回查真实状态
        const name =
          statusRef.current?.models.find((model) => model.id === progress.model_id)?.name ??
          progress.model_id;
        setModelProgress(null);
        speedSampleRef.current = null;
        setSpeed(0);
        setPending(null);
        patchDownloading(false, null);
        if (progress.stage === "done") {
          const isCurrentModel = statusRef.current?.selected_model === progress.model_id;
          const willIndex = enabledRef.current && autoIndexRef.current && isCurrentModel;
          const manualHint =
            enabledRef.current && !autoIndexRef.current && isCurrentModel
              ? "；自动索引已关闭，可手动重建索引"
              : "";
          showToast(
            `模型「${name}」下载完成${willIndex ? "，正在建立索引" : manualHint}`,
            "success",
          );
        } else {
          showToast(`模型「${name}」下载失败：${progress.error ?? "未知错误"}`, "error");
        }
        void refresh();
      });

      const offIndex = await semanticApi.onSemanticIndexProgress((progress) => {
        if (!aliveRef.current) return;
        setIndexProgress(progress);
        if (!progress.running) void refresh();
      });
      const offDone = await semanticApi.onSemanticIndexDone(() => {
        if (!aliveRef.current) return;
        setIndexProgress(null);
        void refresh();
      });

      if (disposed) {
        offModel();
        offIndex();
        offDone();
      } else {
        unlisteners.push(offModel, offIndex, offDone);
      }
    })();

    return () => {
      disposed = true;
      aliveRef.current = false;
      unlisteners.forEach((off) => off());
    };
  }, [refresh, patchDownloading, showToast]);

  // 切换所选模型后重新取一次：设置落库是异步的，稍等一拍再读，避免读到旧值
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 120);
    return () => window.clearTimeout(timer);
  }, [modelId, refresh]);

  // 设置里指向的模型已不存在（删了自定义模型、或用户手工清理了目录）：跟随后端回退值
  useEffect(() => {
    if (!status || !modelId) return;
    if (status.models.some((model) => model.id === modelId)) return;
    if (status.selected_model && status.selected_model !== modelId) {
      onModelChange(status.selected_model);
    }
  }, [status, modelId, onModelChange]);

  const selectedInfo = status?.models.find((model) => model.id === modelId);
  const selectedInstalled =
    Boolean(selectedInfo?.installed) ||
    (status?.selected_model === modelId && Boolean(status?.model_ready));

  const downloadingModelId =
    modelProgress && (modelProgress.stage === "download" || modelProgress.stage === "verify")
      ? modelProgress.model_id
      : status?.downloading_model ?? null;
  const downloading = downloadingModelId !== null;
  const downloadingInfo = status?.models.find((model) => model.id === downloadingModelId);
  const downloadingName = downloadingInfo?.name ?? downloadingModelId ?? "模型";
  const verifying = modelProgress?.stage === "verify";

  /**
   * 还没收到第一个进度事件时（刚点下载 / 从别处切回面板），先用清单体积把进度条
   * 定在 0%，否则会显示「不定态」动画并配上「连接中」，看着像假进度。
   */
  const shownProgress =
    modelProgress ??
    (downloading && downloadingInfo
      ? {
          model_id: downloadingInfo.id,
          stage: "download" as const,
          downloaded: 0,
          total: downloadingInfo.approx_size,
          segments: 0,
          error: null,
        }
      : null);

  const downloadPercent =
    shownProgress && shownProgress.total > 0
      ? percent(shownProgress.downloaded, shownProgress.total)
      : null;
  const segmentLabel =
    modelProgress && modelProgress.segments > 1
      ? `${modelProgress.segments} 段并发`
      : modelProgress?.segments === 1
        ? "单线程"
        : "";
  const downloadDetail = verifying
    ? "文件已下载，正在自检"
    : shownProgress && shownProgress.total > 0
      ? `${formatBytes(shownProgress.downloaded)} / ${formatBytes(shownProgress.total)}${
          speed > 0 ? ` · ${formatSpeed(speed)}` : ""
        }${segmentLabel ? ` · ${segmentLabel}` : ""}`
      : speed > 0
        ? formatSpeed(speed)
        : "准备下载…";

  const indexing = indexProgress ? indexProgress.running : Boolean(status?.indexing);
  const indexDone = indexProgress?.done ?? 0;
  const indexTotal = indexProgress?.total ?? 0;
  const notIndexed =
    status && status.total_notes > status.indexed_notes
      ? status.total_notes - status.indexed_notes
      : 0;

  const handleSelect = (info: SemanticModelInfo) => {
    if (info.id === modelId) return;
    onModelChange(info.id);
    speedSampleRef.current = null;
    setSpeed(0);
    setModelProgress(null);
  };

  const handleDownload = async () => {
    if (!selectedInfo) return;
    setPending("download");
    // 立刻用清单体积画出 0%，避免第一个网络事件到来前显示「不定态」
    setModelProgress({
      model_id: selectedInfo.id,
      stage: "download",
      downloaded: 0,
      total: selectedInfo.approx_size,
      segments: 0,
      error: null,
    });
    speedSampleRef.current = null;
    setSpeed(0);
    patchDownloading(true, selectedInfo.id);
    try {
      await semanticApi.downloadSemanticModel(selectedInfo.id);
      await refresh();
    } catch (e) {
      patchDownloading(false, null);
      showToast(`开始下载失败：${errorText(e)}`, "error");
      void refresh();
    } finally {
      setPending(null);
    }
  };

  const handleDelete = async (info: SemanticModelInfo) => {
    const current = info.id === modelId;
    const size = info.installed_size ? `（${formatBytes(info.installed_size)}）` : "";
    const ok = await confirm({
      title: `删除模型「${info.name}」`,
      message: `将删除本机的「${info.name}」模型${size}${
        current ? "，并清空全部笔记向量" : ""
      }。笔记本身不受影响；${
        info.custom ? "需要时可重新从本地导入。" : "之后可以重新下载。"
      }`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;

    setPending(`delete:${info.id}`);
    try {
      await semanticApi.deleteSemanticModel(info.id);
      if (current) setIndexProgress(null);
      const next = await semanticApi.getSemanticStatus();
      if (aliveRef.current) applyStatus(next);
      // 删除的是当前模型时，后端会回退到推荐项；把设置里的悬空 id 一并改掉
      if (current && next.selected_model !== info.id) onModelChange(next.selected_model);
      showToast(`模型「${info.name}」已删除`, "success");
    } catch (e) {
      showToast(`删除失败：${errorText(e)}`, "error");
    } finally {
      setPending(null);
    }
  };

  const handleRebuild = async () => {
    setPending("rebuild");
    try {
      await semanticApi.rebuildSemanticIndex();
      setIndexProgress(null);
      await refresh();
      showToast("已清空索引，后台将在几秒内开始重建", "success");
    } catch (e) {
      showToast(`重建失败：${errorText(e)}`, "error");
    } finally {
      setPending(null);
    }
  };

  const handleCancel = async () => {
    setPending("cancel");
    try {
      await semanticApi.cancelSemanticIndex();
      showToast("已请求取消索引，当前批次结束后停止", "info");
    } catch (e) {
      showToast(`取消失败：${errorText(e)}`, "error");
    } finally {
      setPending(null);
    }
  };

  const copyPath = async () => {
    const path = selectedInfo?.dir || status?.model_dir;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      showToast("模型目录已复制", "success");
    } catch {
      showToast("复制失败，请手动选中路径复制", "error");
    }
  };

  /** 目录只在模型下载完成后才会存在，未下载时按钮直接禁用 */
  const openDir = async () => {
    const path = selectedInfo?.dir || status?.model_dir;
    if (!path) return;
    try {
      await openAppFolder(path);
    } catch (e) {
      showToast(`打开模型目录失败：${errorText(e)}`, "error");
    }
  };

  const copyError = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("错误信息已复制", "success");
    } catch {
      showToast("复制失败，请手动选中文字复制", "error");
    }
  };

  const statusLabel = !enabled ? "未启用" : selectedInstalled ? "已启用" : "已启用 · 缺少模型";
  const statusTone: "neutral" | "success" | "warning" = !enabled
    ? "neutral"
    : selectedInstalled
      ? "success"
      : "warning";

  return (
    <div className="space-y-3">
      {/* 语义搜索的总开关只放在本分区，避免「通用」里出现重复项 */}
      <ToggleRow
        title="启用语义搜索"
        desc="开启后，侧边栏搜索会额外给出「语义相关」结果。模型与索引都在本机运行，不联网。"
        checked={enabled}
        onChange={onEnabledChange}
      />
      <ToggleRow
        title="自动建立索引"
        desc="模型下载完成后自动建立索引，之后笔记改动也会自动增量更新。关闭后只在手动点「重建索引」时建立。"
        checked={autoIndex}
        onChange={onAutoIndexChange}
      />

      {/* 测试功能提示：语义检索依赖模型质量，版本迭代中还可能有行为变化 */}
      <div className="flex items-start gap-2 rounded-xl border border-warning-line/60 bg-warning-soft px-3 py-2.5">
        <Icon name="ai-warning" className="w-3.5 h-3.5 text-warning mt-[1px] flex-shrink-0" />
        <p className="text-[11px] leading-relaxed text-warning">
          <span className="font-medium">测试功能：</span>
          语义搜索依赖所选模型与本地向量索引，不同模型的语言支持和区分能力不同，结果未必精准；功能与性能仍在调整，建议保留普通文本搜索作为主要查找方式。
        </p>
      </div>
      {enabled && !selectedInstalled && !downloading && (
        <div className="flex items-start gap-2 rounded-xl border border-warning-line/60 bg-warning-soft px-3 py-2.5">
          <Icon name="ai-warning" className="w-3.5 h-3.5 text-warning mt-[1px] flex-shrink-0" />
          <p className="text-[11px] leading-relaxed text-warning">
            {selectedInfo?.custom
              ? "所选自定义模型的文件缺失或已被修改，暂时不会返回语义结果；原有文本搜索不受影响。请重新导入或删除后换用其他模型。"
              : "所选模型还没下载，暂时不会返回语义结果；原有文本搜索不受影响。"}
          </p>
        </div>
      )}

      {enabled && selectedInstalled && !autoIndex && !indexing && notIndexed > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-line bg-app px-3 py-2.5">
          <Icon name="toast-info" className="w-3.5 h-3.5 text-faint mt-[1px] flex-shrink-0" />
          <p className="text-[11px] leading-relaxed text-faint">
            自动索引已关闭，还有 {notIndexed} 篇笔记没有建立索引。需要时点下方「重建索引」。
          </p>
        </div>
      )}

      {/* 模型选择：推荐项默认选中，安装状态与体积一目了然 */}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-start justify-between gap-2 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">本地模型</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
              选择要下载和使用的模型。开启「自动建立索引」时，切换后后台会按新模型重建全部向量；关闭时需手动重建。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            disabled={importOpen || downloading || pending !== null}
            title="从本地目录导入自定义模型"
            className="mt-0.5 flex flex-shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-body transition-colors hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="sidebar-folder-plus" className="w-3 h-3" />
            导入模型
          </button>
        </div>

        <div
          role="radiogroup"
          aria-label="语义模型"
          className="divide-y divide-line-soft border-t border-line-soft"
        >
          {status ? (
            status.models.map((info) => {
              const selected = info.id === modelId;
              const isDownloading = downloadingModelId === info.id;
              return (
                <div
                  key={info.id}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={0}
                  onClick={() => handleSelect(info)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSelect(info);
                    }
                  }}
                  className={`flex cursor-pointer items-start gap-2.5 px-3.5 py-3 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary-300 ${
                    selected ? "bg-primary-50" : "hover:bg-surface-alt"
                  }`}
                >
                  <span
                    className={`mt-[3px] flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border ${
                      selected ? "border-primary-500" : "border-line-strong"
                    }`}
                  >
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary-500" />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-body">{info.name}</span>
                      {info.recommended && <Badge tone="primary">推荐</Badge>}
                      {info.custom && <Badge tone="neutral">自定义</Badge>}
                      {info.custom && !info.installed && <Badge tone="warning">文件缺失</Badge>}
                      {info.installed && <Badge tone="success">已安装</Badge>}
                      {isDownloading && <Badge tone="primary">下载中</Badge>}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
                      {info.description}
                    </p>
                    <p className="mt-1 text-[10px] text-faint-soft">
                      {info.tag} · {info.dim} 维 · {info.custom ? "本地导入" : `约 ${formatBytes(info.approx_size)}`}
                      {info.installed_size > 0 && ` · 已占用 ${formatBytes(info.installed_size)}`}
                    </p>
                  </div>

                  {(info.installed || info.custom) && !selected && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void guard(() => handleDelete(info));
                      }}
                      disabled={pending !== null || downloading}
                      title={`删除「${info.name}」`}
                      className="mt-[1px] flex flex-shrink-0 items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Icon name="ai-trash" className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })
          ) : (
            <p className="px-3.5 py-3 text-[11px] text-faint">正在读取模型清单…</p>
          )}
        </div>
      </div>

      {/* 导入表单贴在模型列表下方，不另开弹窗：设置本身已是弹窗，叠层会把界面压暗 */}
      {importOpen && (
        <CustomModelImportForm
          onCancel={() => setImportOpen(false)}
          onImported={(id, name) => {
            void (async () => {
              setImportOpen(false);
              try {
                const next = await semanticApi.getSemanticStatus();
                if (aliveRef.current) applyStatus(next);
              } catch (e) {
                console.error("读取语义搜索状态失败:", e);
              }
              onModelChange(id);
              const hint = !enabledRef.current
                ? "，可在需要时启用语义搜索"
                : autoIndexRef.current
                  ? "，后台会开始建立索引"
                  : "；自动索引已关闭，可手动重建索引";
              showToast(`模型「${name}」导入成功${hint}`, "success");
            })();
          }}
        />
      )}

      {/* 下载/校验进度：只在任务进行中出现，结束（成功或失败）立即收起 */}
      {downloading && (
        <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
          <ProgressBar
            value={downloadPercent}
            label={
              verifying ? `正在校验「${downloadingName}」…` : `正在下载「${downloadingName}」`
            }
            detail={downloadDetail}
          />
          <p className="mt-2 text-[10px] leading-relaxed text-faint">
            {autoIndex
              ? "下载完成后会自动校验并建立索引；期间可以继续使用其他功能。"
              : "下载完成后会自动校验；自动索引已关闭，之后需手动点「重建索引」。"}
          </p>
        </div>
      )}

      <div className="divide-y divide-line-soft rounded-xl border border-line">
        <StatRow label="状态">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone}>{statusLabel}</Badge>
            {selectedInfo && <span className="text-[11px] text-faint">{selectedInfo.name}</span>}
          </div>
        </StatRow>

        <StatRow label="索引">
          {indexing ? (
            <div>
              <span className="text-primary-600">
                索引中{indexTotal > 0 ? ` ${indexDone}/${indexTotal}` : "…"}
              </span>
              <ProgressBar
                className="mt-1.5"
                value={indexTotal > 0 ? percent(indexDone, indexTotal) : null}
                showPercent={false}
                label={undefined}
                detail={undefined}
              />
            </div>
          ) : (
            <span>
              {status ? `${status.indexed_notes} / ${status.total_notes} 篇` : "—"}
              {status && status.total_chunks > 0 ? ` · ${status.total_chunks} 个块` : ""}
              {notIndexed > 0 && !indexing && (
                <span className="ml-1 text-faint">（{notIndexed} 篇待索引）</span>
              )}
            </span>
          )}
        </StatRow>

        <StatRow label="向量维度">
          <span className="text-faint">
            {selectedInfo?.dim ?? status?.dim ?? "—"} 维 · 余弦相似度
          </span>
        </StatRow>

        <StatRow label="模型目录">
          <p className="break-all font-mono text-[10px] leading-relaxed text-faint">
            {selectedInfo?.dir || status?.model_dir || "—"}
          </p>
          {/* 面板可能很窄，按钮另起一行，避免「打开目录」被裁掉 */}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => void guard(copyPath)}
              disabled={!(selectedInfo?.dir || status?.model_dir)}
              className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint hover:bg-surface-alt hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
              title="复制模型目录"
            >
              <Icon name="ai-copy" className="w-3 h-3" />
              复制
            </button>
            <button
              type="button"
              onClick={() => void guard(openDir)}
              disabled={!selectedInstalled || !(selectedInfo?.dir || status?.model_dir)}
              title={
                selectedInstalled
                  ? "在文件管理器中打开模型目录"
                  : "模型下载完成后才有目录"
              }
              className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint hover:bg-surface-alt hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sidebar-folder-thin" className="w-3 h-3" />
              打开目录
            </button>
          </div>
        </StatRow>
      </div>

      {indexProgress?.error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger-line/60 bg-danger-soft px-3 py-2.5">
          <Icon name="ai-alert-triangle" className="w-3.5 h-3.5 text-danger mt-[1px] flex-shrink-0" />
          <p className="selectable min-w-0 flex-1 break-all text-[11px] leading-relaxed text-danger">
            索引失败：{indexProgress.error}
          </p>
          <button
            type="button"
            onClick={() => void copyError(`索引失败：${indexProgress.error}`)}
            className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-danger transition-colors hover:bg-surface-alt"
            title="复制错误信息"
          >
            <Icon name="ai-copy" className="w-3 h-3" />
            复制
          </button>
        </div>
      )}

      {status?.last_error && !indexing && !downloading && (
        <div className="flex items-start gap-2 rounded-xl border border-warning-line/60 bg-warning-soft px-3 py-2.5">
          <Icon name="ai-warning" className="w-3.5 h-3.5 text-warning mt-[1px] flex-shrink-0" />
          <p className="selectable min-w-0 flex-1 break-all text-[11px] leading-relaxed text-warning">
            最近一次失败：{status.last_error}
          </p>
          <button
            type="button"
            onClick={() => void copyError(`最近一次失败：${status.last_error}`)}
            className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-warning transition-colors hover:bg-surface-alt"
            title="复制错误信息"
          >
            <Icon name="ai-copy" className="w-3 h-3" />
            复制
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {selectedInfo?.custom && !selectedInstalled ? (
          <>
            <span className="text-[11px] text-warning">
              模型文件缺失或已被修改，请重新导入，或删除这条模型记录。
            </span>
            <button
              type="button"
              onClick={() => void guard(() => handleDelete(selectedInfo))}
              disabled={pending !== null || downloading || indexing}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="ai-trash" className="w-3.5 h-3.5" />
              删除模型
            </button>
          </>
        ) : !selectedInstalled ? (
          <button
            type="button"
            onClick={() => void guard(handleDownload)}
            disabled={pending !== null || downloading || !selectedInfo}
            className="flex items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="editor-export" className="w-3.5 h-3.5" />
            {downloading
              ? "正在下载…"
              : `下载「${selectedInfo?.name ?? "模型"}」${
                  selectedInfo ? `（${formatBytes(selectedInfo.approx_size)}）` : ""
                }`}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void guard(handleRebuild)}
              disabled={pending !== null || downloading || indexing}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sidebar-refresh" className="w-3.5 h-3.5" />
              重建索引
            </button>
            {indexing && (
              <button
                type="button"
                onClick={() => void guard(handleCancel)}
                disabled={pending !== null}
                className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="ai-stop" className="w-3.5 h-3.5" />
                取消索引
              </button>
            )}
            <button
              type="button"
              onClick={() => selectedInfo && void guard(() => handleDelete(selectedInfo))}
              disabled={pending !== null || downloading || indexing}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="ai-trash" className="w-3.5 h-3.5" />
              删除模型
            </button>
          </>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        开启「自动建立索引」时，后台会为已有笔记建立向量索引，之后新增或修改的笔记会自动增量更新；关闭后只在手动点「重建索引」时建立。删除模型或重建索引不会影响笔记内容。下载线程与工具箱共用，可在「设置 → 工具箱」调整。
      </p>

      {confirmDialog}
    </div>
  );
};

/** 统一把 invoke 抛出的错误转成可读文本 */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
