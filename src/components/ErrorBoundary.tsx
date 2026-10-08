import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界。
 * React 在渲染期抛错时会卸载整棵树——表现就是"页面上什么都没了"（#root 变空）。
 * 有了这层兜底，至少能显示错误信息并提供重载/继续入口，而不是黑屏。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染出错：", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-lg w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <h1 className="text-base font-semibold text-slate-800 mb-2">界面遇到了一个错误</h1>
          <p className="text-sm text-slate-500 leading-relaxed mb-4">
            数据都还在，没有丢失。可以先尝试重载；如果反复出现，把下面的信息反馈一下。
          </p>
          <pre className="mb-4 max-h-40 overflow-auto rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-[11px] leading-relaxed text-red-500 whitespace-pre-wrap break-all">
            {String(error?.stack || error?.message || error)}
          </pre>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-3 py-1.5 text-xs font-medium text-slate-500 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
            >
              收起
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 transition-colors"
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
