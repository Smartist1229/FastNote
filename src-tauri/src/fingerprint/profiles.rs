use super::*;

/// 本机平台出现概率更高：下载站按 UA 分发不同安装包时，多数情况仍拿到本平台文件；
/// 其余平台随机出现，保证每次调用都可能换一套身份。
pub(crate) fn pick_os() -> OsKind {
    if cfg!(target_os = "macos") {
        *pick(&[OsKind::Macos, OsKind::Macos, OsKind::Windows, OsKind::Linux])
    } else if cfg!(target_os = "linux") {
        *pick(&[OsKind::Linux, OsKind::Linux, OsKind::Windows, OsKind::Macos])
    } else {
        *pick(&[OsKind::Windows, OsKind::Windows, OsKind::Macos, OsKind::Linux])
    }
}

/// 内置浏览器的身份必须是本机系统：网页能探到的字体、显卡、屏幕缩放都来自真实系统，
/// 声明成别的系统会出现「UA 是 macOS、字体却全是 Segoe UI」这类硬伤，
/// 指纹检测直接判「字体与操作系统不符 / 厂商与真实硬件不符」。
pub(crate) fn host_os() -> OsKind {
    if cfg!(target_os = "macos") {
        OsKind::Macos
    } else if cfg!(target_os = "linux") {
        OsKind::Linux
    } else {
        OsKind::Windows
    }
}

pub(crate) fn window_geometry(spec: ScreenSpec, avail_height: u32) -> (u32, u32, i32, i32) {
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

pub(crate) fn os_profile(os: OsKind) -> OsProfile {
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

pub(crate) fn user_agent(os: OsKind, version: &str) -> String {
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
pub(crate) fn make_brands(major: &str, full_version: &str) -> (Vec<BrandVersion>, Vec<BrandVersion>) {
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

pub(crate) fn webgpu_features(os: OsKind) -> Vec<&'static str> {
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

