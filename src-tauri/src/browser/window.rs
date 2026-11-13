use super::*;

/// 暂停 / 继续某个浏览器下载；任务已结束时返回 false。
/// 暂停只停传输，临时分片保留在 `download/<文件名>` 暂存目录里，继续后从原位置续传。
#[tauri::command]
pub async fn browser_download_pause(id: u64, paused: bool) -> Result<bool, String> {
    let map = download_controls()
        .lock()
        .map_err(|_| "下载控制锁被占用".to_string())?;
    match map.get(&id) {
        Some(control) => {
            control.set_paused(paused);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 取消某个浏览器下载（会清理暂存目录）；任务已结束时返回 false。
#[tauri::command]
pub async fn browser_download_cancel(id: u64) -> Result<bool, String> {
    let map = download_controls()
        .lock()
        .map_err(|_| "下载控制锁被占用".to_string())?;
    match map.get(&id) {
        Some(control) => {
            control.cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 移除一条已结束的下载记录；任务还在进行中时返回 false（不让界面和真实任务脱节）。
#[tauri::command]
pub async fn browser_download_forget(toolbar: Webview, id: u64) -> Result<bool, String> {
    let running = download_controls()
        .lock()
        .map(|map| map.contains_key(&id))
        .unwrap_or(false);
    if running {
        return Ok(false);
    }
    let label = content_label_of(&toolbar)?;
    Ok(forget_download(&label, id))
}

/// 清掉该窗口里所有已结束的下载记录（进行中的任务保留）。
#[tauri::command]
pub async fn browser_download_clear(toolbar: Webview) -> Result<(), String> {
    let active: Vec<u64> = download_controls()
        .lock()
        .map(|map| map.keys().copied().collect())
        .unwrap_or_default();
    let label = content_label_of(&toolbar)?;
    if let Ok(mut map) = states().lock() {
        if let Some(state) = map.get_mut(&label) {
            state
                .downloads
                .retain(|item| active.contains(&item.id));
        }
    }
    Ok(())
}

/// 面板窗口的 label：一个浏览器窗口配一个下载气泡
pub(crate) fn panel_label(window: &str) -> String {
    format!("{window}{PANEL_SUFFIX}")
}

pub(crate) fn panel_window(app: &AppHandle, window_label: &str) -> Option<Window> {
    app.get_window(&panel_label(window_label))
}

/// 展开 / 收起下载面板。
///
/// 面板是浏览器窗口下挂的一个无边框透明小窗口（懒创建），只盖住页面右上角一块，
/// 网页 WebView 的尺寸不动——不像把工具栏 WebView 加高那样让页面整体往下缩。
#[tauri::command]
pub async fn browser_toolbar_panel(toolbar: Webview, open: bool, height: f64) -> Result<(), String> {
    // 顺带校验调用方确实是浏览器的工具栏 / 面板 WebView
    let _content = content_label_of(&toolbar)?;
    let window = toolbar.window();
    if !open {
        if let Some(panel) = panel_window(window.app_handle(), window.label()) {
            let _ = panel.hide();
        }
        return Ok(());
    }
    let panel = ensure_panel_window(&window)?;
    place_panel(&window, &panel, height)?;
    panel.show().map_err(|e| format!("显示下载面板失败：{e}"))?;
    Ok(())
}

/// 懒创建面板窗口（第一次展开面板时才建）。必须跑在非主线程：
/// `WindowBuilder::build` / `add_child` 在主线程会等事件循环而死锁。
pub(crate) fn ensure_panel_window(parent: &Window) -> Result<Window, String> {
    let app = parent.app_handle();
    if let Some(panel) = panel_window(app, parent.label()) {
        return Ok(panel);
    }
    let label = panel_label(parent.label());
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let panel = WindowBuilder::new(app, &label)
        // 挂在浏览器窗口名下：跟着一起最小化 / 关闭，也不会出现在任务栏
        .parent(parent)
        .map_err(|e| format!("创建下载面板失败：{e}"))?
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        // 不抢焦点：点面板上的按钮时网页那边不会失焦
        .focusable(false)
        .transparent(true)
        .visible(false)
        .inner_size(PANEL_WIDTH, PANEL_MIN_HEIGHT)
        .build()
        .map_err(|e| format!("创建下载面板失败：{e}"))?;
    panel
        .add_child(
            WebviewBuilder::new(
                &label,
                WebviewUrl::App("browser-toolbar.html?panel=1".into()),
            )
            // 独立数据目录：WebView2 要求共用目录的环境选项完全一致，混用会建不起来
            .data_directory(data_dir.join(PANEL_PROFILE_DIR))
            .additional_browser_args(crate::BACKGROUND_SAFE_WEBVIEW_ARGS)
            .transparent(true)
            .focused(false),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(PANEL_WIDTH, PANEL_MIN_HEIGHT),
        )
        .map_err(|e| format!("创建下载面板失败：{e}"))?;
    Ok(panel)
}

/// 把面板摆到浏览器窗口右上角、工具栏下方（贴右边缘）。
/// 窗口比卡片四周多出 [`PANEL_SHADOW_PAD`]，那一圈是透明的，用来画阴影。
pub(crate) fn place_panel(parent: &Window, panel: &Window, height: f64) -> Result<(), String> {
    let scale = parent.scale_factor().unwrap_or(1.0);
    let origin = parent
        .inner_position()
        .map_err(|e| format!("读取窗口位置失败：{e}"))?;
    let size = parent
        .inner_size()
        .map_err(|e| format!("读取窗口尺寸失败：{e}"))?;
    let margin = (PANEL_MARGIN * scale).round() as u32;
    let pad = (PANEL_SHADOW_PAD * scale).round().max(1.0) as u32;
    // 窗口被拖得很窄时卡片跟着变窄，但最小留 200 逻辑像素
    let min_width = (200.0 * scale).round().max(1.0) as u32;
    let max_card = size
        .width
        .saturating_sub(margin * 2)
        .saturating_sub(pad * 2)
        .max(min_width);
    let card = ((PANEL_WIDTH * scale).round() as u32).min(max_card);
    let card_height = (height.clamp(PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT) * scale)
        .round()
        .max(1.0) as u32;
    let width = card + pad * 2;
    let height = card_height + pad * 2;
    let x = origin.x + size.width as i32 - width as i32 - margin as i32;
    let y = origin.y + (TOOLBAR_HEIGHT * scale).round() as i32 + (4.0 * scale).round() as i32;
    panel
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("移动下载面板失败：{e}"))?;
    panel
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| format!("调整下载面板尺寸失败：{e}"))?;
    // 子 WebView 不会自动铺满窗口，尺寸得跟着窗口走
    if let Some(webview) = panel.app_handle().get_webview(panel.label()) {
        let _ = webview.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, 0)),
            size: Size::Physical(PhysicalSize::new(width, height)),
        });
    }
    Ok(())
}

