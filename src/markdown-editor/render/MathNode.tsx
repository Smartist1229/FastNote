/**
 * 公式渲染节点。
 *
 * KaTeX 是可选依赖：加载失败或语法错误时退回显示原文（行内用 `<code>`，块级用 `<pre>`），
 * 保证「能读到内容」永远优先于「排版好看」。
 */
import { useEffect, useState } from "react";
import { renderMath } from "./highlight";

/** 行内公式 */
export const MathInline: React.FC<{ code: string; enabled: boolean }> = ({ code, enabled }) => {
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (!enabled) {
      setHtml("");
      return;
    }
    let alive = true;
    renderMath(code, false).then((result) => {
      if (alive && result && result.html) setHtml(result.html);
    });
    return () => {
      alive = false;
    };
  }, [code, enabled]);

  if (!enabled || !html) return <code className="mde-inline-math">{code}</code>;
  return <span className="mde-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
};

/** 块级公式 */
export const MathBlock: React.FC<{ code: string; enabled: boolean }> = ({ code, enabled }) => {
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (!enabled) {
      setHtml("");
      return;
    }
    let alive = true;
    renderMath(code, true).then((result) => {
      if (alive && result && result.html) setHtml(result.html);
    });
    return () => {
      alive = false;
    };
  }, [code, enabled]);

  if (!enabled || !html) return <pre className="mde-math-fallback">{code}</pre>;
  return <div className="mde-math-block" dangerouslySetInnerHTML={{ __html: html }} />;
};
