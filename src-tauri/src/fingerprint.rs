//! 浏览器指纹：每次调用生成一份随机且自洽的仿真浏览器身份。
//!
//! 为什么需要：部分下载站会校验 UA、`Sec-CH-UA` 等浏览器特征，裸客户端或版本过旧的
//! UA 会被直接回 400/403。这里把 UA、UA-CH、语言、时区、屏幕、WebGL、WebGPU、音频、
//! 媒体设备、网络、字体等伪装值集中成一份结构，像指纹浏览器一样随机组合，但同一份
//! 指纹内部保持一致——Windows UA 不会配 `MacIntel`，ARM 平台也不会配 Intel 核显。
//!
//! 调用方每次需要新身份时取 `BrowserFingerprint::random()`；同一个下载任务的多次
//! Range 请求共用同一个 `Client`，因此共用同一份指纹（`download::client` 在创建客户端
//! 时取一次）。
//!
//! 边界：本模块只生成“浏览器可观测属性”的数据和对应的 HTTP 请求头，不运行网页 JS，
//! 也不改变 TLS / HTTP2 握手特征。对只检查 UA、Client Hints、Cookie 等请求头的站点
//! 足够用；对有 TLS 指纹或页面内 JS 检测的站点，无法保证完全隐身。
//!
//! 注意：默认请求头里**不带** `Accept-Encoding`。下载拿的是原始字节，若服务器按
//! 浏览器声明压缩，分段下载的字节区间与 Content-Length 都会对不上。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;

const ACCEPT: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

/// 可选的 Chrome 版本：UA 里是主版本（`142.0.0.0`），UA-CH 里是完整版本
const CHROME_VERSIONS: &[(&str, &str)] = &[
    ("146", "146.0.7680.80"),
    ("145", "145.0.7632.46"),
    ("144", "144.0.7559.60"),
    ("143", "143.0.7499.41"),
    ("142", "142.0.7444.60"),
    ("141", "141.0.7390.55"),
    ("140", "140.0.7339.82"),
    ("139", "139.0.7258.67"),
];

const PLUGINS: &[&str] = &[
    "PDF Viewer",
    "Chrome PDF Viewer",
    "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer",
    "WebKit built-in PDF",
];

const MIME_TYPES: &[MimeTypeInfo] = &[
    MimeTypeInfo {
        mime_type: "application/pdf",
        suffixes: "pdf",
        description: "Portable Document Format",
    },
    MimeTypeInfo {
        mime_type: "text/pdf",
        suffixes: "pdf",
        description: "Portable Document Format",
    },
];

const API_FEATURES: &[&str] = &[
    "Bluetooth",
    "USB",
    "Serial",
    "HID",
    "WebGPU",
    "Service Worker",
    "Credentials",
    "Push Manager",
    "Media Devices",
    "Speech Synthesis",
    "WebRTC",
    "WebAssembly",
    "SharedArrayBuffer",
    "Web Locks",
    "Cache Storage",
    "IndexedDB",
];

/// WebGL 扩展在不同平台/驱动上高度一致，这里使用桌面 Chrome 的常见集合
const WEBGL_EXTENSIONS: &[&str] = &[
    "ANGLE_instanced_arrays",
    "EXT_blend_minmax",
    "EXT_clip_control",
    "EXT_color_buffer_float",
    "EXT_color_buffer_half_float",
    "EXT_conservative_depth",
    "EXT_depth_clamp",
    "EXT_disjoint_timer_query",
    "EXT_float_blend",
    "EXT_frag_depth",
    "EXT_polygon_offset_clamp",
    "EXT_render_snorm",
    "EXT_shader_texture_lod",
    "EXT_sRGB",
    "EXT_texture_compression_bptc",
    "EXT_texture_compression_rgtc",
    "EXT_texture_filter_anisotropic",
    "EXT_texture_mirror_clamp_to_edge",
    "EXT_texture_norm16",
    "KHR_parallel_shader_compile",
    "OES_draw_buffers_indexed",
    "OES_element_index_uint",
    "OES_fbo_render_sample",
    "OES_sample_variables",
    "OES_standard_derivatives",
    "OES_texture_float",
    "OES_texture_float_linear",
    "OES_texture_half_float",
    "OES_texture_half_float_linear",
    "OES_vertex_array_object",
    "WEBGL_blend_func_extended",
    "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_s3tc",
    "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info",
    "WEBGL_debug_shaders",
    "WEBGL_depth_texture",
    "WEBGL_draw_buffers",
    "WEBGL_lose_context",
    "WEBGL_multi_draw",
    "WEBGL_polygon_mode",
    "WEBGL_provoking_vertex",
    "WEBGL_render_shared_exponent",
    "WEBGL_stencil_texturing",
];

const WINDOWS_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        name: "Microsoft David - English (United States)",
        lang: "en-US",
        local_service: true,
        default: true,
    },
    VoiceInfo {
        name: "Microsoft Zira - English (United States)",
        lang: "en-US",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Microsoft Mark - English (United States)",
        lang: "en-US",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Microsoft Huihui - Chinese (Simplified, PRC)",
        lang: "zh-CN",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Microsoft Yaoyao - Chinese (Simplified, PRC)",
        lang: "zh-CN",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Microsoft Haruka - Japanese (Japan)",
        lang: "ja-JP",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Microsoft Heami - Korean (Korea)",
        lang: "ko-KR",
        local_service: true,
        default: false,
    },
];

const MACOS_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        name: "Samantha",
        lang: "en-US",
        local_service: true,
        default: true,
    },
    VoiceInfo {
        name: "Alex",
        lang: "en-US",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Daniel",
        lang: "en-GB",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Tingting",
        lang: "zh-CN",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Meijia",
        lang: "zh-TW",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Kyoko",
        lang: "ja-JP",
        local_service: true,
        default: false,
    },
    VoiceInfo {
        name: "Yuna",
        lang: "ko-KR",
        local_service: true,
        default: false,
    },
];

