/** 公式渲染失败时保留源码；只本地化错误提示，不改公式本身。 */
import { useEffect, useState } from "react";
import { LABELS } from "../locales";
import { renderMath } from "./highlight";

interface MathProps {
  code: string;
  enabled: boolean;
  errorLabel?: string;
}

const useMath = (code: string, enabled: boolean, displayMode: boolean) => {
  const [result, setResult] = useState<{ code: string; html: string; failed: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    renderMath(code, displayMode).then((next) => {
      if (alive) setResult({ code, html: next?.html ?? "", failed: !next?.html });
    });
    return () => { alive = false; };
  }, [code, enabled, displayMode]);
  return enabled && result?.code === code ? result : null;
};

export const MathInline: React.FC<MathProps> = ({ code, enabled, errorLabel = LABELS["en-US"].mathRenderFailed }) => {
  const result = useMath(code, enabled, false);
  if (!result?.html) return <code className="mde-inline-math" title={result?.failed ? errorLabel : undefined}>{code}</code>;
  return <span className="mde-math-inline" dangerouslySetInnerHTML={{ __html: result.html }} />;
};

export const MathBlock: React.FC<MathProps> = ({ code, enabled, errorLabel = LABELS["en-US"].mathRenderFailed }) => {
  const result = useMath(code, enabled, true);
  if (!result?.html) return <pre className="mde-math-fallback" title={result?.failed ? errorLabel : undefined}>{code}</pre>;
  return <div className="mde-math-block" dangerouslySetInnerHTML={{ __html: result.html }} />;
};
