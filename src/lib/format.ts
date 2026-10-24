/**
 * 展示层的数值格式化：体积与网速。
 *
 * 统一按 1024 进制；调用方负责决定保留几位小数。
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