const LINUX_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        name: "Google US English",
        lang: "en-US",
        local_service: false,
        default: true,
    },
    VoiceInfo {
        name: "Google UK English Female",
        lang: "en-GB",
        local_service: false,
        default: false,
    },
    VoiceInfo {
        name: "Google 普通话（中国大陆）",
        lang: "zh-CN",
        local_service: false,
        default: false,
    },
    VoiceInfo {
        name: "Google 日本語",
        lang: "ja-JP",
        local_service: false,
        default: false,
    },
    VoiceInfo {
        name: "Google 한국의",
        lang: "ko-KR",
        local_service: false,
        default: false,
    },
];

#[derive(Debug, Clone, Serialize)]
pub struct BrandVersion {
    pub brand: String,
    pub version: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ScreenInfo {
    pub width: u32,
    pub height: u32,
    pub avail_width: u32,
    pub avail_height: u32,
    pub color_depth: u8,
    pub pixel_depth: u8,
    pub device_pixel_ratio: f64,
    pub orientation: &'static str,
    pub orientation_angle: u16,
    pub is_extended: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NavigatorInfo {
    pub app_code_name: &'static str,
    pub app_name: &'static str,
    pub app_version: String,
    pub product: &'static str,
    pub product_sub: &'static str,
    pub vendor: &'static str,
    pub vendor_sub: &'static str,
    pub webdriver: bool,
    pub cookie_enabled: bool,
    pub on_line: bool,
    pub pdf_viewer_enabled: bool,
    pub max_touch_points: u8,
    pub global_privacy_control: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub device_pixel_ratio: f64,
    pub inner_width: u32,
    pub inner_height: u32,
    pub outer_width: u32,
    pub outer_height: u32,
    pub screen_x: i32,
    pub screen_y: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebglInfo {
    /// `gl.getParameter(gl.VENDOR)`，Chrome 固定为 WebKit
    pub vendor: &'static str,
    /// `gl.getParameter(gl.RENDERER)`，Chrome 固定为 WebKit WebGL
    pub renderer: &'static str,
    /// `WEBGL_debug_renderer_info.UNMASKED_VENDOR_WEBGL`
    pub unmasked_vendor: &'static str,
    /// `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL`
    pub unmasked_renderer: &'static str,
    pub version: &'static str,
    pub shading_language_version: &'static str,
    pub webgl2_version: &'static str,
    pub max_texture_size: u32,
    pub max_cube_map_texture_size: u32,
    pub max_renderbuffer_size: u32,
    pub max_viewport_dims: [u32; 2],
    pub max_vertex_attribs: u8,
    pub max_texture_image_units: u8,
    pub max_combined_texture_image_units: u8,
    pub max_vertex_uniform_vectors: u16,
    pub max_fragment_uniform_vectors: u16,
    pub max_varying_vectors: u8,
    pub max_samples: u8,
    pub antialias: bool,
    pub alpha: bool,
    pub depth: bool,
    pub stencil: bool,
    pub premultiplied_alpha: bool,
    pub preserve_drawing_buffer: bool,
    pub extensions: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebGpuLimits {
    pub max_texture_dimension_2d: u32,
    pub max_texture_array_layers: u32,
    pub max_bind_groups: u8,
    pub max_bindings_per_bind_group: u32,
    pub max_dynamic_uniform_buffers_per_pipeline_layout: u32,
    pub max_sampled_textures_per_shader_stage: u32,
    pub max_samplers_per_shader_stage: u32,
    pub max_storage_buffers_per_shader_stage: u32,
    pub max_storage_textures_per_shader_stage: u32,
    pub max_uniform_buffers_per_shader_stage: u32,
    pub max_uniform_buffer_binding_size: u32,
    pub max_storage_buffer_binding_size: u64,
    pub max_vertex_buffers: u32,
    pub max_vertex_attributes: u32,
    pub max_vertex_buffer_array_stride: u32,
    pub max_compute_workgroup_storage_size: u32,
    pub max_compute_invocations_per_workgroup: u32,
    pub max_compute_workgroup_size_x: u32,
    pub max_compute_workgroup_size_y: u32,
    pub max_compute_workgroup_size_z: u32,
    pub max_compute_workgroups_per_dimension: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebGpuInfo {
    pub available: bool,
    pub vendor: &'static str,
    pub architecture: &'static str,
    pub device: &'static str,
    pub description: &'static str,
    pub fallback_adapter: bool,
    pub features: Vec<&'static str>,
    pub limits: WebGpuLimits,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompressorInfo {
    pub threshold: f64,
    pub knee: f64,
    pub ratio: f64,
    pub attack: f64,
    pub release: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub max_channel_count: u8,
    pub base_latency: f64,
    pub output_latency: f64,
    pub compressor: CompressorInfo,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaInfo {
    pub audio_inputs: u8,
    pub video_inputs: u8,
    pub audio_outputs: u8,
    /// 每个设备一个随机 64 位十六进制 ID，与真实浏览器同长度
    pub device_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkInfo {
    pub effective_type: &'static str,
    pub rtt_ms: u32,
    pub downlink_mbps: f64,
    pub save_data: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageInfo {
    pub quota_bytes: u64,
    pub usage_bytes: u64,
    pub persisted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatteryInfo {
    pub charging: bool,
    pub level: f64,
    pub charging_time: u64,
    pub discharging_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MimeTypeInfo {
    pub mime_type: &'static str,
    pub suffixes: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct VoiceInfo {
    pub name: &'static str,
    pub lang: &'static str,
    pub local_service: bool,
    pub default: bool,
}

/// 完整仿真指纹。字段命名对齐浏览器 `navigator` / `screen` / `window` / WebGL 等
/// 可观测接口，方便未来做 JS 环境注入时直接按名取值。
#[derive(Debug, Clone, Serialize)]
pub struct BrowserFingerprint {
    pub user_agent: String,
    pub chrome_major: u32,
    pub chrome_version: String,
    /// navigator.userAgentData.brands
    pub brands: Vec<BrandVersion>,
    /// navigator.userAgentData.getHighEntropyValues().fullVersionList
    pub full_version_list: Vec<BrandVersion>,
    /// navigator.platform
    pub platform: &'static str,
    /// Sec-CH-UA-Platform（带引号的值由 headers 负责包装）
    pub ua_platform: &'static str,
    pub ua_platform_version: &'static str,
    pub ua_architecture: &'static str,
    pub ua_bitness: &'static str,
    pub ua_mobile: bool,
    pub ua_model: &'static str,
    pub ua_wow64: bool,
    pub ua_form_factors: Vec<&'static str>,
    pub language: &'static str,
    pub languages: Vec<&'static str>,
    pub timezone: &'static str,
    pub timezone_offset_minutes: i32,
    pub hardware_concurrency: u8,
    pub device_memory_gb: u8,
    pub color_scheme: &'static str,
    pub reduced_motion: bool,
    pub do_not_track: Option<&'static str>,
    pub navigator: NavigatorInfo,
    pub screen: ScreenInfo,
    pub window: WindowInfo,
    pub webgl: WebglInfo,
    pub webgpu: WebGpuInfo,
    pub audio: AudioInfo,
    pub media: MediaInfo,
    pub network: NetworkInfo,
    pub storage: StorageInfo,
    pub battery: BatteryInfo,
    /// 供 Canvas 噪声使用的种子（每份指纹独立随机）
    #[serde(serialize_with = "serialize_hex")]
    pub canvas_seed: u64,
    /// 供 AudioContext 噪声使用的种子（每份指纹独立随机）
    #[serde(serialize_with = "serialize_hex")]
    pub audio_seed: u64,
    pub fonts: Vec<&'static str>,
    pub plugins: Vec<&'static str>,
    pub mime_types: Vec<MimeTypeInfo>,
    pub voices: Vec<VoiceInfo>,
    pub api_features: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OsKind {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy)]
struct ScreenSpec {
    width: u32,
    height: u32,
    device_pixel_ratio: f64,
}

#[derive(Debug, Clone, Copy)]
struct GpuProfile {
    webgl_vendor: &'static str,
    webgl_renderer: &'static str,
    webgpu_vendor: &'static str,
    webgpu_architecture: &'static str,
    webgpu_device: &'static str,
}

struct OsProfile {
    platform: &'static str,
    ua_platform: &'static str,
    platform_versions: &'static [&'static str],
    architectures: &'static [&'static str],
    screens: &'static [ScreenSpec],
    /// 任务栏 / 菜单栏 + Dock 占用的高度，从屏幕高度里扣掉
    chrome_heights: &'static [u32],
    color_depth: u8,
    gpus: &'static [GpuProfile],
    fonts: &'static [&'static str],
    voices: &'static [VoiceInfo],
}

struct LocaleProfile {
    language: &'static str,
    languages: &'static [&'static str],
    timezone: &'static str,
    /// JS `Date#getTimezoneOffset` 语义：UTC+08:00 记为 -480
    timezone_offset_minutes: i32,
}

const LOCALES: &[LocaleProfile] = &[
    LocaleProfile {
        language: "zh-CN",
        languages: &["zh-CN", "zh", "en"],
        timezone: "Asia/Shanghai",
        timezone_offset_minutes: -480,
    },
    LocaleProfile {
        language: "zh-TW",
        languages: &["zh-TW", "zh", "en"],
        timezone: "Asia/Taipei",
        timezone_offset_minutes: -480,
    },
    LocaleProfile {
        language: "ja-JP",
        languages: &["ja-JP", "ja", "en"],
        timezone: "Asia/Tokyo",
        timezone_offset_minutes: -540,
    },
    LocaleProfile {
        language: "ko-KR",
        languages: &["ko-KR", "ko", "en"],
        timezone: "Asia/Seoul",
        timezone_offset_minutes: -540,
    },
    LocaleProfile {
        language: "en-US",
        languages: &["en-US", "en"],
        timezone: "America/New_York",
        timezone_offset_minutes: 300,
    },
    LocaleProfile {
        language: "en-US",
        languages: &["en-US", "en"],
        timezone: "America/Chicago",
        timezone_offset_minutes: 360,
    },
    LocaleProfile {
        language: "en-US",
        languages: &["en-US", "en"],
        timezone: "America/Los_Angeles",
        timezone_offset_minutes: 480,
    },
    LocaleProfile {
        language: "en-GB",
        languages: &["en-GB", "en"],
        timezone: "Europe/London",
        timezone_offset_minutes: 0,
    },
    LocaleProfile {
        language: "de-DE",
        languages: &["de-DE", "de", "en"],
        timezone: "Europe/Berlin",
        timezone_offset_minutes: -60,
    },
    LocaleProfile {
        language: "fr-FR",
        languages: &["fr-FR", "fr", "en"],
        timezone: "Europe/Paris",
        timezone_offset_minutes: -60,
    },
];

impl BrowserFingerprint {
    /// 生成一份新的随机指纹：各字段独立抽取，但按平台成套取值，保证组合自洽
    pub fn random() -> Self {
        let (major, full_version) = *pick(CHROME_VERSIONS);
        let chrome_major: u32 = major.parse().expect("Chrome 主版本必须是数字");
        let os = pick_os();
        let profile = os_profile(os);
        let locale = pick(LOCALES);
        let gpu = pick(profile.gpus);

        let spec = *pick(profile.screens);
        let chrome_height = *pick(profile.chrome_heights);
        let avail_height = spec.height.saturating_sub(chrome_height);
        let (brands, full_version_list) = make_brands(major, full_version);
        let user_agent = user_agent(os, major);
        let app_version = user_agent
            .strip_prefix("Mozilla/")
            .unwrap_or(&user_agent)
            .to_string();

        let (outer_width, outer_height, screen_x, screen_y) = window_geometry(spec, avail_height);
        let (frame_width, chrome_ui_height) = match os {
            OsKind::Windows => (16, 88),
            OsKind::Macos => (0, 87),
            OsKind::Linux => (0, 85),
        };
        let inner_width = outer_width.saturating_sub(frame_width).max(320);
        let inner_height = outer_height.saturating_sub(chrome_ui_height).max(240);

        let sample_rate = *pick(&[44100u32, 48000, 48000]);
        let touch_points = if os == OsKind::Windows {
            *pick(&[0u8, 0, 0, 10])
        } else {
            0
        };
        let battery_level = *pick(&[1.0, 1.0, 0.87, 0.76, 0.64]);
        let quota_bytes = (200 + next_u64() % 700) * 1024 * 1024 * 1024;
        let usage_bytes = (next_u64() % 2048) * 1024 * 1024;
        let (audio_inputs, video_inputs, audio_outputs) = (
            *pick(&[1u8, 1, 2]),
            *pick(&[0u8, 1, 1, 2]),
            *pick(&[1u8, 2, 2, 3]),
        );

        Self {
            user_agent,
            chrome_major,
            chrome_version: full_version.to_string(),
            brands,
            full_version_list,
            platform: profile.platform,
            ua_platform: profile.ua_platform,
            ua_platform_version: *pick(profile.platform_versions),
            ua_architecture: *pick(profile.architectures),
            ua_bitness: "64",
            ua_mobile: false,
            ua_model: "",
            ua_wow64: false,
            ua_form_factors: vec!["Desktop"],
            language: locale.language,
            languages: locale.languages.to_vec(),
            timezone: locale.timezone,
            timezone_offset_minutes: locale.timezone_offset_minutes,
            hardware_concurrency: *pick(&[4, 6, 8, 12, 16, 20, 24]),
            device_memory_gb: *pick(&[4, 8, 8, 16, 16, 32]),
            color_scheme: if chance(30) { "dark" } else { "light" },
            reduced_motion: chance(12),
            do_not_track: if chance(6) { Some("1") } else { None },
            navigator: NavigatorInfo {
                app_code_name: "Mozilla",
                app_name: "Netscape",
                app_version,
                product: "Gecko",
                product_sub: "20030107",
                vendor: "Google Inc.",
                vendor_sub: "",
                webdriver: false,
                cookie_enabled: true,
                on_line: true,
                pdf_viewer_enabled: true,
                max_touch_points: touch_points,
                global_privacy_control: chance(4),
            },
            screen: ScreenInfo {
                width: spec.width,
                height: spec.height,
                avail_width: spec.width,
                avail_height,
                color_depth: profile.color_depth,
                pixel_depth: profile.color_depth,
                device_pixel_ratio: spec.device_pixel_ratio,
                orientation: "landscape-primary",
                orientation_angle: 0,
                is_extended: false,
            },
            window: WindowInfo {
                device_pixel_ratio: spec.device_pixel_ratio,
                inner_width,
                inner_height,
                outer_width,
                outer_height,
                screen_x,
                screen_y,
            },
            webgl: WebglInfo {
                vendor: "WebKit",
                renderer: "WebKit WebGL",
                unmasked_vendor: gpu.webgl_vendor,
                unmasked_renderer: gpu.webgl_renderer,
                version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
                shading_language_version:
                    "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
                webgl2_version: "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
                max_texture_size: 16384,
                max_cube_map_texture_size: 16384,
                max_renderbuffer_size: 16384,
                max_viewport_dims: [32767, 32767],
                max_vertex_attribs: 16,
                max_texture_image_units: 16,
                max_combined_texture_image_units: 32,
                max_vertex_uniform_vectors: 4096,
                max_fragment_uniform_vectors: 1024,
                max_varying_vectors: 30,
                max_samples: *pick(&[4u8, 8]),
                antialias: true,
                alpha: true,
                depth: true,
                stencil: false,
                premultiplied_alpha: true,
                preserve_drawing_buffer: false,
                extensions: WEBGL_EXTENSIONS.to_vec(),
            },
            webgpu: WebGpuInfo {
                available: true,
                vendor: gpu.webgpu_vendor,
                architecture: gpu.webgpu_architecture,
                device: gpu.webgpu_device,
                description: "",
                fallback_adapter: false,
                features: webgpu_features(os),
                limits: WebGpuLimits {
                    max_texture_dimension_2d: 16384,
                    max_texture_array_layers: 2048,
                    max_bind_groups: 4,
                    max_bindings_per_bind_group: 1000,
                    max_dynamic_uniform_buffers_per_pipeline_layout: 8,
                    max_sampled_textures_per_shader_stage: 16,
                    max_samplers_per_shader_stage: 16,
                    max_storage_buffers_per_shader_stage: 10,
                    max_storage_textures_per_shader_stage: 8,
                    max_uniform_buffers_per_shader_stage: 12,
                    max_uniform_buffer_binding_size: 65536,
                    max_storage_buffer_binding_size: 134217728,
                    max_vertex_buffers: 8,
                    max_vertex_attributes: 16,
                    max_vertex_buffer_array_stride: 2048,
                    max_compute_workgroup_storage_size: 16384,
                    max_compute_invocations_per_workgroup: 256,
                    max_compute_workgroup_size_x: 256,
                    max_compute_workgroup_size_y: 256,
                    max_compute_workgroup_size_z: 64,
                    max_compute_workgroups_per_dimension: 65535,
                },
            },
            audio: AudioInfo {
                sample_rate,
                max_channel_count: 2,
                base_latency: if sample_rate == 44100 {
                    0.005804988662131519
                } else {
                    0.005333333333333333
                },
                output_latency: *pick(&[0.01, 0.016, 0.02, 0.032]),
                compressor: CompressorInfo {
                    threshold: -24.0,
                    knee: 30.0,
                    ratio: 12.0,
                    attack: 0.003,
                    release: 0.25,
                },
            },
            media: MediaInfo {
                audio_inputs,
                video_inputs,
                audio_outputs,
                device_ids: (0..audio_inputs + video_inputs + audio_outputs)
                    .map(|_| device_id())
                    .collect(),
            },
            network: NetworkInfo {
                effective_type: "4g",
                rtt_ms: *pick(&[50u32, 100, 150]),
                downlink_mbps: *pick(&[10.0, 9.5, 8.7, 12.5, 15.0]),
                save_data: false,
            },
            storage: StorageInfo {
                quota_bytes,
                usage_bytes,
                persisted: false,
            },
            battery: BatteryInfo {
                charging: true,
                level: battery_level,
                charging_time: if battery_level >= 1.0 {
                    0
                } else {
                    *pick(&[900u64, 1800, 3600, 5400])
                },
                discharging_time: None,
            },
            canvas_seed: next_u64(),
            audio_seed: next_u64(),
            fonts: profile.fonts.to_vec(),
            plugins: PLUGINS.to_vec(),
            mime_types: MIME_TYPES.to_vec(),
            voices: profile.voices.to_vec(),
            api_features: API_FEATURES.to_vec(),
        }
    }

    /// Sec-CH-UA 头的值，与 `brands` 保持一致
    pub fn sec_ch_ua(&self) -> String {
        brand_list(&self.brands)
    }

    /// Sec-CH-UA-Full-Version-List 头的值，与 `full_version_list` 保持一致
    pub fn sec_ch_ua_full_version_list(&self) -> String {
        brand_list(&self.full_version_list)
    }

    /// Accept-Language 头的值，与 `languages` 保持一致
    pub fn accept_language(&self) -> String {
        self.languages
            .iter()
            .enumerate()
            .map(|(index, language)| {
                if index == 0 {
                    (*language).to_string()
                } else {
                    format!("{language};q=0.{}", 10 - index)
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    /// 导航类请求（浏览器地址栏直达）的完整请求头
    pub fn headers(&self) -> HeaderMap {
        let mut map = HeaderMap::new();
        insert(&mut map, "user-agent", &self.user_agent);
        insert(&mut map, "accept", ACCEPT);
        insert(&mut map, "accept-language", &self.accept_language());
        insert(&mut map, "sec-ch-ua", &self.sec_ch_ua());
        insert(
            &mut map,
            "sec-ch-ua-mobile",
            if self.ua_mobile { "?1" } else { "?0" },
        );
        insert(&mut map, "sec-ch-ua-platform", &quoted(self.ua_platform));
        insert(
            &mut map,
            "sec-ch-ua-platform-version",
            &quoted(self.ua_platform_version),
        );
        insert(&mut map, "sec-ch-ua-arch", &quoted(self.ua_architecture));
        insert(&mut map, "sec-ch-ua-bitness", &quoted(self.ua_bitness));
        insert(
            &mut map,
            "sec-ch-ua-model",
            &if self.ua_model.is_empty() {
                "\"\"".to_string()
            } else {
                quoted(self.ua_model)
            },
        );
        insert(
            &mut map,
            "sec-ch-ua-full-version-list",
            &self.sec_ch_ua_full_version_list(),
        );
        insert(&mut map, "sec-ch-ua-full-version", &self.chrome_version);
        insert(
            &mut map,
            "sec-ch-ua-wow64",
            if self.ua_wow64 { "?1" } else { "?0" },
        );
        insert(
            &mut map,
            "sec-ch-ua-form-factors",
            &quoted_list(&self.ua_form_factors),
        );
        insert(
            &mut map,
            "sec-ch-dpr",
            &quoted(&format!("{}", self.screen.device_pixel_ratio)),
        );
        insert(
            &mut map,
            "sec-ch-viewport-width",
            &quoted(&self.window.inner_width.to_string()),
        );
        insert(
            &mut map,
            "sec-ch-prefers-color-scheme",
            &quoted(self.color_scheme),
        );
        insert(
            &mut map,
            "sec-ch-prefers-reduced-motion",
            &quoted(if self.reduced_motion {
                "reduce"
            } else {
                "no-preference"
            }),
        );
        insert(
            &mut map,
            "device-memory",
            &self.device_memory_gb.to_string(),
        );
        insert(&mut map, "sec-fetch-site", "none");
        insert(&mut map, "sec-fetch-mode", "navigate");
        insert(&mut map, "sec-fetch-dest", "document");
        insert(&mut map, "sec-fetch-user", "?1");
        insert(&mut map, "upgrade-insecure-requests", "1");
        map
    }
}

/// 本机平台出现概率更高：下载站按 UA 分发不同安装包时，多数情况仍拿到本平台文件；
/// 其余平台随机出现，保证每次调用都可能换一套身份。
fn pick_os() -> OsKind {
    if cfg!(target_os = "macos") {
        *pick(&[OsKind::Macos, OsKind::Macos, OsKind::Windows, OsKind::Linux])
    } else if cfg!(target_os = "linux") {
        *pick(&[OsKind::Linux, OsKind::Linux, OsKind::Windows, OsKind::Macos])
    } else {
        *pick(&[OsKind::Windows, OsKind::Windows, OsKind::Macos, OsKind::Linux])
    }
}

fn window_geometry(spec: ScreenSpec, avail_height: u32) -> (u32, u32, i32, i32) {
    if chance(65) {
        return (spec.width, avail_height, 0, 0);
    }
    let outer_width = spec.width.saturating_sub(80 + (next_u64() % 240) as u32);
    let outer_height = avail_height.saturating_sub(60 + (next_u64() % 160) as u32);
    let max_x = spec.width.saturating_sub(outer_width).max(1) as u64;
    let max_y = avail_height.saturating_sub(outer_height).max(1) as u64;
    (
        outer_width,
        outer_height,
        (next_u64() % max_x) as i32,
        (next_u64() % max_y) as i32,
    )
}

fn os_profile(os: OsKind) -> OsProfile {
    match os {
        OsKind::Windows => OsProfile {
            platform: "Win32",
            ua_platform: "Windows",
            platform_versions: &["15.0.0", "10.0.0"],
            architectures: &["x86"],
            screens: &[
                ScreenSpec {
                    width: 1920,
                    height: 1080,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 2560,
                    height: 1440,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 1366,
                    height: 768,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 1536,
                    height: 864,
                    device_pixel_ratio: 1.25,
                },
                ScreenSpec {
                    width: 1600,
                    height: 900,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 3840,
                    height: 2160,
                    device_pixel_ratio: 1.5,
                },
                ScreenSpec {
                    width: 2880,
                    height: 1800,
                    device_pixel_ratio: 1.5,
                },
            ],
            chrome_heights: &[40, 48, 56],
            color_depth: 24,
            gpus: &[
                GpuProfile {
                    webgl_vendor: "Google Inc. (NVIDIA)",
                    webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                    webgpu_vendor: "nvidia",
                    webgpu_architecture: "ampere",
                    webgpu_device: "NVIDIA GeForce RTX 3060",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (NVIDIA)",
                    webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                    webgpu_vendor: "nvidia",
                    webgpu_architecture: "ada",
                    webgpu_device: "NVIDIA GeForce RTX 4060",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (NVIDIA)",
                    webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)",
                    webgpu_vendor: "nvidia",
                    webgpu_architecture: "turing",
                    webgpu_device: "NVIDIA GeForce GTX 1660 SUPER",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Intel)",
                    webgl_renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                    webgpu_vendor: "intel",
                    webgpu_architecture: "gen-9",
                    webgpu_device: "Intel(R) UHD Graphics 630",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Intel)",
                    webgl_renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
                    webgpu_vendor: "intel",
                    webgpu_architecture: "gen-12lp",
                    webgpu_device: "Intel(R) Iris(R) Xe Graphics",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (AMD)",
                    webgl_renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                    webgpu_vendor: "amd",
                    webgpu_architecture: "rdna-2",
                    webgpu_device: "AMD Radeon RX 6600",
                },
            ],
            fonts: &[
                "Arial",
                "Arial Black",
                "Calibri",
                "Cambria",
                "Candara",
                "Comic Sans MS",
                "Consolas",
                "Constantia",
                "Corbel",
                "Courier New",
                "Franklin Gothic Medium",
                "Gabriola",
                "Georgia",
                "Impact",
                "Lucida Console",
                "Lucida Sans Unicode",
                "Malgun Gothic",
                "Microsoft YaHei",
                "Palatino Linotype",
                "Segoe Print",
                "Segoe Script",
                "Segoe UI",
                "SimSun",
                "Tahoma",
                "Times New Roman",
                "Trebuchet MS",
                "Verdana",
                "Webdings",
                "Wingdings",
            ],
            voices: WINDOWS_VOICES,
        },
        OsKind::Macos => OsProfile {
            platform: "MacIntel",
            ua_platform: "macOS",
            platform_versions: &["15.1.0", "14.6.0", "13.6.0"],
            architectures: &["arm", "x86"],
            screens: &[
                ScreenSpec {
                    width: 1512,
                    height: 982,
                    device_pixel_ratio: 2.0,
                },
                ScreenSpec {
                    width: 1728,
                    height: 1117,
                    device_pixel_ratio: 2.0,
                },
                ScreenSpec {
                    width: 1470,
                    height: 956,
                    device_pixel_ratio: 2.0,
                },
                ScreenSpec {
                    width: 1440,
                    height: 900,
                    device_pixel_ratio: 2.0,
                },
                ScreenSpec {
                    width: 1920,
                    height: 1080,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 2560,
                    height: 1440,
                    device_pixel_ratio: 1.0,
                },
            ],
            chrome_heights: &[25, 38],
            color_depth: 30,
            gpus: &[
                GpuProfile {
                    webgl_vendor: "Google Inc. (Apple)",
                    webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
                    webgpu_vendor: "apple",
                    webgpu_architecture: "apple-m1",
                    webgpu_device: "Apple M1",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Apple)",
                    webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
                    webgpu_vendor: "apple",
                    webgpu_architecture: "apple-m2",
                    webgpu_device: "Apple M2",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Apple)",
                    webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
                    webgpu_vendor: "apple",
                    webgpu_architecture: "apple-m3",
                    webgpu_device: "Apple M3",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Apple)",
                    webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)",
                    webgpu_vendor: "apple",
                    webgpu_architecture: "apple-m4",
                    webgpu_device: "Apple M4",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Intel)",
                    webgl_renderer: "ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)",
                    webgpu_vendor: "intel",
                    webgpu_architecture: "gen-11",
                    webgpu_device: "Intel(R) Iris(TM) Plus Graphics",
                },
            ],
            fonts: &[
                "American Typewriter",
                "Andale Mono",
                "Arial",
                "Arial Black",
                "Avenir",
                "Avenir Next",
                "Baskerville",
                "Courier New",
                "Futura",
                "Georgia",
                "Helvetica",
                "Helvetica Neue",
                "Herculanum",
                "Impact",
                "Lucida Grande",
                "Menlo",
                "Monaco",
                "Optima",
                "Palatino",
                "PingFang SC",
                "San Francisco",
                "Skia",
                "Times New Roman",
                "Trebuchet MS",
                "Verdana",
            ],
            voices: MACOS_VOICES,
        },
        OsKind::Linux => OsProfile {
            platform: "Linux x86_64",
            ua_platform: "Linux",
            platform_versions: &["6.11.0", "6.8.0", "5.15.0"],
            architectures: &["x86"],
            screens: &[
                ScreenSpec {
                    width: 1920,
                    height: 1080,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 2560,
                    height: 1440,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 1366,
                    height: 768,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 1680,
                    height: 1050,
                    device_pixel_ratio: 1.0,
                },
                ScreenSpec {
                    width: 3840,
                    height: 2160,
                    device_pixel_ratio: 1.0,
                },
            ],
            chrome_heights: &[27, 40],
            color_depth: 24,
            gpus: &[
                GpuProfile {
                    webgl_vendor: "Google Inc. (Intel)",
                    webgl_renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
                    webgpu_vendor: "intel",
                    webgpu_architecture: "gen-9",
                    webgpu_device: "Mesa Intel(R) UHD Graphics 620",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (Intel)",
                    webgl_renderer: "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6)",
                    webgpu_vendor: "intel",
                    webgpu_architecture: "gen-12lp",
                    webgpu_device: "Mesa Intel(R) Iris(R) Xe Graphics",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (AMD)",
                    webgl_renderer: "ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navi23, LLVM 17.0.6, DRM 3.54, 6.8.0), OpenGL 4.6)",
                    webgpu_vendor: "amd",
                    webgpu_architecture: "rdna-2",
                    webgpu_device: "AMD Radeon RX 6600 (radeonsi, navi23)",
                },
                GpuProfile {
                    webgl_vendor: "Google Inc. (NVIDIA)",
                    webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (nvidia), OpenGL 4.6)",
                    webgpu_vendor: "nvidia",
                    webgpu_architecture: "turing",
                    webgpu_device: "NVIDIA GeForce GTX 1660 SUPER",
                },
            ],
            fonts: &[
                "Arial",
                "Bitstream Charter",
                "Century Schoolbook L",
                "Courier 10 Pitch",
                "DejaVu Sans",
                "DejaVu Sans Mono",
                "DejaVu Serif",
                "Droid Sans",
                "FreeMono",
                "FreeSans",
                "FreeSerif",
                "Liberation Mono",
                "Liberation Sans",
                "Liberation Serif",
                "Nimbus Mono PS",
                "Nimbus Roman",
                "Nimbus Sans",
                "Noto Color Emoji",
                "Noto Sans",
                "Noto Sans CJK SC",
                "Noto Serif",
                "Ubuntu",
                "Ubuntu Mono",
            ],
            voices: LINUX_VOICES,
        },
    }
}

fn user_agent(os: OsKind, version: &str) -> String {
    let platform = match os {
        OsKind::Windows => "Windows NT 10.0; Win64; x64",
        OsKind::Macos => "Macintosh; Intel Mac OS X 10_15_7",
        OsKind::Linux => "X11; Linux x86_64",
    };
    format!(
        "Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version}.0.0.0 Safari/537.36"
    )
}

/// 品牌顺序是随机的（Chrome 本身也会打乱 GREASE 品牌的位置），版本与主版本保持一致
fn make_brands(major: &str, full_version: &str) -> (Vec<BrandVersion>, Vec<BrandVersion>) {
    let mut entries = vec![
        ("Chromium", major.to_string(), full_version.to_string()),
        ("Google Chrome", major.to_string(), full_version.to_string()),
        ("Not_A Brand", "99".to_string(), "99.0.0.0".to_string()),
    ];
    shuffle(&mut entries);
    let brands = entries
        .iter()
        .map(|(brand, version, _)| BrandVersion {
            brand: (*brand).to_string(),
            version: version.clone(),
        })
        .collect();
    let full = entries
        .iter()
        .map(|(brand, _, version)| BrandVersion {
            brand: (*brand).to_string(),
            version: version.clone(),
        })
        .collect();
    (brands, full)
}

fn webgpu_features(os: OsKind) -> Vec<&'static str> {
    let mut features = vec![
        "depth-clip-control",
        "depth32float-stencil8",
        "indirect-first-instance",
        "rg11b10ufloat-renderable",
        "shader-f16",
        "timestamp-query",
        "bgra8unorm-storage",
        "float32-filterable",
        "dual-source-blending",
        "clip-distances",
        "subgroups",
    ];
    if os == OsKind::Macos {
        features.extend_from_slice(&[
            "texture-compression-etc2",
            "texture-compression-astc",
        ]);
    } else {
        features.push("texture-compression-bc");
    }
    features
}

/// 系统随机源；拿不到随机数属于环境异常，直接 panic 比悄悄退化成固定指纹更安全
fn next_u64() -> u64 {
    let mut bytes = [0u8; 8];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("系统随机源不可用");
    u64::from_le_bytes(bytes)
}

fn pick<'a, T>(items: &'a [T]) -> &'a T {
    &items[(next_u64() % items.len() as u64) as usize]
}