/// 浏览器窗口移动 / 缩放时，把已展开的面板挪到新的右上角。
pub(crate) fn sync_panel(parent: &Window) {
    let Some(panel) = panel_window(parent.app_handle(), parent.label()) else {
        return;
    };
    if !panel.is_visible().unwrap_or(false) {
        return;
    }
    // 最小化时窗口尺寸会变成 0，面板一起收起来
    let hidden = parent
        .inner_size()
        .map(|size| size.width == 0 || size.height == 0)
        .unwrap_or(true);
    if hidden {
        let _ = panel.hide();
        return;
    }
    let scale = parent.scale_factor().unwrap_or(1.0);
    let height = panel
        .inner_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale).height)
        .unwrap_or(PANEL_MIN_HEIGHT);
    let _ = place_panel(parent, &panel, height);
}

/// 浏览器窗口的「选窗口 + 分配 label + 创建」串行锁，避免并发打开时撞 label。
pub(crate) fn creation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 在软件内的浏览器窗口里打开链接。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    fingerprint: Option<Value>,
) -> Result<(), String> {
    let target = normalize_url(&url)?;
    let multi_window = crate::read_setting_bool(&app, MULTI_WINDOW_SETTING, false);

    /*
     * 串行化「选窗口 / 分配 label / 创建窗口」：两个链接几乎同时打开时，
     * 都会看到「还没有浏览器窗口」并各自分配 label、创建窗口，轻则撞 label，
     * 重则留下没有网页 WebView 的半成品窗口。锁只在同步段持有，不跨 await。
     */
    let _guard = creation_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // 单窗口模式复用任意已存在的浏览器窗口（包括多窗口模式留下的带序号窗口）
    if !multi_window {
        if let Some(window) = existing_browser_window(&app) {
            let content = content_of_window(&window)
                .ok_or_else(|| "浏览器窗口状态异常，请关闭窗口后重试".to_string())?;
            content
                .navigate(target.clone())
                .map_err(|e| format!("打开链接失败：{e}"))?;
            set_state(content.label(), target.to_string(), true);
            // show() 不会把最小化的窗口还原，必须显式 unminimize
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = content.set_focus();
            return Ok(());
        }
    }

    let label = if multi_window || app.get_window(BROWSER_LABEL).is_some() {
        // 多窗口模式每开一个链接就新建；单窗口模式只有在固定 label 被占着却不完整时才换序号
        next_browser_label(&app)
    } else {
        BROWSER_LABEL.to_string()
    };
    create_browser_window(&app, &label, target, fingerprint)
        .map_err(|e| format!("打开浏览器窗口失败：{e}"))
}

