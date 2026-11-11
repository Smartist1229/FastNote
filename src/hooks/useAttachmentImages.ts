/**
 * 图片解析钩子：给编辑器准备同步的 `resolveImage`。
 *
 * 为什么要按内容懒查宽高：预览要按原始宽高提前占位，图片解码完才不会把行高撑开
 * （长文档滚动条会跳一下）。而 `resolveImage` 必须是同步的——异步查库会逼着预览
 * 为每张图处理 Promise。于是做法是：内容变化时批量查一次、写进模块级缓存，
 * 拿到新尺寸后 `version` 自增触发一次重渲染，之后渲染就都能同步命中缓存。
 */

import { useEffect, useMemo, useState } from "react";

import {
  extractAttachmentPaths,
  primeAttachmentMeta,
  resolveImageSource,
} from "@/lib/markdown/imageSrc";

export const useAttachmentImages = (content: string) => {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const paths = extractAttachmentPaths(content);
    if (paths.length === 0) return;
    let cancelled = false;
    void primeAttachmentMeta(paths)
      .then((filled) => {
        if (filled && !cancelled) setVersion((v) => v + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [content]);

  // version 只用来换函数身份：缓存变了要让预览重渲染一次；函数体本身是纯查表
  return useMemo(() => resolveImageSource, [version]);
};
