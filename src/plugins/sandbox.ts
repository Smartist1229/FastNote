/**
 * 插件沙箱（第一步：运行时骨架）。
 *
 * 做法：把插件的 main.js 放进一个**独立源**的隐藏 iframe（`fastnote-plugin://<目录名>/__runtime.html`）。
 * 这个源里没有 `__TAURI_INTERNALS__`，也不能访问父页面对象，所以插件拿不到 IPC、读不到宿主 DOM /
 * localStorage——它想干什么都只能 postMessage 申请，由这里按「这个 iframe 属于哪个插件」复核后执行。
 *
 * 和「插件窗口」用的是同一套思路，区别在于：插件窗口是用户能看到的，这里是隐藏的运行容器。
 *
 * 第一步开放的 ctx 能力：config / db / fs / net / notes / editor.insertText / ui.toast /
 * shortcut / i18n / onDispose。菜单、命令、工具栏、钩子、AI、设置分区、ui.modal、ui.mount
 * 需要改成声明式贡献，留到第二步。
 */
import type { PluginManifest } from "@/interface/system/plugins";
import { getLocale } from "@/i18n";
import * as pluginsApi from "@/api/system/plugins";
import type { PluginContext } from "./types";

/** 运行时页面在插件目录内的保留路径（由 Rust 侧内置提供，插件覆盖不了） */
export const SANDBOX_RUNTIME_PATH = "__runtime.html";

/** 生命周期钩子：沙箱侧的方法名 → 宿主 ctx.hooks 的方法名 */
const HOOK_METHODS: Record<string, "onNoteCreate" | "onNoteSave" | "onNoteDelete" | "onNoteSwitch"> = {
  "note-create": "onNoteCreate",
  "note-save": "onNoteSave",
  "note-delete": "onNoteDelete",
  "note-switch": "onNoteSwitch",
};

export interface PluginSandbox {
  /** iframe 的源（用于 postMessage 校验，也是排查问题的凭据） */
  origin: string;
  /** 关掉沙箱：移除 iframe、摘掉监听；插件自己注册的宿主资源由 host 的 dispose 统一清 */
  dispose: () => void;
  /** 把事件派发给沙箱（快捷键等宿主侧触发的能力用） */
  emit: (event: string, payload?: unknown) => void;
}

interface SandboxOptions {
  dirName: string;
  manifest: PluginManifest;
  entry: string;
  /** 第几次激活：拼进入口 URL，保证重新激活拿到新代码 */
  version: number;
  /** 宿主编好的上下文（权限守卫都在里面），沙箱只是它的 RPC 前端 */
  ctx: PluginContext;
  /** 该插件的语言包（已按当前语言选好） */
  messages: Record<string, unknown>;
  /** 插件加载失败时回调：由宿主挂到 entry.error 上 */
  onFail: (message: string) => void;
  /** 关闭当前弹窗（沙箱插件在 content 回调里调 api.close/ok/cancel 时用） */
  resolveModal: (ok: boolean, value?: unknown) => void;
}

/** 沙箱启动超时：超过这个时间没 ready 就当失败，别让启动卡死 */
const READY_TIMEOUT_MS = 15000;

/**
 * 启动一个插件的沙箱。
 * 成功 = 插件的 activate() 在 iframe 里跑完；失败会 reject（宿主记 entry.error）。
 */
