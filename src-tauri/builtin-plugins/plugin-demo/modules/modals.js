/**
 * Modal 演示模块：宿主统一风格弹窗的全部扩展能力——
 * 模态 / 非模态浮层、自定义内容函数（PluginModalApi）、自定义按钮数组。
 * 贡献形式：一个笔记右键菜单项 + 四个命令面板命令。
 * 所有用户可见文案都通过 ctx.i18n 取值。
 */
import { fmtDuration } from "./utils.js";

/** 笔记右键菜单里的确认删除演示项（danger 样式） */
const registerConfirmDeleteMenu = (ctx) => {
  ctx.menu.note({
    id: "plugin-demo.confirm-delete",
    label: ctx.i18n.t("modal.menuLabel"),
    icon: "ai-trash",
    danger: true,
    onClick: async (_note, c) => {
      const tr = c.i18n.t;
      const result = await c.ui.modal({
        title: tr("modal.confirmTitle"),
        content: tr("modal.confirmContent"),
        confirmText: tr("modal.confirmButton"),
        cancelText: tr("modal.cancelButton"),
        danger: true,
      });
      c.ui.toast(
        tr(result && result.ok ? "modal.confirmedToast" : "modal.canceledToast"),
        result && result.ok ? "success" : "info",
      );
    },
  });
};

/** 命令面板里的四个 Modal 演示命令 */
const registerModalCommands = (ctx) => {
  const t = (key, vars) => ctx.i18n.t(key, vars);

  // 基础确认框
  ctx.command({
    id: "plugin-demo.modal-basic",
    label: t("modal.basicCommand"),
    icon: "ai-edit",
    run: async (c) => {
      const tr = c.i18n.t;
      const result = await c.ui.modal({
        title: tr("modal.basicTitle"),
        content: tr("modal.basicContent"),
        confirmText: tr("modal.basicConfirm"),
        cancelText: tr("modal.basicCancel"),
      });
      c.ui.toast(
        tr(result && result.ok ? "modal.basicConfirmToast" : "modal.basicCancelToast"),
        result && result.ok ? "success" : "info",
      );
    },
  });

  // 非模态浮层
  ctx.command({
    id: "plugin-demo.modal-nonmodal",
    label: t("modal.nonModalCommand"),
    icon: "ai-monitor",
    run: async (c) => {
      const tr = c.i18n.t;
      c.ui.toast(tr("modal.nonModalInfo"), "info");
      const t0 = Date.now();
      const result = await c.ui.modal({
        title: tr("modal.nonModalTitle"),
        content: tr("modal.nonModalContent"),
        mode: "non-modal",
        confirmText: tr("modal.nonModalConfirm"),
        cancelText: tr("modal.nonModalCancel"),
      });
      const elapsed = fmtDuration(Date.now() - t0);
      const label = tr(
        result && result.ok ? "modal.nonModalConfirmToast" : "modal.nonModalCancelToast",
      );
      c.ui.toast(
        tr("modal.nonModalResult", { label, elapsed }),
        result && result.ok ? "success" : "info",
      );
    },
  });

  // 自定义内容（content 函数 + PluginModalApi：输入框 + 自定义按钮）
  ctx.command({
    id: "plugin-demo.modal-input",
    label: t("modal.inputCommand"),
    icon: "ai-sparkles",
    run: async (c) => {
      const tr = c.i18n.t;
      /** content 渲染时保存 api，供自定义按钮读取输入值后主动结算 */
      let modalApi = null;
      let inputEl = null;
      const result = await c.ui.modal({
        title: tr("modal.inputTitle"),
        content: (api) => {
          modalApi = api;
          const wrap = document.createElement("div");
          wrap.innerHTML =
            '<p style="margin:0 0 8px;color:#666;font-size:13px"></p>' +
            '<input id="plugin-demo-name-input" style="width:100%;padding:8px 12px;border:1px solid #d4d4d4;border-radius:6px;box-sizing:border-box;font-size:14px" />';
          wrap.querySelector("p").textContent = tr("modal.inputHint");
          const input = wrap.querySelector("#plugin-demo-name-input");
          input.placeholder = tr("modal.inputPlaceholder");
          inputEl = input;
          // Enter = api.ok(输入值)，Esc = api.cancel()
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") api.ok(input.value.trim() || tr("modal.inputAnonymous"));
            else if (e.key === "Escape") api.cancel();
          });
          return wrap;
        },
        buttons: [
          {
            label: tr("modal.cancelButton"),
            onClick: () => {
              modalApi?.cancel();
              return false;
            },
          },
          {
            label: tr("modal.inputHello"),
            onClick: () => {
              const value = inputEl?.value?.trim() || tr("modal.inputAnonymous");
              modalApi?.ok(value);
              return false;
            },
          },
        ],
      });
      if (result && result.ok) {
        c.ui.toast(tr("modal.inputToast", { name: result.value ?? tr("modal.inputAnonymous") }), "success");
      } else {
        c.ui.toast(tr("modal.inputCanceled"), "info");
      }
    },
  });

  // 自定义按钮数组（三按钮 + danger 样式）
  ctx.command({
    id: "plugin-demo.modal-buttons",
    label: t("modal.buttonsCommand"),
    icon: "ai-warning",
    run: async (c) => {
      const tr = c.i18n.t;
      const result = await c.ui.modal({
        title: tr("modal.buttonsTitle"),
        content: tr("modal.buttonsContent"),
        buttons: [
          { label: tr("modal.buttonsRed"), danger: true, onClick: () => true },
          { label: tr("modal.buttonsYellow"), danger: false, onClick: () => true },
          { label: tr("modal.buttonsBlue"), danger: false, onClick: () => true },
        ],
      });
      c.ui.toast(
        tr(result && result.ok ? "modal.buttonsSelected" : "modal.buttonsCanceled"),
        result && result.ok ? "success" : "info",
      );
    },
  });
};

/**
 * 注册全部 Modal 演示贡献（main.js 编排入口）。
 * 整体受 modalEnabled 控制；菜单项还要求 menuEnabled，命令还要求 commandEnabled。
 */
export const registerModalDemos = (ctx, config) => {
  if (config.modalEnabled === false) return;
  if (typeof ctx.ui.modal !== "function") return;
  if (config.menuEnabled !== false) registerConfirmDeleteMenu(ctx);
  if (config.commandEnabled !== false) registerModalCommands(ctx);
};
