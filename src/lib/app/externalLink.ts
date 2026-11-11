/**
 * 外部链接的统一出口：按「设置 → 通用 → 链接打开方式」决定去哪打开。
 *
 * 设置值放在模块里而不是 React Context：编辑器、AI 回复、关于页这些消费方
 * 都在事件回调里打开链接，拿不到 props 也不该为它重渲染。
 * App 读回设置后调用 setLinkOpenTarget 同步一次，未同步前按系统浏览器处理。
 *
 * 内置浏览器只能接受 http(s)（或可补全的域名 / 搜索词），mailto:、obsidian:
 * 这类协议会失败——此时回退系统浏览器，避免点一下没反应。
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { openInAppBrowser } from "@/api/system/browser";
import type { LinkOpenTarget } from "@/interface/settings/settings";

let target: LinkOpenTarget = "system";

export const setLinkOpenTarget = (value: LinkOpenTarget) => {
  target = value;
};

export const openExternalLink = async (url: string): Promise<void> => {
  if (target === "app") {
    try {
      await openInAppBrowser(url);
      return;
    } catch (e) {
      console.error("软件内打开链接失败，改用默认浏览器：", e);
    }
  }
  await openUrl(url);
};
