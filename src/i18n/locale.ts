export type AppLocale = "en-US" | "zh-CN";
export type AppLanguage = "system" | AppLocale;
export type TranslationParams = Record<string, string | number>;

export const normalizeLocale = (language: string | null | undefined): AppLocale =>
  /^zh(?:[-_]|$)/i.test(language ?? "") ? "zh-CN" : "en-US";

export const isAppLanguage = (value: unknown): value is AppLanguage =>
  value === "system" || value === "en-US" || value === "zh-CN";

export const resolveAppLocale = (language: AppLanguage, systemLanguage: string): AppLocale =>
  language === "system" ? normalizeLocale(systemLanguage) : language;

export const interpolate = (message: string, params: TranslationParams = {}): string =>
  message.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
