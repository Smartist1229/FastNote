/**
 * 设置 · 工具箱 · 指纹信息：展示一份随机生成的完整仿真浏览器指纹。
 *
 * 数据来自 Rust 的 `fingerprint_info`：每次调用都会重新随机生成，
 * 与下载客户端创建时取到的指纹同源（UA / UA-CH / 屏幕 / WebGL / WebGPU / 音频等）。
 */
import { useCallback, useEffect, useState } from "react";
import { getFingerprint } from "@/api/fingerprint";
import type { BrowserFingerprint, FingerprintBrand } from "@/interface/fingerprint";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const brandText = (brands: FingerprintBrand[]): string =>
  brands.map((b) => `${b.brand} ${b.version}`).join(" · ");

/** JS 的 getTimezoneOffset 语义：-480 => UTC+08:00 */
const timezoneText = (fp: BrowserFingerprint): string => {
  const offset = fp.timezone_offset_minutes;
  const sign = offset <= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${fp.timezone} · UTC${sign}${hh}:${mm}`;
};

const boolText = (value: boolean): string => (value ? "是" : "否");

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const Row: React.FC<{ label: string; mono?: boolean; children: React.ReactNode }> = ({
  label,
  mono = false,
  children,
}) => (
  <div className="flex items-start gap-3 py-1.5">
    <span className="w-[88px] flex-shrink-0 text-[11px] leading-relaxed text-faint">{label}</span>
    <span
      className={`min-w-0 flex-1 selectable break-all text-[11.5px] leading-relaxed text-body ${
        mono ? "font-mono text-[10.5px]" : ""
      }`}
    >
      {children}
    </span>
  </div>
);

const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex max-w-full items-center rounded-md border border-line-soft bg-app px-1.5 py-0.5 text-[10.5px] leading-relaxed text-faint">
    {children}
  </span>
);

const Chips: React.FC<{ values: string[] }> = ({ values }) => (
  <div className="flex flex-wrap gap-1 py-1">
    {values.map((value) => (
      <Chip key={value}>{value}</Chip>
    ))}
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="overflow-hidden rounded-xl border border-line bg-surface">
    <p className="border-b border-line-soft px-3.5 py-2 text-xs font-medium text-body">{title}</p>
    <div className="px-3.5 py-1.5">{children}</div>
  </div>
);

export const FingerprintPanel: React.FC = () => {
  const [fingerprint, setFingerprint] = useState<BrowserFingerprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await getFingerprint();
      setFingerprint(value);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="rounded-xl border border-danger-line bg-danger-soft px-3.5 py-3 text-[11px] leading-relaxed text-danger-strong">
        读取指纹失败：{error}
      </p>
    );
  }
  if (!fingerprint) {
    return <p className="px-1 py-2 text-[11px] text-faint">正在生成指纹…</p>;
  }

  const fp = fingerprint;
  const screen = fp.screen;
  const win = fp.window;
  const webgl = fp.webgl;
  const webgpu = fp.webgpu;
  const audio = fp.audio;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 px-1">
        <p className="flex-1 text-[11px] leading-relaxed text-faint">
          每次下载任务都会随机生成一份新的仿真浏览器身份；这里展示的是其中一份示例。
          UA、UA-CH、屏幕、窗口、WebGL / WebGPU、音频、媒体设备、网络与字体按平台成套生成，
          避免出现自相矛盾的组合。
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint transition-colors hover:bg-surface-alt hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
          title="重新随机生成一份指纹"
        >
          {loading ? "生成中…" : "换一个"}
        </button>
      </div>

      <Section title="基础信息">
        <Row label="浏览器">
          Chrome {fp.chrome_major}（{fp.chrome_version}）
        </Row>
        <Row label="User-Agent" mono>
          {fp.user_agent}
        </Row>
        <Row label="平台">
          {fp.platform}（{fp.ua_platform} {fp.ua_platform_version}）
        </Row>
        <Row label="架构">
          {fp.ua_architecture} / {fp.ua_bitness} 位 · {fp.ua_mobile ? "移动端" : "桌面端"} · WoW64{" "}
          {boolText(fp.ua_wow64)}
        </Row>
        <Row label="设备形态">{fp.ua_form_factors.join(", ")}</Row>
        <Row label="语言">
          {fp.language} · {fp.languages.join(", ")}
        </Row>
        <Row label="时区">{timezoneText(fp)}</Row>
        <Row label="硬件">
          {fp.hardware_concurrency} 核 · {fp.device_memory_gb} GB 内存 · 触摸点{" "}
          {fp.navigator.max_touch_points}
        </Row>
        <Row label="偏好">
          {fp.color_scheme === "dark" ? "深色" : "浅色"} · 减少动画：
          {boolText(fp.reduced_motion)} · DNT：{fp.do_not_track ?? "未设置"}
        </Row>
      </Section>

      <Section title="Navigator 属性">
        <Row label="appCodeName">{fp.navigator.app_code_name}</Row>
        <Row label="appName">{fp.navigator.app_name}</Row>
        <Row label="appVersion" mono>
          {fp.navigator.app_version}
        </Row>
        <Row label="product / sub">
          {fp.navigator.product} / {fp.navigator.product_sub}
        </Row>
        <Row label="vendor / sub">
          {fp.navigator.vendor} / {fp.navigator.vendor_sub || "—"}
        </Row>
        <Row label="webdriver">{boolText(fp.navigator.webdriver)}</Row>
        <Row label="Cookie / 在线">
          {boolText(fp.navigator.cookie_enabled)} / {boolText(fp.navigator.on_line)}
        </Row>
        <Row label="PDF 查看器">{boolText(fp.navigator.pdf_viewer_enabled)}</Row>
        <Row label="GPC">{boolText(fp.navigator.global_privacy_control)}</Row>
      </Section>

      <Section title="UA-CH 与 Client Hints">
        <Row label="品牌">{brandText(fp.brands)}</Row>
        <Row label="完整版本">{brandText(fp.full_version_list)}</Row>
        <Row label="完整版本号" mono>
          {fp.chrome_version}
        </Row>
        <Row label="平台版本" mono>
          {fp.ua_platform_version}
        </Row>
        <Row label="架构 / 位数" mono>
          {fp.ua_architecture} / {fp.ua_bitness} 位
        </Row>
        <Row label="WoW64 / 型号" mono>
          {fp.ua_wow64 ? "?1" : "?0"} / {fp.ua_model || '""'}
        </Row>
        <Row label="形态" mono>
          {fp.ua_form_factors.map((item) => `"${item}"`).join(", ")}
        </Row>
        <Row label="偏好提示" mono>
          color-scheme={fp.color_scheme} · reduced-motion=
          {fp.reduced_motion ? "reduce" : "no-preference"}
        </Row>
        <Row label="设备内存" mono>
          {fp.device_memory_gb}
        </Row>
        <Row label="DPR / 视口" mono>
          {screen.device_pixel_ratio} / {win.inner_width}
        </Row>
        <Row label="Fetch Metadata" mono>
          none / navigate / document / ?1
        </Row>
        <Row label="压缩请求头" mono>
          不发送 Accept-Encoding（下载读取原始字节）
        </Row>
      </Section>

      <Section title="屏幕与窗口">
        <Row label="屏幕">
          {screen.width} × {screen.height}（可用 {screen.avail_width} × {screen.avail_height}）
        </Row>
        <Row label="色深 / DPR">
          {screen.color_depth} / {screen.pixel_depth} 位 · {screen.device_pixel_ratio}x
        </Row>
        <Row label="方向">
          {screen.orientation} · {screen.orientation_angle}° · 扩展屏{" "}
          {boolText(screen.is_extended)}
        </Row>
        <Row label="窗口">
          内 {win.inner_width} × {win.inner_height} · 外 {win.outer_width} × {win.outer_height}
        </Row>
        <Row label="窗口位置" mono>
          ({win.screen_x}, {win.screen_y})
        </Row>
      </Section>

      <Section title="WebGL">
        <Row label="掩码供应商">{webgl.vendor}</Row>
        <Row label="掩码渲染器">{webgl.renderer}</Row>
        <Row label="供应商" mono>
          {webgl.unmasked_vendor}
        </Row>
        <Row label="渲染器" mono>
          {webgl.unmasked_renderer}
        </Row>
        <Row label="WebGL 1" mono>
          {webgl.version}
        </Row>
        <Row label="WebGL 2" mono>
          {webgl.webgl2_version}
        </Row>
        <Row label="GLSL" mono>
          {webgl.shading_language_version}
        </Row>
        <Row label="纹理上限">
          {webgl.max_texture_size} · Cube {webgl.max_cube_map_texture_size} · Renderbuffer{" "}
          {webgl.max_renderbuffer_size}
        </Row>
        <Row label="视口 / 采样">
          {webgl.max_viewport_dims[0]} × {webgl.max_viewport_dims[1]} · {webgl.max_samples} 采样
        </Row>
        <Row label="顶点 / 着色器">
          {webgl.max_vertex_attribs} 属性 · {webgl.max_vertex_uniform_vectors} /{" "}
          {webgl.max_fragment_uniform_vectors} uniform · {webgl.max_varying_vectors} varying
        </Row>
        <Row label="上下文">
          antialias {boolText(webgl.antialias)} · alpha {boolText(webgl.alpha)} · depth{" "}
          {boolText(webgl.depth)} · stencil {boolText(webgl.stencil)} · premultiplied{" "}
          {boolText(webgl.premultiplied_alpha)} · preserve {boolText(webgl.preserve_drawing_buffer)}
        </Row>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">扩展 {webgl.extensions.length} 个</p>
          <Chips values={webgl.extensions} />
        </div>
      </Section>

      <Section title="WebGPU">
        <Row label="适配器">
          {webgpu.vendor} / {webgpu.architecture}
        </Row>
        <Row label="设备">{webgpu.device}</Row>
        <Row label="描述">{webgpu.description || "—"}</Row>
        <Row label="回退适配器">{boolText(webgpu.fallback_adapter)}</Row>
        <Row label="纹理 / 层">
          {webgpu.limits.max_texture_dimension_2d} · {webgpu.limits.max_texture_array_layers} 层
        </Row>
        <Row label="绑定组">
          {webgpu.limits.max_bind_groups} 组 · 每组 {webgpu.limits.max_bindings_per_bind_group}{" "}
          项
        </Row>
        <Row label="缓冲上限">
          存储 {formatBytes(webgpu.limits.max_storage_buffer_binding_size)} · Uniform{" "}
          {formatBytes(webgpu.limits.max_uniform_buffer_binding_size)}
        </Row>
        <Row label="计算">
          {webgpu.limits.max_compute_invocations_per_workgroup} 调用 ·{" "}
          {webgpu.limits.max_compute_workgroup_size_x}×
          {webgpu.limits.max_compute_workgroup_size_y}×
          {webgpu.limits.max_compute_workgroup_size_z}
        </Row>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">特性 {webgpu.features.length} 个</p>
          <Chips values={webgpu.features} />
        </div>
      </Section>

      <Section title="音频与媒体设备">
        <Row label="AudioContext">
          {audio.sample_rate} Hz · {audio.max_channel_count} 声道
        </Row>
        <Row label="延迟">
          base {Math.round(audio.base_latency * 10000) / 10} ms · output{" "}
          {Math.round(audio.output_latency * 10000) / 10} ms
        </Row>
        <Row label="压缩器">
          threshold {audio.compressor.threshold} dB · knee {audio.compressor.knee} dB · ratio{" "}
          {audio.compressor.ratio}:1 · attack {audio.compressor.attack}s · release{" "}
          {audio.compressor.release}s
        </Row>
        <Row label="媒体设备">
          音频输入 {fp.media.audio_inputs} · 音频输出 {fp.media.audio_outputs} · 视频输入{" "}
          {fp.media.video_inputs}
        </Row>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">
            设备 ID（每个 64 位十六进制，按来源随机化）
          </p>
          <div className="space-y-1">
            {fp.media.device_ids.map((id) => (
              <p key={id} className="selectable break-all font-mono text-[9.5px] text-faint">
                {id}
              </p>
            ))}
          </div>
        </div>
        <Row label="噪声种子" mono>
          Canvas 0x{fp.canvas_seed.toUpperCase()} · Audio 0x{fp.audio_seed.toUpperCase()}
        </Row>
      </Section>

      <Section title="网络、存储与电池">
        <Row label="连接">
          {fp.network.effective_type} · RTT {fp.network.rtt_ms} ms · {fp.network.downlink_mbps}{" "}
          Mbps · 省流 {boolText(fp.network.save_data)}
        </Row>
        <Row label="存储配额">
          {formatBytes(fp.storage.quota_bytes)}（{fp.storage.quota_bytes.toLocaleString()} 字节）
        </Row>
        <Row label="已用 / 持久化">
          {formatBytes(fp.storage.usage_bytes)} · {boolText(fp.storage.persisted)}
        </Row>
        <Row label="电池">
          充电 {boolText(fp.battery.charging)} · 电量 {Math.round(fp.battery.level * 100)}% ·
          充满还需 {fp.battery.charging_time}s · 放电剩余{" "}
          {fp.battery.discharging_time === null ? "—" : `${fp.battery.discharging_time}s`}
        </Row>
      </Section>

      <Section title="字体">
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">已安装 {fp.fonts.length} 个</p>
          <Chips values={fp.fonts} />
        </div>
      </Section>

      <Section title="插件与 MIME 类型">
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">插件 {fp.plugins.length} 个</p>
          <Chips values={fp.plugins} />
          <p className="mb-1 mt-2 text-[11px] text-faint">MIME 类型 {fp.mime_types.length} 个</p>
          {fp.mime_types.map((mime) => (
            <div key={mime.mime_type} className="py-1">
              <p className="selectable break-all font-mono text-[10.5px] text-body">
                {mime.mime_type}
              </p>
              <p className="text-[10.5px] text-faint">
                {mime.suffixes || "—"} · {mime.description}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="语音合成">
        {fp.voices.map((voice) => (
          <Row key={voice.name} label={voice.lang} mono>
            {voice.name} · {voice.local_service ? "本地" : "远程"}
            {voice.default ? " · 默认" : ""}
          </Row>
        ))}
      </Section>

      <Section title="API 能力">
        <Chips values={fp.api_features} />
      </Section>

      <p className="px-1 text-[10.5px] leading-relaxed text-faint">
        以上字段覆盖请求头与浏览器可观测属性。应用不运行网页 JS，也不模拟 TLS / HTTP2
        握手指纹，因此无法保证在所有检测维度上完全隐身，实际兼容性取决于目标站的检测方式。
      </p>
    </div>
  );
};
