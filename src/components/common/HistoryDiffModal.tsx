/**
 * 历史版本对比：把选中版本与「当前内容」逐行对照。
 *
 * 只做单向对比（历史版本 → 当前），不提供任意两版对比——回滚前的决策只需要知道
 * 当前内容比当时多了 / 少了什么。新增行绿底、删除行红底，行号分左右两列。
 */
import { useMemo } from "react";
import { useI18n } from "@/i18n";
import type { NoteHistoryEntry } from "@/interface/note";
import { Modal } from "@/components/common/Modal";
import { formatDateTime } from "@/lib/format";
import { diffLines } from "@/lib/lineDiff";

/** 一次最多渲染的差异行数：再长就不是「看差异」而是「读全文」了 */
const MAX_ROWS = 3000;

export const HistoryDiffModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  entry: NoteHistoryEntry | null;
  /** 当前笔记正文；与历史版本单向对比 */
  currentContent: string;
}> = ({ isOpen, onClose, entry, currentContent }) => {
  const { t, locale } = useI18n();
  const diff = useMemo(
    () => (entry ? diffLines(entry.content, currentContent) : null),
    [entry, currentContent],
  );
  const visible = diff ? diff.rows.slice(0, MAX_ROWS) : [];
  const truncated = diff != null && diff.rows.length > MAX_ROWS;

  return (
    <Modal
      isOpen={isOpen && entry != null}
      onClose={onClose}
      title={t("版本对比")}
      size="2xl"
      height="min(78vh, 760px)"
    >
      {entry && diff && (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 flex-shrink-0">
            <span className="text-[12px] font-medium text-body">{formatDateTime(entry.saved_at, locale)}</span>
            <span className="text-[11px] text-faint">{t("历史版本")}</span>
            <span className="text-[11px] text-faint-soft">→</span>
            <span className="text-[11px] text-faint">{t("当前内容")}</span>
            <span className="ml-auto flex items-center gap-2 text-[11px] font-medium">
              <span className="text-success-strong">+{diff.added}</span>
              <span className="text-danger-strong">−{diff.removed}</span>
            </span>
          </div>

          {diff.tooLarge && (
            <p className="pb-2 flex-shrink-0 text-[11px] text-warning-strong">
              {t("内容差异过大，未逐行对比")}
            </p>
          )}
          {diff.added === 0 && diff.removed === 0 && (
            <p className="pb-2 flex-shrink-0 text-[11px] text-faint">{t("两个版本内容一致")}</p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto chat-scrollbar rounded-lg border border-line-soft">
            {visible.map((row, index) => (
              <div
                key={index}
                className={`flex items-start font-mono text-[12px] leading-5 ${
                  row.kind === "add" ? "bg-success-soft" : row.kind === "remove" ? "bg-danger-soft" : ""
                }`}
              >
                <span className="w-10 flex-none select-none pr-2 text-right text-faint-soft">{row.oldLine ?? ""}</span>
                <span className="w-10 flex-none select-none pr-2 text-right text-faint-soft">{row.newLine ?? ""}</span>
                <span className="w-4 flex-none select-none text-center text-faint-soft">
                  {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2 text-body">{row.text || " "}</span>
              </div>
            ))}
          </div>

          {truncated && (
            <p className="pt-2 flex-shrink-0 text-[11px] text-faint">
              {t("仅显示前 {value1} 行", { value1: MAX_ROWS })}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};