/// 工具栏轮询：当前地址与是否正在加载。
///
/// 地址以网页 WebView 的真实 URL 为准：页面内跳转（hash、`pushState`、历史导航）
/// 不触发 `on_page_load`，只读缓存会让地址栏停在上一页。真实地址还是 `about:blank`
/// （装身份时的起始空白页）时才回退到缓存。
#[tauri::command]
pub async fn browser_toolbar_state(
    app: AppHandle,
    toolbar: Webview,
) -> Result<BrowserState, String> {
    let content_label = content_label_of(&toolbar)?;
    let mut state = state_of(&content_label);
    if let Some(content) = app.get_webview(&content_label) {
        if let Ok(url) = content.url() {
            let live = url.to_string();
            if live != "about:blank" {
                state.url = live;
            }
        }
    }
    // 面板窗口是否可见（工具栏据此画按钮上的展开箭头）
    let window_label = content_label
        .strip_suffix(CONTENT_SUFFIX)
        .unwrap_or(&content_label);
    state.panel_open = panel_window(&app, window_label)
        .and_then(|panel| panel.is_visible().ok())
        .unwrap_or(false);
    Ok(state)
}

/// 工具栏按钮：back / forward / reload。
#[tauri::command]
pub async fn browser_toolbar_action(
    app: AppHandle,
    toolbar: Webview,
    action: String,
) -> Result<(), String> {
    let content = content_of_toolbar(&app, &toolbar)?;
    match action.as_str() {
        "back" => history_navigate(&content, false),
        "forward" => history_navigate(&content, true),
        "reload" => content.reload().map_err(|e| format!("刷新失败：{e}")),
        other => return Err(format!("未知操作：{other}")),
    }?;
    let _ = content.set_focus();
    Ok(())
}

/// 后退 / 前进：Windows 上直接用 WebView2 的历史导航，
/// 其他平台退回页面脚本的 `history.back()` / `history.forward()`。
pub(crate) fn history_navigate(content: &Webview, forward: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        content
            .with_webview(move |platform| {
                // COM 调用必须落在主线程；with_webview 会把闭包派发过去
                unsafe {
                    if let Ok(core) = platform.controller().CoreWebView2() {
                        let _ = if forward { core.GoForward() } else { core.GoBack() };
                    }
                }
            })
            .map_err(|e| format!("历史导航失败：{e}"))
    }
    #[cfg(not(windows))]
    {
        content
            .eval(if forward {
                "history.forward()"
            } else {
                "history.back()"
            })
            .map_err(|e| format!("历史导航失败：{e}"))
    }
}