fn chance(percent: u64) -> bool {
    next_u64() % 100 < percent
}

fn shuffle<T>(items: &mut [T]) {
    for index in (1..items.len()).rev() {
        let swap = (next_u64() % (index as u64 + 1)) as usize;
        items.swap(index, swap);
    }
}

fn device_id() -> String {
    (0..4)
        .map(|_| format!("{:016x}", next_u64()))
        .collect::<String>()
}

fn brand_list(brands: &[BrandVersion]) -> String {
    brands
        .iter()
        .map(|brand| format!("\"{}\";v=\"{}\"", brand.brand, brand.version))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 加引号（UA-CH 的结构化头要求字符串值带引号）
fn quoted(value: &str) -> String {
    format!("\"{value}\"")
}

fn quoted_list(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| quoted(value))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 种子按十六进制字符串传输：u64 直接走 JSON 会超出 JS 的安全整数范围，显示出来是错的
fn serialize_hex<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&format!("{value:016x}"))
}

fn insert(map: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        map.insert(HeaderName::from_static(name), value);
    }
}

/// 生成一份新的随机指纹（设置 → 工具箱 → 指纹信息）
#[tauri::command]
pub fn fingerprint_info() -> BrowserFingerprint {
    BrowserFingerprint::random()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_vary_between_calls() {
        let samples: Vec<BrowserFingerprint> =
            (0..16).map(|_| BrowserFingerprint::random()).collect();
        assert!(
            samples
                .iter()
                .map(|fp| fp.canvas_seed)
                .collect::<std::collections::HashSet<_>>()
                .len()
                > 1
        );
        assert!(samples.windows(2).any(|pair| {
            pair[0].user_agent != pair[1].user_agent
                || pair[0].canvas_seed != pair[1].canvas_seed
                || pair[0].webgl.unmasked_renderer != pair[1].webgl.unmasked_renderer
                || pair[0].language != pair[1].language
        }));
    }

    #[test]
    fn headers_match_fingerprint() {
        for _ in 0..32 {
            let fp = BrowserFingerprint::random();
            let headers = fp.headers();
            assert_eq!(
                headers.get("user-agent").unwrap().to_str().unwrap(),
                fp.user_agent
            );
            let ch_ua = headers.get("sec-ch-ua").unwrap().to_str().unwrap();
            assert!(ch_ua.contains(&format!("v=\"{}\"", fp.chrome_major)));
            assert!(ch_ua.contains("Chromium"));
            assert!(ch_ua.contains("Google Chrome"));
            assert_eq!(
                headers.get("sec-ch-ua-platform").unwrap().to_str().unwrap(),
                format!("\"{}\"", fp.ua_platform)
            );
            assert_eq!(
                headers
                    .get("sec-ch-ua-full-version")
                    .unwrap()
                    .to_str()
                    .unwrap(),
                fp.chrome_version
            );
            assert_eq!(
                headers.get("accept-language").unwrap().to_str().unwrap(),
                fp.accept_language()
            );
            assert_eq!(headers.get("sec-fetch-mode").unwrap(), "navigate");
            assert_eq!(
                headers.get("sec-ch-viewport-width").unwrap().to_str().unwrap(),
                format!("\"{}\"", fp.window.inner_width)
            );
            // 下载拿原始字节：不能声明压缩，否则 Range / Content-Length 会对不上
            assert!(headers.get("accept-encoding").is_none());
        }
    }

    #[test]
    fn user_agent_and_platform_agree() {
        for _ in 0..64 {
            let fp = BrowserFingerprint::random();
            match fp.ua_platform {
                "Windows" => {
                    assert!(fp.user_agent.contains("Windows NT"));
                    assert_eq!(fp.platform, "Win32");
                    assert!(fp.webgl.unmasked_renderer.contains("Direct3D11"));
                }
                "macOS" => {
                    assert!(fp.user_agent.contains("Macintosh"));
                    assert_eq!(fp.platform, "MacIntel");
                    assert!(fp.webgl.unmasked_renderer.contains("Metal"));
                }
                _ => {
                    assert!(fp.user_agent.contains("X11; Linux"));
                    assert_eq!(fp.platform, "Linux x86_64");
                    assert!(fp.webgl.unmasked_renderer.contains("OpenGL"));
                }
            }
            assert_eq!(fp.language, fp.languages[0]);
            assert!(fp.accept_language().starts_with(fp.languages[0]));
            assert_eq!(
                fp.navigator.app_version,
                fp.user_agent.trim_start_matches("Mozilla/")
            );
            assert_eq!(fp.screen.avail_width, fp.screen.width);
            assert!(fp.screen.avail_height < fp.screen.height);
            assert!(fp.screen.device_pixel_ratio > 0.0);
            assert_eq!(fp.screen.color_depth, fp.screen.pixel_depth);
            assert_eq!(fp.window.device_pixel_ratio, fp.screen.device_pixel_ratio);
            assert!(fp.window.inner_width <= fp.window.outer_width);
            assert!(fp.window.inner_height <= fp.window.outer_height);
            assert!(fp.window.outer_width <= fp.screen.width);
            assert!(fp.window.outer_height <= fp.screen.avail_height);
            assert!(fp.window.screen_x >= 0 && fp.window.screen_y >= 0);
        }
    }

    #[test]
    fn ua_ch_versions_are_coherent() {
        for _ in 0..32 {
            let fp = BrowserFingerprint::random();
            let chrome = fp
                .brands
                .iter()
                .find(|brand| brand.brand == "Google Chrome")
                .unwrap();
            assert_eq!(chrome.version, fp.chrome_major.to_string());
            let full = fp
                .full_version_list
                .iter()
                .find(|brand| brand.brand == "Google Chrome")
                .unwrap();
            assert_eq!(full.version, fp.chrome_version);
            assert!(full.version.starts_with(&format!("{}.", fp.chrome_major)));
            assert_eq!(fp.brands.len(), fp.full_version_list.len());
            assert_eq!(fp.ua_form_factors, vec!["Desktop"]);
        }
    }

    #[test]
    fn hardware_and_media_are_coherent() {
        for _ in 0..64 {
            let fp = BrowserFingerprint::random();
            assert!(fp.hardware_concurrency >= 4);
            assert!(fp.device_memory_gb >= 4);
            assert_eq!(
                fp.media.device_ids.len() as u8,
                fp.media.audio_inputs + fp.media.video_inputs + fp.media.audio_outputs
            );
            assert!(fp.media.device_ids.iter().all(|id| id.len() == 64));
            assert!(fp.storage.quota_bytes > fp.storage.usage_bytes);
            assert!(fp.storage.quota_bytes < (1u64 << 53));
            assert!(fp.battery.level > 0.0 && fp.battery.level <= 1.0);
            assert!(fp.network.rtt_ms >= 50);
            assert!(fp.network.downlink_mbps > 0.0);
            assert!(!fp.navigator.webdriver);
            assert!(fp.navigator.cookie_enabled);
            assert!(fp.navigator.on_line);
            assert!(fp.navigator.pdf_viewer_enabled);
        }
    }

    #[test]
    fn graphics_and_audio_are_coherent() {
        for _ in 0..64 {
            let fp = BrowserFingerprint::random();
            assert!(fp.webgl.version.contains("WebGL 1.0"));
            assert!(fp.webgl.webgl2_version.contains("WebGL 2.0"));
            assert!(!fp.webgl.extensions.is_empty());
            assert!(fp.webgl.max_texture_size >= 8192);
            assert!(fp.webgl.max_samples == 4 || fp.webgl.max_samples == 8);
            assert!(fp.webgpu.available);
            assert!(!fp.webgpu.features.is_empty());
            assert!(fp
                .webgl
                .unmasked_vendor
                .to_lowercase()
                .contains(fp.webgpu.vendor));
            assert!(fp.audio.sample_rate == 44100 || fp.audio.sample_rate == 48000);
            assert!(fp.audio.max_channel_count >= 2);
            assert!(fp.audio.compressor.ratio > 0.0);
            assert!(!fp.voices.is_empty());
            assert!(fp.voices.iter().filter(|voice| voice.default).count() <= 1);
            assert!(!fp.mime_types.is_empty());
            assert!(!fp.api_features.is_empty());
        }
    }

    #[test]
    fn seeds_serialize_as_hex_strings() {
        let value = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        // u64 走 JSON number 会超出 JS 安全整数范围，必须序列化成字符串
        assert!(value["canvas_seed"].is_string());
        assert!(value["audio_seed"].is_string());
        assert_eq!(value["canvas_seed"].as_str().unwrap().len(), 16);
        assert_eq!(value["audio_seed"].as_str().unwrap().len(), 16);
        assert_eq!(value["language"], value["languages"][0]);
        assert!(value["navigator"]["app_version"].is_string());
        assert_eq!(
            value["window"]["device_pixel_ratio"],
            value["screen"]["device_pixel_ratio"]
        );
    }
}
