/**
 * 笔记 / 分组加密的类型。
 *
 * 数据库里加密项的正文、标签、历史版本是密文；标题保持明文（方便查找与识别）。
 * 未解锁时后端只返回空正文，因此前端任何列表都拿不到正文明文。
 * 字段名与 Rust 侧 EncryptionStatus / encryption_info 对齐。
 */

/** 加密单元：单篇笔记或整个分组 */
export type EncryptionScope = "note" | "category";

/**
 * 临时解锁的存活范围：
 * - session：本次运行内保持解锁，切走/收起不主动锁（仍可在右键手动锁定）
 * - once：读完即锁，下次打开需要重新输入
 */
export type UnlockScope = "session" | "once";

/** encryption_status 的返回值 */
export interface EncryptionStatus {
  /** 是否已设置根密码（未设置时启动必须引导设置） */
  root_set: boolean;
  /** 本次运行内是否已校验过根密码（KEK 缓存，仅内存） */
  root_cached: boolean;
  /** 加密的笔记数（含分组整体加密） */
  encrypted_notes: number;
  /** 加密的分组数 */
  encrypted_categories: number;
}

/** encryption_info 的返回值：右侧属性窗与解锁弹窗共用 */
export interface EncryptionInfo {
  scope: EncryptionScope;
  encrypted: boolean;
  is_locked: boolean;
  /** 用户设置的密码提示，可能为空 */
  hint: string | null;
  /** 根密码是否能恢复这一项（早期数据可能没有根包裹） */
  root_wrapped: boolean;
  /** 条目密码已连续输错次数 */
  attempts: number;
  /** 错满 3 次后是否允许改用根密码 */
  root_allowed: boolean;
  root_set: boolean;
  root_cached: boolean;
  /** 根密码当前的派生产法：pbkdf2-sha256（旧）| argon2id */
  kdf: string;
}

/**
 * 启动自检结果。后端只在能确定推断时修复，其余分类都只是报告：
 * - repaired：正文是密文、密钥还在、但加密标志丢了（刷新后「加密状态消失」的那一类），已自动改正
 * - missing_keys / missing_category_keys：标了加密却找不到密钥，数据无法解密（如恢复了不完整备份）
 * - orphan_keys：有密钥但笔记已不是加密态，可能是解密中断留下的残渣
 * - content_mismatch：标了加密但正文不是密文，被外部工具改过库或解密中途异常
 */
export interface EncryptionSelfCheckReport {
  repaired: number[];
  missing_keys: number[];
  missing_category_keys: number[];
  orphan_keys: number[];
  content_mismatch: number[];
}

/** 后端用 JSON 字符串拒绝时携带的错误码 */
export interface EncryptionErrorPayload {
  code: string;
  reason?: string;
  attempts?: number;
  required?: number;
  cooldown_seconds?: number;
  note_ids?: number[];
}
