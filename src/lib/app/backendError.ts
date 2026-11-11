/**
 * 后端错误的统一解析层：把「带 code 的结构化错误」从任意 reject 值里取出来。
 *
 * Rust 侧 `err_code()`（`src-tauri/src/encryption.rs`）会 reject 一个 JSON 字符串：
 *   {"code":"bad_password","attempts":3,"root_allowed":true}
 * 调用方需要 code 与参数才能分支；普通字符串错误没有 code，返回 null 即可。
 *
 * 为什么单独一层：这套解析曾在 5 个地方各写一遍——
 *   - api 层用 JSON.parse 包一层自定义 Error；
 *   - `EncryptionDialogs` 在那层之上再 switch 出文案；
 *   - `RestoreDialog` 自己写 `raw.match(/"code"\s*:\s*"([^"]+)"/)`；
 *   - `useTrashState` 自己 JSON.parse 后比一个 code；
 *   - `useCategoriesState` 用 `raw.includes("category_encrypted_keep")`。
 * 最后那种最危险：错误消息正文里只要提到这个词就会被误判成该错误。
 *
 * 这里**只做解析、不做文案**。同一个 code 在不同场景需要不同措辞
 * （`category_encrypted` 在回收站是「请先解密再还原」、在移动笔记是「不能移入」），
 * 把文案固定在这一层反而会逼着调用方去拼接。通用文案见 `backendErrorMessage.ts`。
 */

/** 结构化错误的载荷：`code` 必有，其余字段由各命令自己定义 */
export interface BackendErrorPayload {
  code: string;
  [key: string]: unknown;
}

/** 只认「非数组的对象 + 非空字符串 code」 */
const asPayload = (value: unknown): BackendErrorPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== "string" || !code) return null;
  return value as BackendErrorPayload;
};

/**
 * 取出错误码与参数；不是结构化错误时返回 null。
 *
 * 三种来源都认：
 * - 已经是对象（有的调用方会先把 JSON 解析好再抛）；
 * - JSON 字符串（Rust `Err(json!({...}).to_string())` 的标准形态）；
 * - `Error.message` 里包着 JSON（被 `new Error(raw)` 包过一层的情况）。
 *
 * 先看首字符再 `JSON.parse`：普通中文错误消息不可能是合法 JSON，
 * 直接 try 会为每条错误付一次异常开销。
 */
export const parseBackendError = (error: unknown): BackendErrorPayload | null => {
  const direct = asPayload(error);
  if (direct) return direct;

  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : null;
  if (!text) return null;

  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asPayload(JSON.parse(trimmed));
  } catch {
    return null;
  }
};

/** 只要错误码；拿不到返回 null */
export const backendErrorCode = (error: unknown): string | null =>
  parseBackendError(error)?.code ?? null;

/**
 * 这个错误是不是给定的某几个 code 之一。
 * 替代 `raw.includes("xxx")` 那种写法：只比 code 字段，不受正文措辞影响。
 */
export const isBackendError = (error: unknown, ...codes: string[]): boolean => {
  const code = backendErrorCode(error);
  return code !== null && codes.includes(code);
};
