//! 浏览器指纹生成：UA / 品牌 / 屏幕 / WebGL / WebGPU / 语种。
//!
//! - `data`：版本表、插件表、机型表、语种表等常量（改数据只需要动这一个文件）
//! - `profiles`：按操作系统挑选机型、屏幕、UA 与 WebGPU 特性
//! - `random`：随机工具与请求头拼装
//! - `mod`：类型定义与对外命令

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
    /// WebGL2 的 `SHADING_LANGUAGE_VERSION`，与 WebGL1 的 GLSL ES 1.0 不同
    pub webgl2_shading_language_version: &'static str,
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
pub(crate) enum OsKind {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ScreenSpec {
    width: u32,
    height: u32,
    device_pixel_ratio: f64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct GpuProfile {
    webgl_vendor: &'static str,
    webgl_renderer: &'static str,
    webgpu_vendor: &'static str,
    webgpu_architecture: &'static str,
    webgpu_device: &'static str,
}

pub(crate) struct OsProfile {
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

pub(crate) struct LocaleProfile {
    language: &'static str,
    languages: &'static [&'static str],
    timezone: &'static str,
    /// JS `Date#getTimezoneOffset` 语义：UTC+08:00 记为 -480
    timezone_offset_minutes: i32,
}

impl BrowserFingerprint {
    /// 生成一份新的随机指纹：各字段独立抽取，但按平台成套取值，保证组合自洽
    pub fn random() -> Self {
        let (major, full_version) = *pick(CHROME_VERSIONS);
        Self::generate(major, full_version, pick_os(), pick(LOCALES))
    }

    /// 内置浏览器专用的身份：操作系统、时区 / 语言、Chrome 版本都钉在本机真实值上，
    /// 其余字段照旧随机。
    ///
    /// 这三项不能随机：字体、显卡、屏幕缩放都来自真实系统（声明成别的系统会出现
    /// 「UA 是 macOS、字体却全是 Segoe UI」）；时区 / 语言要和出口 IP 对得上；
    /// 页面能按 API 探测出引擎版本，声明得比内核旧（或新）都会被判不一致。
    pub fn for_browser(major: &str, full_version: &str) -> Self {
        Self::generate(major, full_version, host_os(), pick_locale())
    }

    fn generate(
        major: &str,
        full_version: &str,
        os: OsKind,
        locale: &'static LocaleProfile,
    ) -> Self {
        let chrome_major: u32 = major.parse().expect("Chrome 主版本必须是数字");
        let profile = os_profile(os);
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
                webgl2_shading_language_version:
                    "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
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

/// 生成一份新的随机指纹（设置 → 工具箱 → 指纹信息）
#[tauri::command]
pub fn fingerprint_info() -> BrowserFingerprint {
    BrowserFingerprint::random()
}


mod data;
mod profiles;
mod random;
#[cfg(test)]
mod tests;

pub(crate) use data::*;
pub(crate) use profiles::*;
pub(crate) use random::*;
