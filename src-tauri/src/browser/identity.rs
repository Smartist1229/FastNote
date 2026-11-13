use super::*;

/// 生成一份随机指纹（JSON），可直接作为 `browser_open` 的 `fingerprint` 参数。
#[tauri::command]
pub fn browser_random_fingerprint() -> Result<Value, String> {
    serde_json::to_value(random_fingerprint()).map_err(|e| e.to_string())
}

/// 新窗口的身份：Chrome 版本跟运行中的内核对齐，其余字段随机。
///
/// 页面能按 API 探测出引擎真实版本（Chromium vXXX），UA 里声明得比它旧 / 新都会被判
/// 「内核版本特性与 UA 不一致」，所以版本不能从固定表里抽。
pub(crate) fn random_fingerprint() -> BrowserFingerprint {
    #[cfg(windows)]
    if let Some((major, full)) = engine_version() {
        return BrowserFingerprint::for_browser(&major, &full);
    }
    BrowserFingerprint::random()
}

/// 运行中的 WebView2 内核版本，形如 `156.0.3456.78`；取一次缓存住。
#[cfg(windows)]
pub(crate) fn engine_version() -> Option<(String, String)> {
    use windows::core::PCWSTR;
    static CACHE: OnceLock<Option<(String, String)>> = OnceLock::new();
    CACHE
        .get_or_init(|| unsafe {
            let mut raw = windows::core::PWSTR::null();
            webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString(
                PCWSTR::null(),
                &mut raw,
            )
            .ok()?;
            parse_engine_version(&webview2_com::take_pwstr(raw))
        })
        .clone()
}

/// `156.0.3456.78` → (`156`, `156.0.3456.78`)；带后缀的版本串只取第一段。
pub(crate) fn parse_engine_version(raw: &str) -> Option<(String, String)> {
    let version = raw.split_whitespace().next()?;
    let parts = version.split('.').collect::<Vec<_>>();
    let numeric = parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    numeric.then(|| (parts[0].to_string(), version.to_string()))
}

/// 把指纹里的缩放比钉成窗口的真实缩放比。
///
/// `devicePixelRatio` 会被拿来和原生 `matchMedia("(resolution: …)")`、
/// 屏幕 CSS 像素换算互相比对；随机值必然对不上真实缩放，直接改成真实值。
pub(crate) fn pin_real_scale(fingerprint: &mut Value, scale: f64) {
    let Some(fingerprint) = fingerprint.as_object_mut() else {
        return;
    };
    let ratio = serde_json::json!(scale);
    for section in ["screen", "window"] {
        if let Some(inner) = fingerprint.get_mut(section).and_then(Value::as_object_mut) {
            inner.insert("device_pixel_ratio".to_string(), ratio.clone());
        }
    }
}

/// 把指纹灌进初始化脚本。
///
/// 脚本要多替换一次 Worker 插槽：Worker 线程里先跑同一份脚本，Worker 才能读到与主线程
/// 一致的 platform / languages / 时区。Worker 里那份还带最内层脚本，因此 Worker 里再建
/// 的嵌套 Worker 也能注入；最内层不再往后嵌套，避免脚本无限套娃。
pub(crate) fn fingerprint_script(fingerprint: &Value) -> String {
    let payload = serde_json::to_string(fingerprint).unwrap_or_else(|_| "null".to_string());
    let with_payload = FINGERPRINT_SCRIPT.replace("__FASTNOTE_FINGERPRINT__", &payload);
    // 最内层：Worker 里的 Worker 不再包装，递归到此为止
    let leaf = with_payload.replace("__FASTNOTE_WORKER_SCRIPT__", "null");
    // 中间层：Worker 里预载 leaf，所以嵌套 Worker 也能被包装
    let worker = with_payload.replace(
        "__FASTNOTE_WORKER_SCRIPT__",
        &serde_json::to_string(&leaf).unwrap_or_else(|_| "null".to_string()),
    );
    // JSON 字符串字面量在 JS 里同样合法（转义规则一致）
    let worker_literal = serde_json::to_string(&worker).unwrap_or_else(|_| "null".to_string());
    with_payload.replace("__FASTNOTE_WORKER_SCRIPT__", &worker_literal)
}

