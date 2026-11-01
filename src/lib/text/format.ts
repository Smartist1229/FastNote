/**
 * 展示层的格式化：体积、网速与日期时间。
 *
 * 体积与网速统一按 1024 进制；调用方负责决定保留几位小数。
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 字节数 → 可读体积，如 `23.3 MB`；非法值按 0 处理 */
export const formatBytes = (bytes: number, fractionDigits = 1): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : fractionDigits)} ${UNITS[unit]}`;
};

/** 每秒字节数 → `1.2 MB/s` */
export const formatSpeed = (bytesPerSecond: number): string =>
  `${formatBytes(bytesPerSecond)}/s`;

/** 毫秒 → `时:分:秒`，如 `01:23:45`；不足一小时也补齐小时位，宽度稳定不跳动 */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
};

/** ISO 时间 → 当前语言的日期时间；空值显示破折号，无法解析时原样返回 */
export const formatDateTime = (value: string | null, locale: string): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};