/// 地址栏回车：按 `browser_open` 同一套规则规范化地址后导航。
#[tauri::command]
pub async fn browser_toolbar_navigate(
    app: AppHandle,
    toolbar: Webview,
    url: String,
) -> Result<(), String> {
    let target = normalize_url(&url)?;
    let content = content_of_toolbar(&app, &toolbar)?;
    content
        .navigate(target.clone())
        .map_err(|e| format!("打开链接失败：{e}"))?;
    // 地址栏立即回显新地址，不必等页面真的开始加载
    set_state(content.label(), target.to_string(), true);
    let _ = content.set_focus();
    Ok(())
}

/// 创建浏览器窗口：原生窗口 + 工具栏 WebView + 网页 WebView。
pub(crate) fn create_browser_window(
    app: &AppHandle,
    label: &str,
    target: Url,
    fingerprint: Option<Value>,
) -> tauri::Result<()> {
    // 没显式指定指纹时按设置生成一份：窗口一建好身份就固定，复用它跳转不会换
    let mut fingerprint = fingerprint.or_else(|| {
        if crate::read_setting_bool(app, RANDOM_FINGERPRINT_SETTING, true) {
            serde_json::to_value(random_fingerprint()).ok()
        } else {
            None
        }
    });
    // 交给内核的身份参数：必须在第一次真实请求之前装好，否则首屏请求仍带真实 UA-CH。
    // 目前只有 Windows 的 WebView2 能装进内核，其他平台不装、直接导航。
    let identity = if cfg!(windows) {
        fingerprint.as_ref().and_then(native_identity)
    } else {
        None
    };
    let title = target.host_str().unwrap_or("浏览器").to_string();
    let window = WindowBuilder::new(app, label)
        .title(title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(480.0, 320.0)
        .visible(false)
        .build()?;

    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?;
    let logical = size.to_logical::<f64>(scale);
    let content_height = (logical.height - TOOLBAR_HEIGHT).max(1.0);

    // 屏幕缩放比必须钉成真实值：`devicePixelRatio` 与内核原生的
    // `matchMedia("(resolution: …)")` 得对得上，随机值一比对就露馅
    if let Some(fingerprint) = fingerprint.as_mut() {
        pin_real_scale(fingerprint, scale);
    }

    // 下载请求必须复用窗口身份：另取一份随机指纹会让 UA / UA-CH 与窗口对不上，
    // 有些站点的下载链接会按 UA 校验会话。
    let download_headers = fingerprint
        .as_ref()
        .map(identity_headers)
        .unwrap_or_default();

    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let toolbar_label = format!("{label}{TOOLBAR_SUFFIX}");
    let content_label = format!("{label}{CONTENT_SUFFIX}");
    // 先写状态再建工具栏：工具栏一开始轮询就能拿到地址，避免地址栏空一下
    set_state(&content_label, target.to_string(), true);

    window.add_child(
        WebviewBuilder::new(toolbar_label, WebviewUrl::App("browser-toolbar.html".into()))
            /*
             * 独立数据目录：主窗口在 tauri.conf.json 里配了自定义 additionalBrowserArgs，
             * 而 WebView2 要求共用同一个 user data folder 的环境使用完全相同的选项，
             * 混用会导致环境创建失败（窗口闪一下就消失）。工具栏与网页各用独立目录。
             */
            .data_directory(data_dir.join(TOOLBAR_PROFILE_DIR))
            // 独立数据目录拿不到 tauri.conf 里的 additionalBrowserArgs，补同一组：
            // 否则窗口最小化久了渲染进程被降频，恢复后工具栏可能一片空白
            .additional_browser_args(crate::BACKGROUND_SAFE_WEBVIEW_ARGS)
            .focused(false),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(logical.width, TOOLBAR_HEIGHT),
    )?;

    /*
     * 要装身份时先停在空白页，等 CDP 命令装好再导航到真实地址；
     * 否则 webview 一创建就开始请求，首屏（往往正是带检测脚本的页面）
     * 拿到的是真实 UA-CH。
     */
    let start_url = if identity.is_some() {
        Url::parse("about:blank").expect("about:blank 是合法地址")
    } else {
        target.clone()
    };

    let mut content_builder = WebviewBuilder::new(
        content_label.clone(),
        WebviewUrl::External(start_url),
    )
    .data_directory(data_dir.join(BROWSER_PROFILE_DIR))
    // 同工具栏：独立数据目录要自己带这组参数，否则最小化久了网页会空白
    .additional_browser_args(crate::BACKGROUND_SAFE_WEBVIEW_ARGS)
    /*
     * 打开网页侧控制台：F12 / Ctrl+Shift+I 与右键菜单里的「检查」都由内核自己提供，
     * 页面脚本 preventDefault 也拦不住（快捷键在内核进程里处理）。
     * release 包默认是关的（wry 只在 debug 下默认开），这里显式开一次，
     * 免得以后有人改 Cargo.toml 的 devtools feature 时又静默丢掉。
     */
    .devtools(true)
    // 每个窗口都注入：不依赖指纹是否传入，否则 target="_blank" 链接会打不开
    .initialization_script(LINK_SCRIPT)
    /*
     * 页面里的 target="_blank" / window.open 链接：脚本负责绝大多数点击，这里是兜底
     * （中键、表单 target、脚本直接请求新窗口等）。在发起请求的这个窗口里导航。
     */
    .on_new_window({
        let app = app.clone();
        let label = content_label.clone();
        move |url, _features| {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.navigate(url.clone());
                set_state(&label, url.to_string(), true);
            }
            NewWindowResponse::Deny
        }
    })
    // 标题跟随网页，避免一直停在域名上
    .on_document_title_changed(|webview, title| {
        let title = title.trim();
        if !title.is_empty() {
            let _ = webview.window().set_title(title);
        }
    })
    // 加载状态给工具栏画进度条用
    .on_page_load(|webview, payload| {
        let url = payload.url().to_string();
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        // 装身份时先建的 about:blank 不是用户要去的地方，别让它盖掉地址栏
        if url == "about:blank" {
            // 但导航失败停在空白页时也要把加载状态收掉，否则进度条一直转
            if !loading {
                let cached = state_of(webview.label());
                set_state(webview.label(), cached.url, false);
            }
            return;
        }
        set_state(webview.label(), url, loading);
    })
    /*
     * 下载：取消内核下载，交给自带的 download 模块（分片多线程 + 进度）。
     * 内核的下载没有进度事件，也没法显示在工具栏里；blob:/data: 这类只有内核
     * 能保存的地址仍返回 true 交给原生下载。
     */
    .on_download({
        let app = app.clone();
        let headers = download_headers.clone();
        move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                if !matches!(url.scheme(), "http" | "https") {
                    return true;
                }
                let suggested = destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string);
                start_browser_download(
                    app.clone(),
                    webview,
                    url.clone(),
                    suggested,
                    headers.clone(),
                );
                // false = 取消内核下载，改由 download 模块接管
                false
            }
            DownloadEvent::Finished { .. } => true,
            _ => true,
        }
    });
    if let Some(fingerprint) = fingerprint {
        // 原生 UA 与脚本里的 UA 必须同源：只改脚本会让请求头 UA 和 JS 读到的 UA 互相矛盾
        if let Some(user_agent) = fingerprint.get("user_agent").and_then(Value::as_str) {
            content_builder = content_builder.user_agent(user_agent);
        }
        content_builder = content_builder.initialization_script(fingerprint_script(&fingerprint));
    }

    let content = window.add_child(
        content_builder,
        LogicalPosition::new(0.0, TOOLBAR_HEIGHT),
        LogicalSize::new(logical.width, content_height),
    )?;

    if let Some(identity) = identity {
        // 装失败不拦着页面显示：只是网络层身份没换成功，页面里仍有 JS 兜底
        // 返回时 CDP 命令已经在内核里落地（或超时放弃），不必再睡固定时长
        install_native_identity(&content, identity);
        content.navigate(target.clone())?;
    }

    window.show()?;
    let _ = window.set_focus();
    let _ = content.set_focus();
    Ok(())
}