/// 一份要装进内核的浏览器身份。
///
/// 两条腿都要有：CDP 命令让内核按伪造身份生成 UA-CH、返回原生的 `navigator.userAgentData`；
/// 请求头再逐条兜底——不同 WebView2 版本对 `Network.setUserAgentOverride` 的 UA-CH
/// 支持并不一致，实测仍会带出真实的 Edge 品牌，检测方拿请求头与 JS 里的 UA 一比就露馅。
pub(crate) struct NativeIdentity {
    commands: Vec<(String, String)>,
    headers: Vec<(String, String)>,
}

pub(crate) fn native_identity(fingerprint: &Value) -> Option<NativeIdentity> {
    Some(NativeIdentity {
        commands: identity_override_commands(fingerprint)?,
        headers: request_headers(fingerprint),
    })
}

/// 把指纹翻译成 CDP 命令（方法名 + 参数 JSON）。
///
/// 用 `Network.setUserAgentOverride` 而不是只改 UA 字符串：内核会按 `userAgentMetadata`
/// 自己生成 `Sec-CH-UA` / `Sec-CH-UA-Platform` / `Sec-CH-UA-Full-Version-List` 等请求头，
/// `navigator.userAgentData` 与 `navigator.language(s)` 也由内核原生返回，
/// 与页面读到的 UA 一致。
///
/// 注意 `acceptLanguage` 只能给语言标签（`zh-CN,zh,en`），不能给带 q 值的请求头格式：
/// 内核把这一整串按逗号拆进 `navigator.languages`，`zh;q=0.9` 会原样留在数组里，
/// 检测脚本一看就知道是伪造的。请求头由 `WebResourceRequested` 另行写成带 q 值的格式。
pub(crate) fn identity_override_commands(fingerprint: &Value) -> Option<Vec<(String, String)>> {
    let user_agent = fingerprint.get("user_agent")?.as_str()?;

    let mut params = serde_json::Map::new();
    params.insert(
        "userAgent".to_string(),
        Value::String(user_agent.to_string()),
    );
    let brands = brand_list(fingerprint.get("brands"));
    if brands.as_array().is_some_and(|items| !items.is_empty()) {
        let mut metadata = serde_json::Map::new();
        metadata.insert("brands".to_string(), brands);
        metadata.insert(
            "fullVersionList".to_string(),
            brand_list(fingerprint.get("full_version_list")),
        );
        for (key, field) in [
            ("fullVersion", "chrome_version"),
            ("platform", "ua_platform"),
            ("platformVersion", "ua_platform_version"),
            ("architecture", "ua_architecture"),
            ("model", "ua_model"),
            ("bitness", "ua_bitness"),
        ] {
            if let Some(value) = fingerprint.get(field) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
        for (key, field) in [("mobile", "ua_mobile"), ("wow64", "ua_wow64")] {
            if let Some(value) = fingerprint.get(field).and_then(Value::as_bool) {
                metadata.insert(key.to_string(), Value::Bool(value));
            }
        }
        params.insert(
            "userAgentMetadata".to_string(),
            Value::Object(metadata),
        );
    }
    if let Some(platform) = fingerprint.get("platform") {
        params.insert("platform".to_string(), platform.clone());
    }
    if let Some(languages) = language_tags(fingerprint) {
        params.insert("acceptLanguage".to_string(), Value::String(languages));
    }

    let mut commands = vec![(
        "Network.setUserAgentOverride".to_string(),
        Value::Object(params).to_string(),
    )];
    // DNT 不在 UA 元数据里，单独当额外请求头发送
    if let Some(dnt) = fingerprint.get("do_not_track").and_then(Value::as_str) {
        commands.push((
            "Network.setExtraHTTPHeaders".to_string(),
            serde_json::json!({ "headers": { "DNT": dnt } }).to_string(),
        ));
    }
    Some(commands)
}

/// 每个请求都要改写的身份头（UA / UA-CH / Accept-Language / DNT）。
/// 值必须与初始化脚本里的 `navigator`、`userAgentData` 同源，否则检测方一对就露馅。
pub(crate) fn request_headers(fingerprint: &Value) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut set = |name: &str, value: String| {
        if !value.is_empty() {
            headers.push((name.to_string(), value));
        }
    };

    if let Some(user_agent) = fingerprint.get("user_agent").and_then(Value::as_str) {
        set("User-Agent", user_agent.to_string());
    }
    if let Some(language) = accept_language(fingerprint) {
        set("Accept-Language", language);
    }
    if let Some(brands) = brands_header(fingerprint.get("brands")) {
        set("Sec-CH-UA", brands);
    }
    if let Some(full_versions) = brands_header(fingerprint.get("full_version_list")) {
        set("Sec-CH-UA-Full-Version-List", full_versions);
    }
    for (header, field) in [
        ("Sec-CH-UA-Platform", "ua_platform"),
        ("Sec-CH-UA-Platform-Version", "ua_platform_version"),
        ("Sec-CH-UA-Arch", "ua_architecture"),
        ("Sec-CH-UA-Bitness", "ua_bitness"),
        ("Sec-CH-UA-Model", "ua_model"),
    ] {
        if let Some(value) = quoted_field(fingerprint, field) {
            set(header, value);
        }
    }
    if let Some(full_version) = fingerprint.get("chrome_version").and_then(Value::as_str) {
        set("Sec-CH-UA-Full-Version", full_version.to_string());
    }
    for (header, field) in [("Sec-CH-UA-Mobile", "ua_mobile"), ("Sec-CH-UA-WoW64", "ua_wow64")] {
        if let Some(value) = fingerprint.get(field).and_then(Value::as_bool) {
            set(header, if value { "?1" } else { "?0" }.to_string());
        }
    }
    if let Some(factors) = fingerprint.get("ua_form_factors").and_then(Value::as_array) {
        let list = factors
            .iter()
            .filter_map(Value::as_str)
            .map(|factor| format!("\"{factor}\""))
            .collect::<Vec<_>>()
            .join(", ");
        set("Sec-CH-UA-Form-Factors", list);
    }
    if let Some(dnt) = fingerprint.get("do_not_track").and_then(Value::as_str) {
        set("DNT", dnt.to_string());
    }

    headers
}

