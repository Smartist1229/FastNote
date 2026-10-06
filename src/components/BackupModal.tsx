import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { exportBackup, importBackup, BackupSummary } from "../api";

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 备份文件名里的时间戳：20261006-1930 */
const fileStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** ISO 时间去秒，展示成 2026-10-06 19:30 */
const prettyTime = (iso: string | null) => {
  if (!iso) return "未知";
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
};

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/**
 * 数据备份与恢复。
 * 备份文件为单个 JSON，包含笔记、分组、回收站、AI 对话记录与设置/记忆，
 * 但**不含 AI 服务商的 api_key**（换机后需重新填写）。
 */
export const BackupModal: React.FC<BackupModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  /** 最近一次导出结果，用于在界面上回显内容统计 */
  const [lastExport, setLastExport] = useState<{ summary: BackupSummary; path: string } | null>(null);

  const handleExport = async () => {
    try {
      const path = await save({
        defaultPath: `fastnote-backup-${fileStamp()}.json`,
        filters: [{ name: "FastNote 备份", extensions: ["json"] }],
      });
      if (!path) return;
      setBusy("export");
      const summary = await exportBackup(path);
      setLastExport({ summary, path });
      showToast(`已导出 ${summary.notes} 篇笔记`, "success");
    } catch (e) {
      showToast(`导出失败：${errorText(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "FastNote 备份", extensions: ["json"] }],
      });
      if (!selected || typeof selected !== "string") return;

      const ok = await confirm({
        title: "从备份恢复",
        message: `恢复会用备份文件覆盖当前的**全部**笔记、分组、回收站、AI 对话记录与设置。当前数据将被清空，无法撤销，建议先导出一份备份。\n\n备份文件：${baseName(selected)}`,
        confirmText: "覆盖并恢复",
        danger: true,
      });
      if (!ok) return;

      setBusy("import");
      const summary = await importBackup(selected);
      showToast(`恢复完成：${summary.notes} 篇笔记，界面即将刷新`, "success");
      // 数据整库换过，直接重启界面最稳妥（编辑器、侧边栏、AI 面板都会重新读库）
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setBusy(null);
      showToast(`恢复失败：${errorText(e)}`, "error");
    }
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="数据备份与恢复">
      <div className="space-y-4">
        <p className="text-xs text-slate-500 leading-relaxed">
          备份内容包含笔记、分组、回收站、AI 对话记录，以及 AI 设置与记忆；
          出于安全考虑<b>不包含 AI 服务商的 API Key</b>，换机后需要重新填写。
        </p>

        {/* 导出 */}
        <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
          <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
            <Icon name="app-backup" className="w-4 h-4 text-primary-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-700">导出备份</p>
            <p className="text-[11px] text-slate-400 mt-0.5">保存为一个 JSON 文件，可放到网盘或 U 盘带走。</p>
            {lastExport && (
              <p className="text-[11px] text-emerald-600 mt-1 truncate" title={lastExport.path}>
                已导出：{baseName(lastExport.path)} · {lastExport.summary.notes} 篇笔记 /{" "}
                {lastExport.summary.categories} 个分组 / {lastExport.summary.messages} 条对话消息
              </p>
            )}
          </div>
          <button
            onClick={handleExport}
            disabled={busy !== null}
            className="btn-primary px-3 py-1.5 text-xs flex-shrink-0 disabled:opacity-50"
          >
            {busy === "export" ? "导出中..." : "导出"}
          </button>
        </div>

        {/* 恢复 */}
        <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
          <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
            <Icon name="app-restore" className="w-4 h-4 text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-700">从备份恢复</p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              选择备份文件后覆盖当前数据；同机恢复会保留已填好的 API Key。
            </p>
          </div>
          <button
            onClick={handleImport}
            disabled={busy !== null}
            className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-100 rounded-xl hover:bg-amber-200 transition-colors flex-shrink-0 disabled:opacity-50"
          >
            {busy === "import" ? "恢复中..." : "选择文件"}
          </button>
        </div>

        {lastExport?.summary.exported_at && (
          <p className="text-[11px] text-slate-400">本次导出时间：{prettyTime(lastExport.summary.exported_at)}</p>
        )}
      </div>
      </Modal>

      {confirmDialog}
    </>
  );
};