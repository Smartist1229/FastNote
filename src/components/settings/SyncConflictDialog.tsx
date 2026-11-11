/**
 * WebDAV 恢复冲突：本地笔记比所选备份更新时，让用户决定保留哪一侧。
 *
 * 三个出口都不静默丢数据：
 * - 保留本地：不恢复，当前数据原样保留；
 * - 保留云端：先自动生成本地安全快照，再覆盖恢复；
 * - 另存为副本：当前数据不动，把选中的备份复制到本地备份目录，之后再手动恢复。
 */
import { Modal } from "@/components/common/Modal";
import { getLocale, useI18n } from "@/i18n";

export interface SyncConflictInfo {
  source: "remote" | "local";
  backupName: string;
  /** ISO 字符串；无法从文件名或服务器时间解析时为 null */
  backupTime: string | null;
  /** 本地最新笔记更新时间；没有笔记时为 null */
  localTime: string | null;
  localNotes: number;
}

const formatTime = (iso: string | null, fallback: string) => {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(getLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

export const SyncConflictDialog: React.FC<{
  info: SyncConflictInfo | null;
  busy: "keepCloud" | "saveCopy" | null;
  onKeepLocal: () => void;
  onKeepCloud: () => void;
  onSaveCopy: () => void;
  onClose: () => void;
}> = ({ info, busy, onKeepLocal, onKeepCloud, onSaveCopy, onClose }) => {
  const { t } = useI18n();
  if (!info) return null;

  const unknown = t("未知");
  const otherSide = info.source === "remote" ? t("云端备份") : t("本地备份");
  /** 主按钮指代「用备份覆盖本地」：云端备份叫保留云端，本地备份就说恢复备份 */
  const overwriteLabel = info.source === "remote" ? t("保留云端") : t("保留备份");
  const disabled = busy !== null;

  return (
    <Modal isOpen onClose={onClose} title={t("发现同步冲突")} size="lg">
      <p className="text-[12px] leading-relaxed text-body">
        {t("本地数据在该备份之后有改动。请选择保留哪一份，或把这份备份另存为副本后再处理。")}
      </p>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-primary-200 bg-primary-50 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-body">{t("本地")}</p>
            <p className="truncate text-[11px] text-faint">
              {t("{notes} 篇笔记", { notes: info.localNotes })} · {formatTime(info.localTime, unknown)}
            </p>
          </div>
          <span className="flex-shrink-0 text-[10px] text-primary-600">{t("当前")}</span>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line-soft bg-app px-3 py-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-body">{otherSide}</p>
            <p className="truncate text-[11px] text-faint" title={info.backupName}>
              {info.backupName} · {formatTime(info.backupTime, unknown)}
            </p>
          </div>
          <span className="flex-shrink-0 text-[10px] text-faint">{t("备份文件")}</span>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        {t("用备份覆盖本地前会自动留一份安全快照；另存为副本不改动当前数据。")}
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onKeepLocal}
          disabled={disabled}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt disabled:opacity-40"
        >
          {t("保留本地")}
        </button>
        <button
          type="button"
          onClick={onSaveCopy}
          disabled={disabled}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt disabled:opacity-40"
        >
          {busy === "saveCopy" ? t("处理中…") : t("另存为副本")}
        </button>
        <button
          type="button"
          onClick={onKeepCloud}
          disabled={disabled}
          className="btn-primary px-3 py-1.5 text-xs"
        >
          {busy === "keepCloud" ? t("处理中…") : overwriteLabel}
        </button>
      </div>
    </Modal>
  );
};
