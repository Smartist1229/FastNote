/**
 * 设置 · 语义搜索：从本地目录导入自定义模型（内联表单）。
 *
 * 不另开弹窗：设置本身已经是弹窗，再叠一层会把整个设置界面压暗、离输入项太远。
 * 目录里必须有 `model.onnx` 与 `tokenizer.json`；维度、池化方式等元数据由用户填写，
 * 后端会复制文件并真实跑一次推理自检，填错直接报错，不会留下半成品目录。
 * 这里只做表单校验与目录选择，文件安全边界全部在 Rust 侧。
 */
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as semanticApi from "@/api/semantic";
import { Icon } from "@/components/common/Icon";
import { ProgressBar } from "@/components/common/ProgressBar";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const folderName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

interface CustomModelImportFormProps {
  onCancel: () => void;
  /** 导入成功后回调：父组件负责切换选中、刷新状态并提示 */
  onImported: (modelId: string, name: string) => void;
}

export const CustomModelImportForm: React.FC<CustomModelImportFormProps> = ({
  onCancel,
  onImported,
}) => {
  const [sourceDir, setSourceDir] = useState("");
  const [name, setName] = useState("");
  const [dim, setDim] = useState("768");
  const [maxTokens, setMaxTokens] = useState("512");
  const [pooling, setPooling] = useState<"cls" | "mean">("cls");
  const [minScore, setMinScore] = useState("0.35");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    if (busy) return;
    onCancel();
  };

  const pickFolder = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "选择包含 model.onnx 与 tokenizer.json 的目录",
      });
      if (typeof picked === "string") {
        setSourceDir(picked);
        if (!name.trim()) setName(folderName(picked));
        setError(null);
      }
    } catch (e) {
      setError(`无法打开目录选择器：${errorText(e)}`);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    const trimmedName = name.trim();
    if (!sourceDir.trim()) return setError("请先选择模型所在目录");
    if (!trimmedName) return setError("请填写模型名称");
    if (trimmedName.length > 60) return setError("模型名称不能超过 60 个字符");

    const parsedDim = Number(dim);
    if (!Number.isInteger(parsedDim) || parsedDim < 16 || parsedDim > 4096) {
      return setError("向量维度需为 16–4096 之间的整数");
    }
    const parsedTokens = Number(maxTokens);
    if (!Number.isInteger(parsedTokens) || parsedTokens < 8 || parsedTokens > 4096) {
      return setError("最大 token 数需为 8–4096 之间的整数");
    }
    const scoreRaw = minScore.trim();
    const parsedScore = scoreRaw === "" ? undefined : Number(scoreRaw);
    if (parsedScore !== undefined && (!Number.isFinite(parsedScore) || parsedScore < 0.05 || parsedScore > 0.95)) {
      return setError("相似度阈值需在 0.05–0.95 之间，留空则使用默认值 0.35");
    }

    setBusy(true);
    setError(null);
    try {
      const id = await semanticApi.importSemanticModel({
        sourceDir: sourceDir.trim(),
        name: trimmedName,
        dim: parsedDim,
        maxTokens: parsedTokens,
        pooling,
        minScore: parsedScore,
      });
      onImported(id, trimmedName);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const label = "text-[11px] font-medium text-body";
  const hint = "mt-0.5 text-[10px] leading-relaxed text-faint-soft";
  const field = "mt-1 w-full px-2.5 py-1.5 text-xs input-modern";

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-start justify-between gap-2 px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-body">导入本地模型</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
            复制并校验 ONNX 模型；源目录只读，不会移动或删除原文件。
          </p>
        </div>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          title="收起导入表单"
          className="toolbar-btn hover:!bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="modal-close" className="w-3.5 h-3.5" />
        </button>
      </div>

      <form className="space-y-3 border-t border-line-soft px-3.5 py-3" onSubmit={submit}>
        <div>
          <div className="flex items-end justify-between gap-2">
            <span className={label}>模型目录</span>
            <button
              type="button"
              onClick={() => void pickFolder()}
              disabled={busy}
              className="flex flex-shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-body transition-colors hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sidebar-folder" className="w-3 h-3" />
              选择文件夹
            </button>
          </div>
          <p className={`mt-1 break-all font-mono text-[10px] leading-relaxed ${sourceDir ? "text-body" : "text-faint-soft"}`}>
            {sourceDir || "尚未选择"}
          </p>
          <p className={hint}>
            目录内需包含 model.onnx 与 tokenizer.json（单文件模型，暂不支持外部权重文件）。出于安全考虑，自定义模型只从本地目录导入，不直接抓取网络链接。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="custom-model-name">名称</label>
            <input
              id="custom-model-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              spellCheck={false}
              placeholder="例如：我的领域模型"
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="custom-model-score">相似度阈值（可选）</label>
            <input
              id="custom-model-score"
              type="number"
              min={0.05}
              max={0.95}
              step={0.01}
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              className={field}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="custom-model-dim">向量维度</label>
            <input
              id="custom-model-dim"
              type="number"
              min={16}
              max={4096}
              value={dim}
              onChange={(e) => setDim(e.target.value)}
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="custom-model-tokens">最大 token 数</label>
            <input
              id="custom-model-tokens"
              type="number"
              min={8}
              max={4096}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              className={field}
            />
          </div>
        </div>

        <div>
          <span className={label}>池化方式</span>
          <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="池化方式">
            {(
              [
                { value: "cls", title: "CLS", desc: "BGE 等" },
                { value: "mean", title: "Mean", desc: "MiniLM 等" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={pooling === option.value}
                onClick={() => setPooling(option.value)}
                className={`flex flex-1 items-center justify-between rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors ${
                  pooling === option.value
                    ? "border-primary-300 bg-primary-50 text-primary-600"
                    : "border-line text-body hover:bg-surface-alt"
                }`}
              >
                <span className="font-medium">{option.title}</span>
                <span className="text-[10px] text-faint">{option.desc}</span>
              </button>
            ))}
          </div>
          <p className={hint}>取首 token 用 CLS，对有效 token 求平均用 Mean；填错会在校验时直接报错。阈值留空时使用默认值 0.35。</p>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-warning-line/60 bg-warning-soft px-3 py-2.5">
          <Icon name="ai-warning" className="w-3.5 h-3.5 text-warning mt-[1px] flex-shrink-0" />
          <p className="text-[11px] leading-relaxed text-warning">
            请只导入可信来源的模型文件。ONNX 由本地推理库解析，损坏或恶意的文件可能导致应用崩溃；导入过程不联网。
          </p>
        </div>

        {error && (
          <p className="selectable break-all rounded-lg border border-danger-line/60 bg-danger-soft px-2.5 py-2 text-[11px] leading-relaxed text-danger">
            {error}
          </p>
        )}

        {busy && (
          <div className="rounded-lg border border-line bg-app px-2.5 py-2">
            <ProgressBar value={null} label="正在复制并校验模型…" showPercent={false} />
            <p className="mt-1 text-[10px] leading-relaxed text-faint-soft">
              会用填写的维度与池化方式真实嵌入一句话；模型较大时可能需要几秒。
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="sidebar-folder-plus" className="w-3.5 h-3.5" />
            {busy ? "正在导入…" : "导入"}
          </button>
        </div>
      </form>
    </div>
  );
};
