import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { appMessages } from "./appMessages";
import { coreMessages } from "./coreMessages";
import { settingsMessages } from "./settingsMessages";
import { aiMessages } from "./aiMessages";
import { encryptionMessages } from "./encryptionMessages";
import { interpolate, isAppLanguage, resolveAppLocale } from "./locale";
import type { AppLanguage, AppLocale, TranslationParams } from "./locale";

export type { AppLanguage, AppLocale, TranslationParams } from "./locale";

const messages: Record<string, string> = {
  ...coreMessages,
  ...settingsMessages,
  ...aiMessages,
  ...appMessages,
  ...encryptionMessages,
};
const CACHE_KEY = "fastnote.language";

export const readCachedLanguage = (): AppLanguage => {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    return isAppLanguage(value) ? value : "system";
  } catch {
    return "system";
  }
};

let language = readCachedLanguage();
let systemLanguage = typeof navigator === "undefined" ? "en-US" : navigator.language;
let locale = resolveAppLocale(language, systemLanguage);
const listeners = new Set<() => void>();

export const getLocale = (): AppLocale => locale;

export const translate = (source: string, params?: TranslationParams, target: AppLocale = locale): string =>
  interpolate(
    target === "en-US" && Object.prototype.hasOwnProperty.call(messages, source) ? messages[source] : source,
    params,
  );

export const t = (source: string, params?: TranslationParams): string => translate(source, params);

const applyLocale = () => {
  const next = resolveAppLocale(language, systemLanguage);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === locale) return;
  locale = next;
  listeners.forEach((listener) => listener());
};

export const setLanguage = (next: AppLanguage) => {
  language = next;
  try {
    localStorage.setItem(CACHE_KEY, next);
  } catch {
    // SQLite remains authoritative when the startup cache is unavailable.
  }
  applyLocale();
  if (next === "system") void refreshSystemLanguage();
};

const refreshSystemLanguage = async () => {
  let detected = typeof navigator === "undefined" ? "en-US" : navigator.language;
  if (isTauri()) {
    detected = (await invoke<string | null>("get_system_locale").catch(() => null)) ?? detected;
  }
  systemLanguage = detected;
  applyLocale();
};

const onSystemLanguageChange = () => {
  if (language === "system") void refreshSystemLanguage();
};

const subscribe = (listener: () => void) => {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("languagechange", onSystemLanguageChange);
    window.addEventListener("focus", onSystemLanguageChange);
    void refreshSystemLanguage();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("languagechange", onSystemLanguageChange);
      window.removeEventListener("focus", onSystemLanguageChange);
    }
  };
};

const translators = {
  "zh-CN": (source: string, params?: TranslationParams) => translate(source, params, "zh-CN"),
  "en-US": (source: string, params?: TranslationParams) => translate(source, params, "en-US"),
};

export const useI18n = () => {
  const current = useSyncExternalStore(subscribe, getLocale, getLocale);
  return { locale: current, t: translators[current] };
};

applyLocale();
