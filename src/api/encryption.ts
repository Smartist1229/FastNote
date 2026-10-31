/**
 * 加密相关命令的 Tauri 封装。
 *
 * 后端在拒绝时会 reject 一个 JSON 字符串（{"code":"bad_password",...}），
 * 这里统一解析成 `EncryptionError`，调用方按 code 决定提示文案与后续流程。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  EncryptionErrorPayload,
  EncryptionInfo,
  EncryptionScope,
  EncryptionSelfCheckReport,
  EncryptionStatus,
  UnlockScope,
} from "@/interface/encryption";
import type { Note } from "@/interface/note";

/** 带错误码的异常：message 仍是后端原文，code 供界面分支 */
export class EncryptionError extends Error {
  readonly code: string;
  readonly payload: EncryptionErrorPayload;

  constructor(payload: EncryptionErrorPayload, raw: string) {
    super(raw);
    this.code = payload.code;
    this.payload = payload;
  }
}

/** 把任意 reject 值归一：能解析出 code 就是 EncryptionError，否则原样返回 */
export const normalizeEncryptionError = (error: unknown): { code: string | null; error: unknown } => {
  if (error instanceof EncryptionError) return { code: error.code, error };
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error);
      if (parsed && typeof parsed.code === "string") {
        return { code: parsed.code as string, error: new EncryptionError(parsed, error) };
      }
    } catch {
      // 普通字符串错误：没有 code
    }
  }
  return { code: null, error };
};

const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const { error: normalized } = normalizeEncryptionError(error);
    throw normalized;
  }
};

/**
 * 加解密改写了正文所在的行，旧的明文页会被释放。真正压缩库文件（VACUUM）要扫全库，
 * 大库上要几百毫秒，所以推迟到空闲时做一次——立即的抹除由后端 secure_delete 保证。
 */
let scrubTimer: number | null = null;

const scheduleScrub = () => {
  if (typeof window === "undefined") return;
  if (scrubTimer !== null) window.clearTimeout(scrubTimer);
  scrubTimer = window.setTimeout(() => {
    scrubTimer = null;
    void invoke("crypto_scrub_flush").catch(() => undefined);
  }, 15_000);
};

/** 立即压缩（窗口隐藏/关闭前调用）；没有待压缩任务时后端直接返回 false */
export const flushCryptoScrub = (): Promise<boolean> => {
  if (typeof window !== "undefined" && scrubTimer !== null) {
    window.clearTimeout(scrubTimer);
    scrubTimer = null;
  }
  return invoke<boolean>("crypto_scrub_flush").catch(() => false);
};

export const getEncryptionStatus = () => call<EncryptionStatus>("encryption_status");

/** 启动自检：修好「正文是密文但标志丢了」的笔记，其余状态异常只上报 */
export const runEncryptionSelfCheck = () =>
  call<EncryptionSelfCheckReport>("encryption_self_check");

export const getEncryptionInfo = (scope: EncryptionScope, id: number) =>
  call<EncryptionInfo>("encryption_info", { scope, id });

/** 首次设置根密码；设置后本次运行立即缓存 KEK，可直接用于加密新内容 */
export const setRootPassword = async (password: string) => {
  const result = await call<{ rewrapped: number; orphans: number }>("set_root_password", { password });
  scheduleScrub();
  return result;
};

export const unlockRoot = (password: string) => call<{ ok: boolean }>("unlock_root", { password });

export const changeRootPassword = async (oldPassword: string, newPassword: string) => {
  const result = await call<{ rewrapped: number; skipped: number }>("change_root_password", {
    oldPassword,
    newPassword,
  });
  scheduleScrub();
  return result;
};

/** 加密单篇笔记；rootPassword 仅在本次运行未缓存根 KEK 时需要传 */
export const encryptNote = async (
  noteId: number,
  password: string,
  hint: string | null,
  rootPassword: string | null,
): Promise<Note> => {
  const note = await call<Note>("encrypt_note", { noteId, password, hint, rootPassword });
  scheduleScrub();
  return note;
};

/** 临时解锁单篇笔记：useRoot 时 password 是根密码 */
export const unlockNote = (
  noteId: number,
  password: string,
  useRoot: boolean,
  scope: UnlockScope,
): Promise<Note> => call<Note>("unlock_note", { noteId, password, useRoot, scope });

export const lockNote = (noteId: number, force = false) => call<void>("lock_note", { noteId, force });

/** 锁定全部：退出/重开前后端都会清空内存密钥，这里供「一键锁定」使用 */
export const lockAll = () => call<void>("lock_all");

/** 永久解密单篇笔记（解密后标签恢复、历史恢复、语义索引重建） */
export const decryptNote = async (noteId: number, password: string, useRoot: boolean): Promise<Note> => {
  const note = await call<Note>("decrypt_note", { noteId, password, useRoot });
  scheduleScrub();
  return note;
};

export const encryptCategory = async (
  categoryId: number,
  password: string,
  hint: string | null,
  rootPassword: string | null,
) => {
  await call<void>("encrypt_category", { categoryId, password, hint, rootPassword });
  scheduleScrub();
};

export const unlockCategory = (
  categoryId: number,
  password: string,
  useRoot: boolean,
  scope: UnlockScope,
) => call<void>("unlock_category", { categoryId, password, useRoot, scope });

export const lockCategory = (categoryId: number, force = false) =>
  call<void>("lock_category", { categoryId, force });

export const decryptCategory = async (categoryId: number, password: string, useRoot: boolean) => {
  await call<void>("decrypt_category", { categoryId, password, useRoot });
  scheduleScrub();
};
