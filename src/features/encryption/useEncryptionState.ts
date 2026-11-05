/**
 * 加密域：加密状态、根密码设置/修改、加密目标、解锁 / 永久解密流程、
 * 手动与空闲自动锁定，以及启动自检与页面隐藏时的密钥压缩。
 *
 * 所有密钥运算都在 Rust 侧完成，这里只负责：收集密码 → 调命令 → 刷新状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Category, Note } from "@/interface/note/note";
import type { PropertiesTarget } from "@/interface/app/ui";
import type {
  EncryptionInfo,
  EncryptionScope,
  EncryptionStatus,
  UnlockScope,
} from "@/interface/system/encryption";
import * as encryptionApi from "@/api/system/encryption";
import * as notesApi from "@/api/note/notes";
import { describeEncryptionError } from "@/components/common/EncryptionDialogs";
import { useIdleLock } from "@/hooks/useIdleLock";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";
import { isTauri } from "@tauri-apps/api/core";

export interface UseEncryptionStateParams {
  notes: Note[];
  setNotes: Dispatch<SetStateAction<Note[]>>;
  categories: Category[];
  setCategories: Dispatch<SetStateAction<Category[]>>;
  selectedNoteRef: RefObject<Note | null>;
  setSelectedNote: Dispatch<SetStateAction<Note | null>>;
  setSelectedCategoryId: Dispatch<SetStateAction<string | null>>;
  setExpandedDrawer: Dispatch<SetStateAction<string | 'all' | 'uncategorized' | null>>;
  loadData: () => Promise<void>;
  showTrashModal: boolean;
  setTrashNotes: Dispatch<SetStateAction<Note[]>>;
  setPropertiesTarget: Dispatch<SetStateAction<PropertiesTarget | null>>;
  openNote: (note: Note) => void;
  pendingUnlockNoteRef: RefObject<string | null>;
  /** 空闲自动锁定的分钟数（0 = 关闭） */
  autoLockMinutes: number;
}

