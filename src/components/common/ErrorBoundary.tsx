import { Component, ErrorInfo } from "react";
import type { ErrorBoundaryProps, ErrorBoundaryState } from "@/interface/ui";

/**
 * 顶层错误边界：包住整棵界面树。
 * React 渲染期抛错会卸载整棵树，没有这层兜底就是一片空白；这里改为显示错误栈并给出两个出口。
 *
 * 能力边界：只拦渲染与生命周期里的异常，事件回调、Promise 中的错误仍需调用方自行 try/catch。
 * 「收起」只是把 error 置空后重新渲染子树，错误源还在就会立刻再次抛错。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** 有值即渲染兜底界面；null 表示正常渲染 children */
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  /** 保留组件栈打到控制台：界面上只显示 error.stack，定位仍更依赖这里 */
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染出错：", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-screen w-full flex items-center justify-center bg-app p-6">
        <div className="max-w-lg w-full bg-surface rounded-2xl border border-line shadow-sm p-6">
          <h1 className="text-base font-semibold text-ink mb-2">界面遇到了一个错误</h1>
          <p className="text-sm text-muted leading-relaxed mb-4">
            数据都还在，没有丢失。可以先尝试重载；如果反复出现，把下面的信息反馈一下。
          </p>
          <pre className="mb-4 max-h-40 overflow-auto rounded-xl bg-app border border-line-soft px-3 py-2 text-[11px] leading-relaxed text-danger whitespace-pre-wrap break-all">
            {String(error?.stack || error?.message || error)}
          </pre>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-3 py-1.5 text-xs font-medium text-muted bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors"
            >
              收起
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 text-xs font-medium text-on-accent bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors"
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
