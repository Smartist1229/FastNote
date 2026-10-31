/**
 * 加密相关的四个弹窗：根密码设置 / 根密码修改 / 加密 / 解锁（含永久解密）。
 *
 * 弹窗只负责收集密码与展示错误，真正的命令调用由调用方通过 onSubmit 注入；
 * 后端以 {"code":...} 拒绝时在这里解析成可读文案（密码错误次数、根密码冷却等）。
 */
import { useEffect, useState } from "react";

import { Modal } from "@/components/common/Modal";
import { normalizeEncryptionError } from "@/api/encryption";
import type { EncryptionError } from "@/api/encryption";
import type { UnlockScope } from "@/interface/encryption";
import { useI18n } from "@/i18n";

const PASSWORD_MIN = 8;

export const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}> = ({ label, value, onChange, placeholder, autoFocus, onEnter }) => {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-faint">{label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="new-password"
        spellCheck={false}
        className="w-full px-2.5 py-2 text-sm input-modern"
      />
    </label>
  );
};

const ErrorLine: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <p className="rounded-lg border border-danger/30 bg-danger-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
      {message}
    </p>
  ) : null;

/** 把命令错误翻译成界面文案；同时把最新尝试次数回传给调用方 */
const describeError = (
  error: unknown,
  t: (source: string, params?: Record<string, string | number>) => string,
): { message: string; code: string | null; cooldown?: number } => {
  const { code, error: normalized } = normalizeEncryptionError(error);
  if (normalized instanceof Error) {
    const payload = (normalized as EncryptionError).payload;
    switch (code) {
      case "bad_password": {
        const attempts = typeof payload?.attempts === "number" ? payload.attempts : 0;
        if (attempts >= 3) return { message: t("条目密码已错 3 次，现在可以改用根密码"), code };
        return { message: t("密码错误，还可尝试 {count} 次", { count: Math.max(0, 3 - attempts) }), code };
      }
      case "root_bad_password": {
        const cooldown = Number(payload?.cooldown_seconds ?? 0);
        if (cooldown > 0) {
          return {
            message: t("根密码错误次数过多，请等待 {seconds} 秒后再试", { seconds: cooldown }),
            code,
            cooldown,
          };
        }
        return { message: t("根密码错误，还可尝试 {count} 次", { count: 4 }), code };
      }
      case "root_not_allowed":
        return { message: t("请先连续输错 3 次条目密码，才能改用根密码"), code };
      case "root_unavailable":
        return { message: t("该加密项无法用根密码恢复"), code };
      case "root_not_set":
        return { message: t("根密码未设置，请先设置"), code };
      case "root_locked":
        return { message: t("本次运行尚未验证根密码，请重新输入"), code };
      case "root_already_set":
        return { message: t("根密码已设置，如需修改请在关于页操作"), code };
      case "password_too_short":
        return { message: t("密码至少 8 位"), code };
      case "password_too_long":
        return { message: t("密码最多 128 位"), code };
      case "already_encrypted":
        return { message: t("该内容已经加密"), code };
      case "already_sealed": {
        // 分组加密会带上是哪几篇已经是密文；单篇（或保存时发现密文）只有错误码
        const count = payload?.note_ids?.length ?? 0;
        return {
          message: count > 0
            ? t("有 {count} 篇笔记已是密文，请先永久解密再重试", { count })
            : t("该内容已是密文，请先永久解密再重试"),
          code,
        };
      }
      case "not_encrypted":
        return { message: t("该内容没有加密"), code };
      case "locked":
        return { message: t("内容已重新锁定，请先解锁再试"), code };
      case "encrypted_note":
        return { message: t("加密笔记不支持该操作：请先永久解密"), code };
      case "invalid_scope":
        return { message: t("解锁范围无效，请重试"), code };
      case "has_individual_encrypted_notes":
        return { message: t("组内有单独加密的笔记，请先逐篇解密"), code };
      case "note_encrypted":
        return { message: t("加密笔记不支持该操作：请先永久解密"), code };
      case "note_deleted":
        return { message: t("回收站里的笔记不能加密，请先还原"), code };
      case "category_encrypted":
        return { message: t("该分组已加密，不能移入或修改"), code };
      case "tags_encrypted":
        return { message: t("标签随笔记加密，不能直接修改"), code };
      case "local_has_encrypted":
        return { message: t("当前库存在加密内容，恢复会丢失密钥，已取消"), code };
      case "backup_contains_encrypted":
        return { message: t("备份包含加密内容，无法恢复"), code };
      case "backup_passphrase_too_short":
        return { message: t("备份口令至少 8 位"), code };
      case "backup_passphrase_too_long":
        return { message: t("备份口令最多 128 位"), code };
      case "bad_backup_passphrase":
        return { message: t("备份口令错误，或文件已损坏"), code };
      case "not_encrypted_backup":
        return { message: t("这不是 FastNote 加密备份文件"), code };
      default:
        return { message: normalized.message || t("操作失败，请重试"), code };
    }
  }
  return { message: typeof error === "string" && error ? error : t("操作失败，请重试"), code };
};

