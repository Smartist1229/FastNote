/**
 * 后端错误码 → 界面文案的唯一词典。
 *
 * 分成两层是刻意的：
 * - `lib/app/backendError.ts` 只解析（拿到 code 和附加参数）；
 * - 这里给 code 配文案。
 *
 * 为什么不合并：同一个 code 在不同场景需要不同措辞。`category_encrypted` 在回收站还原时是
 * 「请先解密分组再还原」，在移动笔记时是「该分组已加密，不能移入」。词典给的是**通用口径**，
 * 需要更具体说法的调用方自己 `isBackendError()` 分支即可。
 *
 * 放在 lib 而不是组件里：`useEncryptionState` 这类 hook 也要用同一套文案，
 * 它不该为了一个字符串映射去 import 一个装着 Modal 的组件文件。
 */

import { parseBackendError } from "./backendError";
import { errorText } from "./errorText";

/** 翻译函数签名：与 i18n 的 `t` 一致（第一参数是中文源串） */
type Translate = (source: string, params?: Record<string, string | number>) => string;

export interface BackendErrorDescription {
  message: string;
  code: string | null;
  /** 根密码冷却剩余秒数，调用方可以用来禁用按钮 */
  cooldown?: number;
}

/**
 * 把任意 reject 值翻成一句人话。
 *
 * 无 code 的普通错误走原文（`errorText` 里已做过英文界面翻译）；
 * 有 code 但词典没收录的，给通用文案——**绝不把后端 JSON 原样抛给用户**。
 */
export const describeBackendError = (error: unknown, t: Translate): BackendErrorDescription => {
  const payload = parseBackendError(error);
  const code = payload?.code ?? null;

  if (payload) {
    switch (code) {
      case "bad_password": {
        const attempts = typeof payload.attempts === "number" ? payload.attempts : 0;
        if (attempts >= 3) return { message: t("条目密码已错 3 次，现在可以改用根密码"), code };
        return { message: t("密码错误，还可尝试 {count} 次", { count: Math.max(0, 3 - attempts) }), code };
      }
      case "root_bad_password": {
        const cooldown = Number(payload.cooldown_seconds ?? 0);
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
        const noteIds = payload.note_ids;
        const count = Array.isArray(noteIds) ? noteIds.length : 0;
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
      case "category_encrypted_keep":
        return { message: t("加密分组不能只删分组：请先「解密分组」，或在删除时选择同时删除组内笔记"), code };
      case "tags_encrypted":
        return { message: t("标签随笔记加密，不能直接修改"), code };
      case "backup_passphrase_too_short":
        return { message: t("备份口令至少 8 位"), code };
      case "backup_passphrase_too_long":
        return { message: t("备份口令最多 128 位"), code };
      case "bad_backup_passphrase":
        return { message: t("备份口令错误，或文件已损坏"), code };
      case "not_encrypted_backup":
        return { message: t("这不是 FastNote 加密备份文件"), code };
      default:
        // 新加的错误码还没收录：别把 JSON 漏到界面上
        return { message: t("操作失败，请重试"), code };
    }
  }

  const raw = errorText(error);
  return { message: raw && raw !== "{}" ? raw : t("操作失败，请重试"), code };
};