export const startPluginSandbox = async (options: SandboxOptions): Promise<PluginSandbox> => {
  const { dirName, entry, version, ctx, messages, onFail, resolveModal } = options;

  const runtimeUrl = await pluginsApi.pluginModuleUrl(dirName, SANDBOX_RUNTIME_PATH, version);
  const origin = new URL(runtimeUrl).origin;
  const query = new URLSearchParams({ dir: dirName, entry, v: String(version) });
  const src = `${runtimeUrl}?${query.toString()}`;

  const frame = document.createElement("iframe");
  frame.dataset.pluginSandbox = dirName;
  // 用 sandbox 属性再收紧一层：不给 top-navigation、弹窗、表单，脚本和自己的存储照旧
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;";
  frame.src = src;

  let disposed = false;

  /** 统一的回包 */
  const reply = (id: string, payload: { result?: unknown; error?: string }): void => {
    frame.contentWindow?.postMessage({ __fastnotePluginReply: id, ...payload }, origin);
  };

  /** 反向调用：加载完成后每个挂起的 callId 对应一个 Promise 收尾 */
  const invocations = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let invokeSeq = 0;

  /** 去掉函数 / DOM：跨 iframe 只能传可克隆数据 */
  const cloneSafe = (value: unknown): unknown => {
    if (typeof value === "function") return undefined;
    if (typeof Node !== "undefined" && value instanceof Node) return null;
    if (Array.isArray(value)) return value.map(cloneSafe);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = cloneSafe(inner);
      }
      return out;
    }
    return value;
  };

  /** 沙箱传来的 { __fn: id } → 一个可 await 的宿主函数 */
  const revive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.__fn === "string") {
        return (...args: unknown[]) => invoke(obj.__fn as string, args);
      }
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(obj)) {
        // when 是同步判定，跨 iframe 无法回调：丢弃并提示改用声明式条件
        if (
          key === "when" &&
          inner &&
          typeof inner === "object" &&
          typeof (inner as Record<string, unknown>).__fn === "string"
        ) {
          console.warn("[插件沙箱] when 不支持函数，请改用 { field, is } 声明式条件");
          continue;
        }
        out[key] = revive(inner);
      }
      return out;
    }
    return value;
  };

  /** 宿主 → 沙箱的反向调用（贡献点回调都走这里） */
  const invoke = (id: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const callId = `i${++invokeSeq}`;
      invocations.set(callId, { resolve, reject });
      frame.contentWindow?.postMessage(
        { __fastnoteInvoke: callId, id, args: args.map(cloneSafe) },
        origin,
      );
      setTimeout(() => {
        if (!invocations.has(callId)) return;
        invocations.delete(callId);
        reject(new Error("插件回调没有响应（15s）"));
      }, 15000);
    });

  /** ui.mount 的句柄表：token → 移除函数（函数不能跨 iframe 传，用 token 代替） */
  const mounts = new Map<string, () => void>();
  let mountSeq = 0;

  /** 调用某个能力组：ctx.db.insert → ctx.db.insert(...args) */
  const dispatch = async (op: string, args: unknown[]): Promise<unknown> => {
    const [group, method] = op.split(".");
    if (!method) throw new Error(`沙箱请求格式不对：${op}`);
    const bucket = (ctx as unknown as Record<string, Record<string, unknown>>)[group];

    // 弹窗里的 api.close / ok / cancel：宿主关掉当前这个弹窗
    if (op === "ui.modal.action") {
      const action = String(args[0] ?? "");
      resolveModal(action !== "cancel", args[1]);
      return null;
    }

    // 弹窗：沙箱只能交 HTML 字符串，这里把 content 归一成 html，按钮去掉函数
    if (op === "ui.modal") {
      const raw = (args[0] ?? {}) as Record<string, unknown>;
      const html =
        typeof raw.html === "string"
          ? raw.html
          : typeof raw.content === "string"
            ? raw.content
            : undefined;
      const buttons = Array.isArray(raw.buttons)
        ? raw.buttons.map((button) => {
            const item = (button ?? {}) as Record<string, unknown>;
            return { label: String(item.label ?? ""), danger: item.danger === true };
          })
        : undefined;
      const { content: _content, ...rest } = raw;
      return await ctx.ui.modal({ ...(rest as object), html, buttons } as never);
    }

    // 钩子：沙箱传 [hook 名, 函数]，宿主按名字订阅
    if (op === "hooks.subscribe") {
      const hookName = HOOK_METHODS[String(args[0] ?? "")];
      const handler = revive(args[1]);
      if (!hookName || typeof handler !== "function") {
        throw new Error(`未知的钩子：${String(args[0] ?? "")}`);
      }
      (ctx.hooks[hookName] as (fn: unknown) => void)(handler);
      return null;
    }

    // 往宿主页面插一段 HTML：token 换掉函数句柄
    if (op === "ui.mount") {
      const [target, html] = args as [string, string];
      const host =
        typeof target === "string" ? document.querySelector(target) : null;
      if (!host) throw new Error(`挂载点不存在：${String(target)}`);
      const holder = document.createElement("div");
      holder.className = "plugin-mount";
      holder.dataset.pluginMount = dirName;
      // 消毒后由宿主插入（插件不能直接把脚本塞进主页面）
      const { sanitizePluginHtml } = await import("./sanitize");
      holder.innerHTML = sanitizePluginHtml(String(html ?? ""));
      const nodes = [...holder.childNodes];
      for (const node of nodes) host.appendChild(node);
      const token = `m${++mountSeq}`;
      mounts.set(token, () => {
        for (const node of nodes) node.parentNode?.removeChild(node);
      });
      return token;
    }

    if (op === "ui.unmount") {
      mounts.get(String(args[0] ?? ""))?.();
      mounts.delete(String(args[0] ?? ""));
      return null;
    }

    // 总线：宿主既要替插件发，也要把别人的消息推回沙箱
    if (op === "bus.subscribe") {
      const topic = String(args[0] ?? "");
      ctx.bus.on(topic, (payload, from) => {
        frame.contentWindow?.postMessage(
          { __fastnoteEvent: `bus:${topic}`, payload: { payload, from } },
          origin,
        );
      });
      return null;
    }
    if (op === "bus.emit") {
      ctx.bus.emit(String(args[0] ?? ""), args[1]);
      return null;
    }

    /*
     * 贡献点：宿主调用这些回调时只会传「数据参数」（note / 上下文对象），
     * 沙箱侧的回调需要自己的 ctx，所以这里按类型决定回传几个参数：
     *   first → 传第一个参数（note / AI 工具入参）
     *   none  → 不传（命令、工具栏、模态按钮），沙箱把 ctx 补在最后
     */
    const rebuild = (node: unknown, mode: "first" | "none"): unknown => {
      if (Array.isArray(node)) return node.map((item) => rebuild(item, mode));
      if (!node || typeof node !== "object") return node;
      const source = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === "object" && typeof (value as Record<string, unknown>).__fn === "string") {
          const fnId = String((value as Record<string, unknown>).__fn);
          if (key === "when") {
            console.warn("[插件沙箱] when 不支持函数，请改用 { field, is } 声明式条件");
            continue;
          }
          if (key === "onClick" || key === "run" || key === "execute") {
            out[key] = (...params: unknown[]) =>
              invoke(fnId, mode === "first" ? params.slice(0, 1) : []);
            continue;
          }
          continue;
        }
        out[key] = rebuild(value, mode);
      }
      return out;
    };

    if (op === "menu.note" || op === "menu.group") {
      const registerMenu = op === "menu.note" ? ctx.menu.note : ctx.menu.group;
      registerMenu(rebuild(args[0], "first") as never);
      return null;
    }
    if (op === "command.register") {
      ctx.command(rebuild(args[0], "none") as never);
      return null;
    }
    if (op === "editor.toolbar") {
      // 工具栏回调第一个参数是编辑器上下文（content / title 可克隆），insertText 走沙箱 ctx
      ctx.editor.toolbar(rebuild(args[0], "first") as never);
      return null;
    }
    if (op === "ai.tool") {
      ctx.ai.tool(rebuild(args[0], "first") as never);
      return null;
    }
    if (op === "ai.provider") {
      ctx.ai.provider(revive(args[0]) as never);
      return null;
    }
    if (op === "settings.section") {
      ctx.settings.section(revive(args[0]) as never);
      return null;
    }

    const fn = bucket?.[method];
    if (typeof fn !== "function") throw new Error(`插件 API 不存在：${op}`);
    return await (fn as (...params: unknown[]) => unknown).apply(bucket, args.map(revive));
  };

  const handleMessage = async (event: MessageEvent): Promise<void> => {
    if (disposed) return;
    // 只认自己这个 iframe、自己的源：别的窗口 / 别的插件发的一概不理
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== origin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    // 启动完成：插件 activate 已经跑完
    if (data.__fastnotePluginReady === dirName) {
      readyResolve();
      return;
    }

    // 插件回调的返回值
    if (typeof data.__fastnoteInvokeReply === "string") {
      const pending = invocations.get(data.__fastnoteInvokeReply);
      if (!pending) return;
      invocations.delete(data.__fastnoteInvokeReply);
      if (data.error) pending.reject(new Error(String(data.error)));
      else pending.resolve(data.result ?? null);
      return;
    }

    const id = data.__fastnotePluginCall;
    if (typeof id !== "string") return;
    const op = String(data.op ?? "");
    const args = Array.isArray(data.args) ? (data.args as unknown[]) : [];

    try {
      if (op === "__init") {
        reply(id, {
          result: { config: ctx.config.values, locale: getLocale(), messages },
        });
        return;
      }
      if (op === "__fail") {
        const message = String(args[0] ?? "插件运行失败");
        onFail(message);
        readyReject(new Error(message));
        return;
      }
      if (op === "shortcut.register") {
        const combo = String(args[0] ?? "");
        /*
         * 插件只能注册窗口内快捷键：系统全局热键由宿主独占。
         * 这里显式回错而不是让宿主的注册函数抛——沙箱是跨文档 RPC，
         * 明确一条 "不能注册全局热键" 比插件端看到一个泛化的失败更容易定位。
         */
        const options = (args[1] ?? {}) as { scope?: "app" | "global" };
        if (options.scope === "global") {
          reply(id, { error: "插件不能注册系统全局快捷键，只能注册窗口内快捷键（scope 固定为 app）" });
          return;
        }
        ctx.shortcut.register(
          combo,
          () => {
            frame.contentWindow?.postMessage(
              { __fastnoteEvent: `shortcut:${combo}`, payload: null },
              origin,
            );
          },
          { scope: "app" },
        );
        reply(id, { result: null });
        return;
      }
      if (op === "shortcut.unregister") {
        ctx.shortcut.unregister(String(args[0] ?? ""));
        reply(id, { result: null });
        return;
      }
      const result = await dispatch(op, args);
      reply(id, { result: result ?? null });
    } catch (error) {
      reply(id, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** window 的 message 监听：事件处理内部是异步的，这里用同步壳包一层，方便摘监听 */
  const onMessage = (event: MessageEvent): void => {
    void handleMessage(event);
  };

  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(() => {
    readyReject(new Error("插件沙箱启动超时（15s 内没有 ready）"));
  }, READY_TIMEOUT_MS);

  window.addEventListener("message", onMessage);
  document.body.appendChild(frame);

  try {
    await ready;
  } catch (error) {
    // 启动失败：把 iframe 撤掉，别留一个半死不活的容器
    window.removeEventListener("message", onMessage);
    frame.remove();
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return {
    origin,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const off of mounts.values()) {
        try {
          off();
        } catch {
          // 忽略：节点可能已经被宿主清掉
        }
      }
      mounts.clear();
      frame.remove();
    },
    emit: (event, payload) => {
      if (disposed) return;
      frame.contentWindow?.postMessage({ __fastnoteEvent: event, payload }, origin);
    },
  };
};