/** 弹窗之外的调用方（toast）复用同一套错误码 → 文案映射，避免把后端 JSON 直接抛给用户 */
export const describeEncryptionError = describeError;

/* ---------------- 根密码设置 ---------------- */

export const RootSetupDialog: React.FC<{
  isOpen: boolean;
  onSubmit: (password: string) => Promise<void>;
}> = ({ isOpen, onSubmit }) => {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPassword("");
      setConfirm("");
      setAck(false);
      setError(null);
      setBusy(false);
    }
  }, [isOpen]);

  const submit = async () => {
    if (!ack) {
      setError(t("请先勾选确认项"));
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setError(t("密码至少 8 位"));
      return;
    }
    if (password !== confirm) {
      setError(t("两次输入的密码不一致"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={() => { /* 首次启动必须设置根密码 */ }} title={t("设置根密码")}>
      <div className="space-y-3.5" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}>
        <p className="text-[12.5px] leading-relaxed text-body">{t("根密码用于加密时保护密钥，也是忘记条目密码后的最后手段。")}</p>
        <p className="rounded-lg border border-warning/30 bg-warning-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-warning">
          {t("根密码一旦遗忘，没有任何找回手段，已加密的内容将永久无法解密。请务必牢记，或记录在安全的地方。")}
        </p>
        <p className="text-[11px] leading-relaxed text-faint">
          {t("以后可在「关于」页连续点击作者名 5 次修改根密码。")}
        </p>
        <PasswordField label={t("根密码")} value={password} onChange={setPassword} autoFocus placeholder={t("密码至少 8 位")} />
        <PasswordField label={t("确认根密码")} value={confirm} onChange={setConfirm} />
        <label className="flex items-start gap-2 text-[11.5px] leading-relaxed text-body cursor-pointer">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          {t("我已知晓：根密码遗忘后无法恢复任何加密内容")}
        </label>
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => void submit()} disabled={busy || !ack} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy ? t("设置中…") : t("设置根密码")}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/* ---------------- 根密码修改（关于页 5 连击入口） ---------------- */

export const RootChangeDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (oldPassword: string, newPassword: string) => Promise<void>;
}> = ({ isOpen, onClose, onSubmit }) => {
  const { t } = useI18n();
  const [oldPassword, setOldPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setOldPassword("");
      setPassword("");
      setConfirm("");
      setError(null);
      setBusy(false);
    }
  }, [isOpen]);

  const submit = async () => {
    if (!oldPassword) {
      setError(t("请先输入密码"));
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setError(t("密码至少 8 位"));
      return;
    }
    if (password !== confirm) {
      setError(t("两次输入的密码不一致"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(oldPassword, password);
      onClose();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("修改根密码")}>
      <div className="space-y-3.5" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}>
        <p className="text-[12px] leading-relaxed text-faint">{t("根密码一旦遗忘，没有任何找回手段，已加密的内容将永久无法解密。请务必牢记，或记录在安全的地方。")}</p>
        <PasswordField label={t("原根密码")} value={oldPassword} onChange={setOldPassword} autoFocus />
        <PasswordField label={t("新根密码")} value={password} onChange={setPassword} placeholder={t("密码至少 8 位")} />
        <PasswordField label={t("确认新根密码")} value={confirm} onChange={setConfirm} />
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">{t("取消")}</button>
          <button onClick={() => void submit()} disabled={busy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy ? t("保存中…") : t("保存")}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/* ---------------- 加密 ---------------- */

export const EncryptDialog: React.FC<{
  isOpen: boolean;
  mode: "note" | "category";
  /** 本次运行未缓存根 KEK 时需要补输根密码 */
  requiresRoot: boolean;
  /** 分组模式：本次会一并加密的笔记数（不含回收站） */
  noteCount?: number;
  onClose: () => void;
  onSubmit: (password: string, hint: string | null, rootPassword: string | null) => Promise<void>;
}> = ({ isOpen, mode, requiresRoot, noteCount, onClose, onSubmit }) => {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hint, setHint] = useState("");
  const [rootPassword, setRootPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPassword("");
      setConfirm("");
      setHint("");
      setRootPassword("");
      setError(null);
      setBusy(false);
    }
  }, [isOpen]);

  const submit = async () => {
    if (password.length < PASSWORD_MIN) {
      setError(t("密码至少 8 位"));
      return;
    }
    if (password !== confirm) {
      setError(t("两次输入的密码不一致"));
      return;
    }
    if (requiresRoot && !rootPassword) {
      setError(t("请先输入密码"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password, hint.trim() || null, requiresRoot ? rootPassword : null);
      onClose();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t(mode === "note" ? "加密笔记" : "加密分组")}>
      <div className="space-y-3.5" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}>
        <p className="text-[12.5px] leading-relaxed text-body">{t("笔记标题、所属分组名、创建/更新时间和密码提示不加密；正文、标签与历史版本以密文保存。")}</p>
        {mode === "category" && noteCount !== undefined && (
          <p className="text-[12px] leading-relaxed text-body">
            {t("将加密该分组内 {count} 篇笔记（不含回收站）", { count: noteCount })}
          </p>
        )}
        <p className="rounded-lg border border-line bg-surface-alt px-2.5 py-2 text-[11.5px] leading-relaxed text-faint">
          {t("加密后立即锁定，打开时要输入密码；不参与导出、备份、恢复、AI 与语义搜索；忘记密码可在输错 3 次后改用根密码；根密码也遗忘则无法恢复。")}
        </p>
        <PasswordField
          label={t(mode === "note" ? "笔记密码" : "分组密码")}
          value={password}
          onChange={setPassword}
          autoFocus
          placeholder={t("密码至少 8 位")}
        />
        <PasswordField label={t("确认密码")} value={confirm} onChange={setConfirm} />
        <label className="block">
          <span className="mb-1 block text-[11px] text-faint">{t("密码提示（可选）")}</span>
          <input
            type="text"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            maxLength={100}
            spellCheck={false}
            className="w-full px-2.5 py-2 text-sm input-modern"
          />
          <span className="mt-1 block text-[10.5px] text-faint-soft">{t("提示会以明文保存，请勿写出密码本身")}</span>
        </label>
        {requiresRoot && (
          <div className="space-y-1">
            <p className="text-[11px] text-faint">{t("本次运行尚未验证根密码，加密前需要确认一次。")}</p>
            <PasswordField label={t("输入根密码")} value={rootPassword} onChange={setRootPassword} />
          </div>
        )}
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">{t("取消")}</button>
          <button onClick={() => void submit()} disabled={busy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy ? t("保存中…") : t(mode === "note" ? "加密笔记" : "加密分组")}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/* ---------------- 解锁 / 永久解密 ---------------- */

export const UnlockDialog: React.FC<{
  isOpen: boolean;
  mode: "note" | "category";
  /** true = 永久解密（成功后不再加密）；false = 临时解锁 */
  permanent: boolean;
  hint: string | null;
  attempts: number;
  rootAllowed: boolean;
  rootWrapped: boolean;
  onClose: () => void;
  onSubmit: (password: string, useRoot: boolean, scope: UnlockScope) => Promise<void>;
}> = ({ isOpen, mode, permanent, hint, attempts, rootAllowed, rootWrapped, onClose, onSubmit }) => {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [useRoot, setUseRoot] = useState(false);
  // 默认「仅本次解锁」：解锁是一次性授权，想长期保持要用户明确勾选
  const [scope, setScope] = useState<UnlockScope>("once");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(rootAllowed);
  const [wrongAttempts, setWrongAttempts] = useState(attempts);
  /** 根密码冷却剩余秒数：>0 时禁用提交，防止用户在冷却期反复点 */
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setPassword("");
      setUseRoot(false);
      setScope("once");
      setError(null);
      setBusy(false);
      setAllowed(rootAllowed);
      setWrongAttempts(attempts);
      setCooldown(0);
    } else {
      // 弹窗只是 isOpen=false，组件不卸载：关闭时顺手把密码从 React 状态里抹掉，
      // 别让刚输过的口令一直躺在内存里直到下次打开
      setPassword("");
      setUseRoot(false);
      setError(null);
    }
  }, [isOpen, rootAllowed, attempts]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const submit = async () => {
    if (!password || cooldown > 0) {
      if (!password) setError(t("请输入密码"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password, useRoot, permanent ? "session" : scope);
      onClose();
    } catch (e) {
      const described = describeError(e, t);
      setError(described.message);
      if (described.cooldown && described.cooldown > 0) setCooldown(described.cooldown);
      if (described.code === "bad_password" || described.code === "root_not_allowed") {
        const next = wrongAttempts + 1;
        setWrongAttempts(next);
        if (next >= 3) setAllowed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const title = permanent
    ? t(mode === "note" ? "解密笔记…" : "解密分组…")
    : t(mode === "note" ? "解锁笔记" : "解锁分组");

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="space-y-3.5" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}>
        {permanent ? (
          <div className="space-y-2">
            <p className="rounded-lg border border-warning/30 bg-warning-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-warning">
              {t("永久解密后正文、标签与历史版本会以明文重新写入数据库，确定继续吗？")}
            </p>
            <p className="text-[11.5px] leading-relaxed text-faint">
              {t("如需更换密码，请解密后用新密码重新加密")}
            </p>
          </div>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-body">
            {t(mode === "note" ? "这篇笔记已加密，输入密码后查看内容。" : "这个分组已加密，输入密码后展开分组并查看组内笔记。")}
          </p>
        )}
        {hint && <p className="text-[11.5px] text-faint">{t("密码提示：{hint}", { hint })}</p>}
        {useRoot && !rootWrapped && <p className="text-[11.5px] text-warning">{t("该加密项无法用根密码恢复")}</p>}
        <PasswordField
          label={useRoot ? t("根密码") : t(mode === "note" ? "笔记密码" : "分组密码")}
          value={password}
          onChange={setPassword}
          autoFocus
        />
        {allowed && (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <button
              type="button"
              onClick={() => { setUseRoot((v) => !v); setPassword(""); setError(null); }}
              className={`rounded-lg border px-2.5 py-1 transition-colors ${
                useRoot ? "border-primary-300 bg-primary-50 text-primary-600" : "border-line text-faint hover:bg-surface-alt"
              }`}
            >
              {useRoot ? t("改用笔记密码") : t("改用根密码")}
            </button>
            {!useRoot && <span className="text-faint-soft">{t("条目密码已错 3 次，现在可以改用根密码")}</span>}
          </div>
        )}
        {!permanent && (
          <div className="space-y-1.5">
            {(["once", "session"] as UnlockScope[]).map((value) => (
              <label key={value} className="flex items-center gap-2 text-[11.5px] text-body cursor-pointer">
                <input type="radio" name="unlock-scope" checked={scope === value} onChange={() => setScope(value)} />
                {t(value === "session" ? "解锁后保持到本次软件关闭" : "仅本次解锁，之后自动重新锁定")}
              </label>
            ))}
          </div>
        )}
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">{t("取消")}</button>
          <button onClick={() => void submit()} disabled={busy || cooldown > 0} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {cooldown > 0
              ? t("请等待 {seconds} 秒", { seconds: cooldown })
              : busy
                ? t("解锁中…")
                : permanent
                  ? t("永久解密")
                  : t("解锁")}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/* ---------------- 加密备份口令 ---------------- */

/**
 * 加密容器备份的口令弹窗：导出输两遍确认，恢复输一遍。
 * 口令只用于这次命令，既不落库也不写进备份文件——文件里只有 KDF 参数与盐。
 */
export const BackupPassphraseDialog: React.FC<{
  isOpen: boolean;
  mode: "export" | "import";
  onClose: () => void;
  onSubmit: (passphrase: string) => Promise<void>;
}> = ({ isOpen, mode, onClose, onSubmit }) => {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPassphrase("");
      setConfirm("");
      setError(null);
      setBusy(false);
    }
  }, [isOpen]);

  const submit = async () => {
    if (passphrase.length < PASSWORD_MIN) {
      setError(t("备份口令至少 8 位"));
      return;
    }
    if (passphrase.length > 128) {
      setError(t("备份口令最多 128 位"));
      return;
    }
    if (mode === "export" && passphrase !== confirm) {
      setError(t("两次输入的密码不一致"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(passphrase);
      onClose();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t(mode === "export" ? "设置备份口令" : "输入备份口令")}
    >
      <div className="space-y-3.5" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}>
        <p className="text-[12.5px] leading-relaxed text-body">
          {mode === "export"
            ? t("备份文件会用这个口令再加密一层，包含加密笔记、密钥元数据与根密码信息。口令可以不同于根密码，且不会写进备份文件。")
            : t("这是加密备份，请输入导出时设置的备份口令。恢复后，加密笔记仍需各自的密码或根密码解锁。")}
        </p>
        {mode === "export" && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-warning">
            {t("备份口令遗忘后无法恢复该备份，请务必牢记。")}
          </p>
        )}
        <PasswordField
          label={t("备份口令")}
          value={passphrase}
          onChange={setPassphrase}
          autoFocus
          placeholder={t("密码至少 8 位")}
        />
        {mode === "export" && (
          <PasswordField label={t("确认备份口令")} value={confirm} onChange={setConfirm} />
        )}
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">{t("取消")}</button>
          <button onClick={() => void submit()} disabled={busy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy
              ? mode === "export"
                ? t("导出中...")
                : t("恢复中...")
              : mode === "export"
                ? t("导出加密备份")
                : t("解锁并恢复")}
          </button>
        </div>
      </div>
    </Modal>
  );
};