/// 窗口指纹 → 下载客户端的默认请求头。
/// 直接复用 [`request_headers`]，下载请求与窗口内的请求因此是同一个 UA / UA-CH / 语言。
pub(crate) fn identity_headers(fingerprint: &Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in request_headers(fingerprint) {
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
}

/// `brands` / `full_version_list` → CDP 要的 `[{brand, version}]`
pub(crate) fn brand_list(value: Option<&Value>) -> Value {
    let items = value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(serde_json::json!({
                        "brand": item.get("brand")?.as_str()?,
                        "version": item.get("version")?.as_str()?,
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(items)
}

/// `brands` / `full_version_list` → `Sec-CH-UA` 头的值：`"Chromium";v="142", …`
pub(crate) fn brands_header(value: Option<&Value>) -> Option<String> {
    let items = value?.as_array()?;
    let parts = items
        .iter()
        .filter_map(|item| {
            Some(format!(
                "\"{}\";v=\"{}\"",
                item.get("brand")?.as_str()?,
                item.get("version")?.as_str()?
            ))
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// UA-CH 的字符串值要求带引号（空字符串就是 `""`）
pub(crate) fn quoted_field(fingerprint: &Value, field: &str) -> Option<String> {
    let value = fingerprint.get(field)?.as_str()?;
    Some(format!("\"{value}\""))
}

/// CDP `acceptLanguage` 的值：只给语言标签（`zh-CN,zh,en`）。
///
/// 内核会把这一整串按逗号拆进 `navigator.languages`，`zh;q=0.9` 这种带 q 值的条目
/// 会原样留在数组里（`["zh-CN", "zh;q=0.9", "en;q=0.8"]`）——真实 Chrome 不会这样，
/// 指纹检测直接判「语言异常」。q 值只出现在请求头里，由 `request_headers` 负责。
pub(crate) fn language_tags(fingerprint: &Value) -> Option<String> {
    let languages = fingerprint.get("languages")?.as_array()?;
    let tags = languages
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    (!tags.is_empty()).then(|| tags.join(","))
}

/// Accept-Language 头的值：第一条不带 q，其余按顺序递减
pub(crate) fn accept_language(fingerprint: &Value) -> Option<String> {
    let languages = fingerprint.get("languages")?.as_array()?;
    let values = languages
        .iter()
        .filter_map(Value::as_str)
        .enumerate()
        .map(|(index, language)| {
            if index == 0 {
                language.to_string()
            } else {
                format!("{language};q=0.{}", 10usize.saturating_sub(index).max(1))
            }
        })
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.join(","))
}

/// 浏览器对每个请求都会发的头：无条件改写
pub(crate) const ALWAYS_SENT_HEADERS: &[&str] = &[
    "User-Agent",
    "Accept-Language",
    "Sec-CH-UA",
    "Sec-CH-UA-Mobile",
    "Sec-CH-UA-Platform",
    "DNT",
];

/// 在网页 WebView 上装身份：CDP 命令 + 逐请求改写请求头。COM 调用必须落在主线程，
/// `with_webview` 负责派发。
///
/// CDP 命令是异步执行的：函数会等内核回完所有命令（最多 1 秒）再返回，调用方随后就能
/// 导航。等不到回调也不会卡住页面，只是首屏请求可能仍带真实 UA-CH。
#[cfg(windows)]
pub(crate) fn install_native_identity(content: &Webview, identity: NativeIdentity) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    /// 一条命令落地（或失败）后计数；最后一条完成时通知等待线程
    pub(crate) fn release(pending: &AtomicUsize, done: &Mutex<mpsc::Sender<()>>) {
        if pending.fetch_sub(1, Ordering::SeqCst) == 1 {
            if let Ok(done) = done.lock() {
                let _ = done.send(());
            }
        }
    }

    let NativeIdentity { commands, headers } = identity;
    let total = commands.len();
    let (done, finished) = mpsc::channel::<()>();
    let pending = std::sync::Arc::new(AtomicUsize::new(total));
    let done = std::sync::Arc::new(Mutex::new(done));
    let groups = std::sync::Arc::new(
        headers
            .into_iter()
            .map(|(name, value)| {
                let always = ALWAYS_SENT_HEADERS.contains(&name.as_str());
                (HSTRING::from(name), HSTRING::from(value), always)
            })
            .collect::<Vec<_>>(),
    );

    let started = content.with_webview({
        let pending = pending.clone();
        let done = done.clone();
        move |platform| {
            let controller = platform.controller();
            unsafe {
                let Ok(core) = controller.CoreWebView2() else {
                    // 拿不到内核：命令不会执行，也就不会有回调，直接放行
                    for _ in 0..total {
                        release(&pending, &done);
                    }
                    return;
                };
                for (method, params) in commands {
                    let callback_pending = pending.clone();
                    let callback_done = done.clone();
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |_result, _message| {
                            release(&callback_pending, &callback_done);
                            Ok(())
                        },
                    ));
                    let called = core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(params),
                        &handler,
                    );
                    if called.is_err() {
                        // 没排进内核就不会有回调，自己把这一条记成完成
                        release(&pending, &done);
                    }
                }

                /*
                 * UA-CH 是内核按自己的品牌表拼的，CDP 改不掉（WebView2 仍报 Edge），
                 * 所以每个请求发出去之前再把身份头覆盖一遍。文档、脚本、XHR、Worker
                 * 的请求都会经过这里，页面读到的 UA 与请求头因此始终一致。
                 *
                 * 高熵客户端提示（架构 / 位数 / 完整版本等）只在请求本来就有的时候改：
                 * 网页没通过 Accept-CH 索要却收到一堆高熵值，是真实 Chrome 不会做的事。
                 */
                let request_handler = WebResourceRequestedEventHandler::create(Box::new(
                    move |_sender, args| {
                        if let Some(args) = args {
                            if let Ok(request) = args.Request() {
                                if let Ok(request_headers) = request.Headers() {
                                    for (name, value, always) in groups.iter() {
                                        if !always {
                                            let mut present = windows::core::BOOL(0);
                                            let exists = request_headers
                                                .Contains(name, &mut present)
                                                .is_ok()
                                                && present.as_bool();
                                            if !exists {
                                                continue;
                                            }
                                        }
                                        let _ = request_headers.SetHeader(name, value);
                                    }
                                }
                            }
                        }
                        Ok(())
                    },
                ));
                let _ = core.AddWebResourceRequestedFilter(
                    &HSTRING::from("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                );
                let _ = core.add_WebResourceRequested(&request_handler, &mut 0i64);
            }
        }
    });

    if started.is_err() {
        // 闭包没派发出去：不会有回调，别在这里干等
        return;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while pending.load(Ordering::SeqCst) > 0 {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || finished.recv_timeout(left).is_err() {
            break;
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn install_native_identity(_content: &Webview, _identity: NativeIdentity) {}

