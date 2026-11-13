use super::*;

pub(crate) const ACCEPT: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

/// 可选的 Chrome 版本：UA 里是主版本（`142.0.0.0`），UA-CH 里是完整版本
pub(crate) const CHROME_VERSIONS: &[(&str, &str)] = &[
    ("146", "146.0.7680.80"),
    ("145", "145.0.7632.46"),
    ("144", "144.0.7559.60"),
    ("143", "143.0.7499.41"),
    ("142", "142.0.7444.60"),
    ("141", "141.0.7390.55"),
    ("140", "140.0.7339.82"),
    ("139", "139.0.7258.67"),
];

pub(crate) const PLUGINS: &[&str] = &[
    "PDF Viewer",
    "Chrome PDF Viewer",
    "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer",
    "WebKit built-in PDF",
];

pub(crate) const MIME_TYPES: &[MimeTypeInfo] = &[
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

pub(crate) const API_FEATURES: &[&str] = &[
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
pub(crate) const WEBGL_EXTENSIONS: &[&str] = &[
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

pub(crate) const WINDOWS_VOICES: &[VoiceInfo] = &[
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

pub(crate) const MACOS_VOICES: &[VoiceInfo] = &[
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

pub(crate) const LINUX_VOICES: &[VoiceInfo] = &[
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

pub(crate) const LOCALES: &[LocaleProfile] = &[
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