export function useEncryptionState({
  notes,
  setNotes,
  categories,
  setCategories,
  selectedNoteRef,
  setSelectedNote,
  setSelectedCategoryId,
  setExpandedDrawer,
  loadData,
  showTrashModal,
  setTrashNotes,
  setPropertiesTarget,
  openNote,
  pendingUnlockNoteRef,
  autoLockMinutes,
}: UseEncryptionStateParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /* ---------------- 加密 ----------------
   * 状态只有两个来源：启动时的 encryption_status（决定是否强制设置根密码），
   * 以及每次加密/解密/锁定后的刷新。密钥本身只存在于 Rust 内存，前端拿不到也存不了。
   */
  const [encryptionStatus, setEncryptionStatus] = useState<EncryptionStatus | null>(null);
  /** 首次启动未设置根密码时强制弹出的设置窗（不可关闭） */
  const [showRootSetup, setShowRootSetup] = useState(false);
  /** 关于页作者名 5 连击打开的根密码修改窗 */
  const [showRootChange, setShowRootChange] = useState(false);
  /** 加密弹窗的目标；null 表示关闭 */
  const [encryptTarget, setEncryptTarget] = useState<{ scope: EncryptionScope; id: string } | null>(null);
  /** 解锁 / 永久解密弹窗的目标；info 提供密码提示与根密码可用性 */
  const [unlockTarget, setUnlockTarget] = useState<{
    scope: EncryptionScope;
    id: string;
    permanent: boolean;
    info: EncryptionInfo;
  } | null>(null);
  const selfCheckDoneRef = useRef(false);

  /**
   * 刷新加密状态：根密码是否设置、本次运行是否缓存过 KEK。
   * 未设置根密码时立刻弹出设置窗——这是启动后的第一件事，不等到用户去加密才补。
   */
  const refreshEncryptionStatus = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const status = await encryptionApi.getEncryptionStatus();
      setEncryptionStatus(status);
      if (!status.root_set) setShowRootSetup(true);
    } catch (e) {
      console.error("读取加密状态失败：", e);
    }
  }, []);

  useEffect(() => {
    void refreshEncryptionStatus();
  }, [refreshEncryptionStatus]);

  /**
   * 请求解锁（或永久解密）某个加密项：先取 encryption_info，拿到密码提示、
   * 已错次数与根密码可用性再开弹窗；已经解锁的条目直接跳过。
   */
  const requestUnlock = useCallback(async (
    scope: EncryptionScope,
    id: string,
    permanent = false,
  ) => {
    try {
      const info = await encryptionApi.getEncryptionInfo(scope, id);
      if (!info.encrypted) return;
      if (!info.is_locked && !permanent) return;
      setUnlockTarget({ scope, id, permanent, info });
    } catch (e) {
      // 后端拒绝时是 JSON 字符串，不能直接展示给用户
      showToast(describeEncryptionError(e, t).message, "error");
    }
  }, [showToast, t]);

  /**
   * 尝试锁回「仅本次解锁」的加密项。
   * 后端 force=false 只清 once 作用域的密钥，session 解锁不受影响；
   * 锁成功后把本地列表同步成锁定态，避免界面还留着刚解出来的明文。
   */
  const lockOnceUnlocked = useCallback(async (
    scope: EncryptionScope,
    id: string,
    clearSelected = false,
  ) => {
    try {
      if (scope === "note") {
        await encryptionApi.lockNote(id, false);
        const info = await encryptionApi.getEncryptionInfo("note", id);
        if (info.encrypted && info.is_locked) {
          setNotes((prev) =>
            prev.map((n) =>
              n.id === id ? { ...n, is_locked: true, content: "" } : n,
            ),
          );
          if (clearSelected && selectedNoteRef.current?.id === id) {
            selectedNoteRef.current = null;
            setSelectedNote(null);
          }
        }
      } else {
        await encryptionApi.lockCategory(id, false);
        const info = await encryptionApi.getEncryptionInfo("category", id);
        if (info.encrypted && info.is_locked) {
          setCategories((prev) =>
            prev.map((c) => (c.id === id ? { ...c, is_locked: true } : c)),
          );
          setNotes((prev) =>
            prev.map((n) =>
              n.category_id === id ? { ...n, is_locked: true, content: "" } : n,
            ),
          );
          if (clearSelected && selectedNoteRef.current?.category_id === id) {
            selectedNoteRef.current = null;
            setSelectedNote(null);
          }
        }
      }
    } catch {
      // 锁定失败只影响下一次打开时是否要再输密码，不打断当前交互
    }
  }, [setNotes, setCategories]);

  const handleRootSetup = async (password: string) => {
    const result = await encryptionApi.setRootPassword(password);
    setShowRootSetup(false);
    await refreshEncryptionStatus();
    showToast(t("根密码设置成功"), "success");
    if (result.orphans > 0) {
      showToast(
        t("有 {count} 个加密项无法绑定根密码（早期数据），只能用各自的条目密码解密", {
          count: result.orphans,
        }),
        "info",
      );
    }
  };

  const handleRootChange = async (oldPassword: string, newPassword: string) => {
    const result = await encryptionApi.changeRootPassword(oldPassword, newPassword);
    showToast(t("根密码已修改"), "success");
    if (result.rewrapped > 0) {
      showToast(
        t("有 {count} 个加密项已重新绑定到新根密码", { count: result.rewrapped }),
        "info",
      );
    }
    if (result.skipped > 0) {
      showToast(
        t("有 {count} 个加密项无法重新绑定（早期数据），仍可用条目密码解密", {
          count: result.skipped,
        }),
        "info",
      );
    }
  };

  /** 右键「加密」：打开弹窗；本次运行没验证过根密码时弹窗内会多要一次根密码 */
  const handleEncryptNote = (note: Note) => setEncryptTarget({ scope: "note", id: note.id });
  const handleEncryptCategory = (category: Category) =>
    setEncryptTarget({ scope: "category", id: category.id });

  /** 加密提交：加密成功后立即回到锁定态，笔记需要重新输密码才能打开 */
  const handleEncryptSubmit = async (
    password: string,
    hint: string | null,
    rootPassword: string | null,
  ) => {
    if (!encryptTarget) return;
    const target = encryptTarget;
    if (target.scope === "note") {
      const updated = await encryptionApi.encryptNote(target.id, password, hint, rootPassword);
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      // 后端不再缓存密钥，当前正打开的就是明文副本，必须关掉
      if (selectedNoteRef.current?.id === updated.id) {
        selectedNoteRef.current = null;
        setSelectedNote(null);
      }
      showToast(t("笔记已加密并锁定，打开时需要输入密码"), "success");
    } else {
      await encryptionApi.encryptCategory(target.id, password, hint, rootPassword);
      // 组内笔记在库里已变密文：关闭正打开的组内笔记，避免编辑器还显示明文
      if (selectedNoteRef.current?.category_id === target.id) {
        // ref 同步清空：loadData 读的是 ref，晚一步会把它重新选回来
        selectedNoteRef.current = null;
        setSelectedNote(null);
      }
      // 加密后分组进入锁定态：展开着只剩标题和小锁，没有任何可读内容，
      // 收起后列表长度与「点开要解锁」的预期一致；下次展开会先弹解锁框
      setExpandedDrawer((prev) => (prev === target.id ? null : prev));
      await loadData();
      showToast(t("分组已加密，组内笔记全部锁定"), "success");
    }
    await refreshEncryptionStatus();
  };

  /** 临时解锁 / 永久解密的提交 */
  const handleUnlockSubmit = async (
    password: string,
    useRoot: boolean,
    scope: UnlockScope,
  ) => {
    if (!unlockTarget) return;
    const target = unlockTarget;
    if (target.permanent) {
      if (target.scope === "note") {
        const updated = await encryptionApi.decryptNote(target.id, password, useRoot);
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
        if (selectedNoteRef.current?.id === updated.id) setSelectedNote(updated);
        // 属性窗自己持有一份笔记副本：不同步就会继续显示「锁定」入口
        setPropertiesTarget((prev) =>
          prev && prev.kind === "note" && prev.note.id === updated.id
            ? { kind: "note", note: updated }
            : prev,
        );
        // 回收站里的笔记也能永久解密：解密后原地变成普通笔记，删除入口随之恢复
        if (showTrashModal) {
          try {
            setTrashNotes(await notesApi.getTrashNotes());
          } catch {
            // 回收站刷新失败不影响解密结果
          }
        }
      } else {
        await encryptionApi.decryptCategory(target.id, password, useRoot);
        await loadData();
        // 分组属性窗持有的是旧快照，留着会继续显示锁定 / 解密入口
        setPropertiesTarget((prev) =>
          prev && prev.kind === "category" && prev.category.id === target.id ? null : prev,
        );
      }
      showToast(t(target.scope === "note" ? "笔记已解密" : "分组已解密"), "success");
    } else if (target.scope === "note") {
      pendingUnlockNoteRef.current = null;
      const updated = await encryptionApi.unlockNote(target.id, password, useRoot, scope);
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      // 解锁是从「点开笔记」触发的：解锁成功后顺势打开它
      openNote(updated);
      showToast(t("解锁成功"), "success");
    } else {
      await encryptionApi.unlockCategory(target.id, password, useRoot, scope);
      await loadData();
      setSelectedCategoryId(target.id);
      setExpandedDrawer(target.id);
      // 是点组内某篇笔记触发的解锁：把这篇也直接打开
      const pendingId = pendingUnlockNoteRef.current;
      pendingUnlockNoteRef.current = null;
      if (pendingId !== null) {
        try {
          openNote(await notesApi.getNote(pendingId));
        } catch {
          // 笔记可能已被删除，分组已展开即可
        }
      }
      showToast(t("解锁成功"), "success");
    }
    await refreshEncryptionStatus();
  };

  /** 手动锁定单篇加密笔记（分组加密的笔记要锁分组） */
  const handleLockNote = async (note: Note) => {
    try {
      await encryptionApi.lockNote(note.id, true);
      // 锁定前先问后端：已经永久解密的笔记不能再被本地标成锁定态，
      // 否则界面显示「锁定」但库里是明文，点开既没有正文也没有密码框
      const info = await encryptionApi.getEncryptionInfo("note", note.id);
      if (!info.encrypted) {
        await loadData();
        return;
      }
      if (selectedNoteRef.current?.id === note.id) {
        selectedNoteRef.current = null;
        setSelectedNote(null);
      }
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...n, is_locked: true, content: "" } : n,
        ),
      );
      showToast(t("笔记已锁定"), "success");
    } catch {
      showToast(t("操作失败，请重试"), "error");
    }
  };

  const handleLockCategory = async (category: Category) => {
    try {
      await encryptionApi.lockCategory(category.id, true);
      if (selectedNoteRef.current?.category_id === category.id) {
        // ref 同步清空：后面的 loadData 会按 ref 决定是否重新选中
        selectedNoteRef.current = null;
        setSelectedNote(null);
      }
      // 锁定的分组展开着只剩标题和小锁，收起更符合「已锁定」的状态；
      // 下次展开会先弹解锁框
      setExpandedDrawer((prev) => (prev === category.id ? null : prev));
      await loadData();
      showToast(t("分组已锁定"), "success");
    } catch {
      showToast(t("操作失败，请重试"), "error");
    }
  };

  /** 还有没有「能省下来的密钥」：解锁中的条目、或本次运行缓存过的根 KEK */
  const hasUnlockedEncryption = useMemo(
    () =>
      Boolean(encryptionStatus?.root_cached) ||
      notes.some((n) => n.enc_mode !== 0 && !n.is_locked) ||
      categories.some((c) => c.is_encrypted && !c.is_locked),
    [encryptionStatus, notes, categories],
  );

  /**
   * 一键锁定全部加密内容：连同根 KEK 一起清掉（后端会先把内存里的密钥字节覆写掉）。
   * 手动触发与空闲自动锁定共用；本地列表同步回锁定态，正打开的加密笔记一并关掉。
   */
  const lockEverything = useCallback(
    async (reason: "manual" | "idle" = "manual") => {
      if (!isTauri()) return;
      if (!hasUnlockedEncryption) {
        if (reason === "manual") showToast(t("当前没有解锁中的加密内容"), "info");
        return;
      }
      try {
        await encryptionApi.lockAll();
      } catch {
        showToast(t("操作失败，请重试"), "error");
        return;
      }
      setNotes((prev) =>
        prev.map((n) => (n.enc_mode !== 0 ? { ...n, is_locked: true, content: "" } : n)),
      );
      setCategories((prev) =>
        prev.map((c) => (c.is_encrypted ? { ...c, is_locked: true } : c)),
      );
      const current = selectedNoteRef.current;
      if (current && current.enc_mode !== 0) {
        selectedNoteRef.current = null;
        setSelectedNote(null);
      }
      pendingUnlockNoteRef.current = null;
      // 展开着的加密分组现在都锁上了：收起，别留一列只有标题和小锁的条目
      setExpandedDrawer((prev) =>
        typeof prev === "string" && categories.some((c) => c.id === prev && c.is_encrypted)
          ? null
          : prev,
      );
      // 后端已清空根 KEK：本地状态跟着改，下次加密会重新要根密码
      setEncryptionStatus((prev) => (prev ? { ...prev, root_cached: false } : prev));
      void encryptionApi.flushCryptoScrub();
      showToast(
        reason === "idle"
          ? t("已空闲 {minutes} 分钟，加密内容已自动锁定", {
              minutes: autoLockMinutes,
            })
          : t("已锁定全部加密内容"),
        "success",
      );
    },
    [hasUnlockedEncryption, categories, autoLockMinutes, showToast, t, setNotes, setCategories],
  );

  // 空闲自动锁定（设置为 0 时 hook 内部不挂计时器）；
  // 密码弹窗打开期间顺延，避免用户正输密码时密钥被清掉
  useIdleLock({
    minutes: autoLockMinutes,
    onIdle: () => void lockEverything("idle"),
    shouldSkip: () => Boolean(showRootSetup || unlockTarget || encryptTarget),
  });

  /**
   * 启动加密自检：只跑一次（loadData 变化不应重跑）。
   * 后端会修好「正文是密文但加密标志丢了」这类可推断的错乱，并上报其余异常；
   * 修过就重新拉一次列表，让侧边栏立刻显示成锁定态。
   */
  useEffect(() => {
    if (!isTauri() || selfCheckDoneRef.current) return;
    selfCheckDoneRef.current = true;
    void encryptionApi
      .runEncryptionSelfCheck()
      .then((report) => {
        if (report.repaired.length > 0) {
          showToast(
            t("已修复 {count} 篇笔记的加密状态", { count: report.repaired.length }),
            "success",
          );
          void loadData();
        }
        const missing = report.missing_keys.length + report.missing_category_keys.length;
        if (missing > 0) {
          showToast(t("有 {count} 个加密项缺少密钥，暂时无法解密", { count: missing }), "error");
        }
        const abnormal = report.orphan_keys.length + report.content_mismatch.length;
        if (abnormal > 0) {
          showToast(t("有 {count} 个加密项状态异常，建议检查后用备份恢复", { count: abnormal }), "info");
        }
        if (report.repaired.length || missing || abnormal) {
          console.warn("加密自检：", report);
        }
      })
      .catch((error) => console.error("启动加密自检失败：", error));
  }, [loadData, showToast, t]);

  // 页面隐藏（最小化/关窗）前立即压缩一次：加解密留下的旧明文页不必等到空闲的 15 秒兜底
  useEffect(() => {
    if (!isTauri()) return;
    const flush = () => void encryptionApi.flushCryptoScrub();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return {
    encryptionStatus,
    showRootSetup,
    setShowRootSetup,
    showRootChange,
    setShowRootChange,
    encryptTarget,
    setEncryptTarget,
    unlockTarget,
    setUnlockTarget,
    refreshEncryptionStatus,
    requestUnlock,
    lockOnceUnlocked,
    handleRootSetup,
    handleRootChange,
    handleEncryptNote,
    handleEncryptCategory,
    handleEncryptSubmit,
    handleUnlockSubmit,
    handleLockNote,
    handleLockCategory,
    hasUnlockedEncryption,
    lockEverything,
  };
}