pub(crate) fn sync_layout(window: &Window) {
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return;
    };
    // 最小化时窗口尺寸可能是 0，WebView2 不接受 0 尺寸，至少留 1px
    let toolbar_px = ((TOOLBAR_HEIGHT * scale).round() as u32).max(1);
    let width = size.width.max(1);
    let content_height = size.height.saturating_sub(toolbar_px).max(1);
    let app = window.app_handle();

    if let Some(toolbar) = app.get_webview(&format!("{}{TOOLBAR_SUFFIX}", window.label())) {
        let _ = toolbar.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, 0)),
            size: Size::Physical(PhysicalSize::new(width, toolbar_px)),
        });
    }
    if let Some(content) = app.get_webview(&format!("{}{CONTENT_SUFFIX}", window.label())) {
        let _ = content.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, toolbar_px as i32)),
            size: Size::Physical(PhysicalSize::new(width, content_height)),
        });
    }
}

pub(crate) fn is_browser_window(label: &str) -> bool {
    // 下载面板也是挂在浏览器窗口下的小窗，走同一套窗口事件，但不能当成浏览器窗口本身
    !label.ends_with(PANEL_SUFFIX)
        && (label == BROWSER_LABEL || label.starts_with(BROWSER_LABEL_PREFIX))
}

/// 找任意一个可用的浏览器窗口：先找单窗口模式的固定 label，
/// 再找多窗口模式留下的带序号窗口；没有网页 WebView 的（正在关闭）跳过。
pub(crate) fn existing_browser_window(app: &AppHandle) -> Option<Window> {
    let fixed = app.get_window(BROWSER_LABEL);
    let numbered = app
        .windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(BROWSER_LABEL_PREFIX))
        .map(|(_, window)| window);
    fixed
        .into_iter()
        .chain(numbered)
        .find(|window| content_of_window(window).is_some())
}

