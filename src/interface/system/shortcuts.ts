/**
 * 全局热键的跨层类型：`api/`（invoke 薄封装）与 `features/shortcuts/`（快捷键运行时）共用一份。
 *
 * 为什么单独放 interface：这两层各写过一份，字段名还不一致——api 层叫 `accelerator`、
 * 运行时叫 `combo`，但运行时里存的**就是** Tauri 写法的 accelerator（`toGlobalAccelerator`
 * 折算后的结果），名字与内容不符，读代码时极易误判。
 * 现在统一以 Rust 侧字段为准，前端 `mod+shift+k` 这类写法在进结构之前就折算掉。
 */

/** 一条注册请求：`id` 是宿主动作 id，`accelerator` 是 Tauri 写法（`CommandOrControl+Shift+K`） */
export interface GlobalShortcutRequest {
  id: string;
  accelerator: string;
}

/** 注册失败项：多数是键位已被其它程序占用（如输入法、截图工具），失败项不出现在成功结果里 */
export interface GlobalShortcutFailure {
  id: string;
  /** Tauri 写法，**不是**前端 `mod+shift+k` 那种组合键写法 */
  accelerator: string;
  /** 系统 / 解析错误原文，前端原样展示 */
  reason: string;
}