/// 分配一个当前没被占用的窗口 label（窗口关掉后序号会被重新使用）
pub(crate) fn next_browser_label(app: &AppHandle) -> String {
    let existing = app.windows();
    let mut n = 1;
    loop {
        let label = format!("{BROWSER_LABEL_PREFIX}{n}");
        if !existing.contains_key(&label) {
            return label;
        }
        n += 1;
    }
}

/// 窗口里的网页 WebView
pub(crate) fn content_of_window(window: &Window) -> Option<Webview> {
    window
        .app_handle()
        .get_webview(&format!("{}{CONTENT_SUFFIX}", window.label()))
}

/// 工具栏 / 下载面板 WebView 对应的网页 WebView label
pub(crate) fn content_label_of(webview: &Webview) -> Result<String, String> {
    let label = webview.label();
    label
        .strip_suffix(TOOLBAR_SUFFIX)
        .or_else(|| label.strip_suffix(PANEL_SUFFIX))
        .map(|window| format!("{window}{CONTENT_SUFFIX}"))
        .ok_or_else(|| "不是浏览器工具栏窗口".to_string())
}

pub(crate) fn content_of_toolbar(app: &AppHandle, toolbar: &Webview) -> Result<Webview, String> {
    let label = content_label_of(toolbar)?;
    app.get_webview(&label)
        .ok_or_else(|| "浏览器窗口已关闭".to_string())
}

