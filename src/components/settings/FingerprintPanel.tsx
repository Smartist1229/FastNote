import { t, useI18n } from "@/i18n";
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

const boolText = (value: boolean): string => (value ? t("是") : t("否"));

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
  const { t, locale } = useI18n();
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
      <p className="rounded-xl border border-danger-line bg-danger-soft px-3.5 py-3 text-[11px] leading-relaxed text-danger-strong">{t("读取指纹失败：{error}", { error: error })}</p>
    );
  }
  if (!fingerprint) {
    return <p className="px-1 py-2 text-[11px] text-faint">{t("正在生成指纹…")}</p>;
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
        <p className="flex-1 text-[11px] leading-relaxed text-faint">{t("每次下载任务都会随机生成一份新的仿真浏览器身份；这里展示的是其中一份示例。 UA、UA-CH、屏幕、窗口、WebGL / WebGPU、音频、媒体设备、网络与字体按平台成套生成， 避免出现自相矛盾的组合。")}</p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint transition-colors hover:bg-surface-alt hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
          title={t("重新随机生成一份指纹")}
        >
          {loading ? t("生成中…") : t("换一个")}
        </button>
      </div>

      <Section title={t("基础信息")}>
        <Row label={t("浏览器")}>
          Chrome {fp.chrome_major}（{fp.chrome_version}）
        </Row>
        <Row label="User-Agent" mono>
          {fp.user_agent}
        </Row>
        <Row label={t("平台")}>
          {fp.platform}（{fp.ua_platform} {fp.ua_platform_version}）
        </Row>
        <Row label={t("架构")}>{t("{ua_architecture} / {ua_bitness} 位 · {value3} · WoW64 {value4}", { ua_architecture: fp.ua_architecture, ua_bitness: fp.ua_bitness, value3: fp.ua_mobile ? t("移动端") : t("桌面端"), value4: boolText(fp.ua_wow64) })}</Row>
        <Row label={t("设备形态")}>{fp.ua_form_factors.join(", ")}</Row>
        <Row label={t("语言")}>
          {fp.language} · {fp.languages.join(", ")}
        </Row>
        <Row label={t("时区")}>{timezoneText(fp)}</Row>
        <Row label={t("硬件")}>{t("{hardware_concurrency} 核 · {device_memory_gb} GB 内存 · 触摸点 {max_touch_points}", { hardware_concurrency: fp.hardware_concurrency, device_memory_gb: fp.device_memory_gb, max_touch_points: fp.navigator.max_touch_points })}</Row>
        <Row label={t("偏好")}>{t("{value1} · 减少动画：{value2} · DNT：{value3}", { value1: fp.color_scheme === "dark" ? t("深色") : t("浅色"), value2: boolText(fp.reduced_motion), value3: fp.do_not_track ?? t("未设置") })}</Row>
      </Section>

      <Section title={t("Navigator 属性")}>
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
        <Row label={t("Cookie / 在线")}>
          {boolText(fp.navigator.cookie_enabled)} / {boolText(fp.navigator.on_line)}
        </Row>
        <Row label={t("PDF 查看器")}>{boolText(fp.navigator.pdf_viewer_enabled)}</Row>
        <Row label="GPC">{boolText(fp.navigator.global_privacy_control)}</Row>
      </Section>

      <Section title={t("UA-CH 与 Client Hints")}>
        <Row label={t("品牌")}>{brandText(fp.brands)}</Row>
        <Row label={t("完整版本")}>{brandText(fp.full_version_list)}</Row>
        <Row label={t("完整版本号")} mono>
          {fp.chrome_version}
        </Row>
        <Row label={t("平台版本")} mono>
          {fp.ua_platform_version}
        </Row>
        <Row label={t("架构 / 位数")} mono>{t("{ua_architecture} / {ua_bitness} 位", { ua_architecture: fp.ua_architecture, ua_bitness: fp.ua_bitness })}</Row>
        <Row label={t("WoW64 / 型号")} mono>
          {fp.ua_wow64 ? "?1" : "?0"} / {fp.ua_model || '""'}
        </Row>
        <Row label={t("形态")} mono>
          {fp.ua_form_factors.map((item) => `"${item}"`).join(", ")}
        </Row>
        <Row label={t("偏好提示")} mono>
          color-scheme={fp.color_scheme} · reduced-motion=
          {fp.reduced_motion ? "reduce" : "no-preference"}
        </Row>
        <Row label={t("设备内存")} mono>
          {fp.device_memory_gb}
        </Row>
        <Row label={t("DPR / 视口")} mono>
          {screen.device_pixel_ratio} / {win.inner_width}
        </Row>
        <Row label="Fetch Metadata" mono>
          none / navigate / document / ?1
        </Row>
        <Row label={t("压缩请求头")} mono>{t("不发送 Accept-Encoding（下载读取原始字节）")}</Row>
      </Section>

      <Section title={t("屏幕与窗口")}>
        <Row label={t("屏幕")}>{t("{width} × {height}（可用 {avail_width} × {avail_height}）", { width: screen.width, height: screen.height, avail_width: screen.avail_width, avail_height: screen.avail_height })}</Row>
        <Row label={t("色深 / DPR")}>{t("{color_depth} / {pixel_depth} 位 · {device_pixel_ratio}x", { color_depth: screen.color_depth, pixel_depth: screen.pixel_depth, device_pixel_ratio: screen.device_pixel_ratio })}</Row>
        <Row label={t("方向")}>{t("{orientation} · {orientation_angle}° · 扩展屏 {value3}", { orientation: screen.orientation, orientation_angle: screen.orientation_angle, value3: boolText(screen.is_extended) })}</Row>
        <Row label={t("窗口")}>{t("内 {inner_width} × {inner_height} · 外 {outer_width} × {outer_height}", { inner_width: win.inner_width, inner_height: win.inner_height, outer_width: win.outer_width, outer_height: win.outer_height })}</Row>
        <Row label={t("窗口位置")} mono>
          ({win.screen_x}, {win.screen_y})
        </Row>
      </Section>

      <Section title="WebGL">
        <Row label={t("掩码供应商")}>{webgl.vendor}</Row>
        <Row label={t("掩码渲染器")}>{webgl.renderer}</Row>
        <Row label={t("供应商")} mono>
          {webgl.unmasked_vendor}
        </Row>
        <Row label={t("渲染器")} mono>
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
        <Row label={t("纹理上限")}>
          {webgl.max_texture_size} · Cube {webgl.max_cube_map_texture_size} · Renderbuffer{" "}
          {webgl.max_renderbuffer_size}
        </Row>
        <Row label={t("视口 / 采样")}>{t("{value1} × {value2} · {max_samples} 采样", { value1: webgl.max_viewport_dims[0], value2: webgl.max_viewport_dims[1], max_samples: webgl.max_samples })}</Row>
        <Row label={t("顶点 / 着色器")}>{t("{max_vertex_attribs} 属性 · {max_vertex_uniform_vectors} / {max_fragment_uniform_vectors} uniform · {max_varying_vectors} varying", { max_vertex_attribs: webgl.max_vertex_attribs, max_vertex_uniform_vectors: webgl.max_vertex_uniform_vectors, max_fragment_uniform_vectors: webgl.max_fragment_uniform_vectors, max_varying_vectors: webgl.max_varying_vectors })}</Row>
        <Row label={t("上下文")}>
          antialias {boolText(webgl.antialias)} · alpha {boolText(webgl.alpha)} · depth{" "}
          {boolText(webgl.depth)} · stencil {boolText(webgl.stencil)} · premultiplied{" "}
          {boolText(webgl.premultiplied_alpha)} · preserve {boolText(webgl.preserve_drawing_buffer)}
        </Row>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">{t("扩展 {length} 个", { length: webgl.extensions.length })}</p>
          <Chips values={webgl.extensions} />
        </div>
      </Section>

      <Section title="WebGPU">
        <Row label={t("适配器")}>
          {webgpu.vendor} / {webgpu.architecture}
        </Row>
        <Row label={t("设备")}>{webgpu.device}</Row>
        <Row label={t("描述")}>{webgpu.description || "—"}</Row>
        <Row label={t("回退适配器")}>{boolText(webgpu.fallback_adapter)}</Row>
        <Row label={t("纹理 / 层")}>{t("{max_texture_dimension_2d} · {max_texture_array_layers} 层", { max_texture_dimension_2d: webgpu.limits.max_texture_dimension_2d, max_texture_array_layers: webgpu.limits.max_texture_array_layers })}</Row>
        <Row label={t("绑定组")}>{t("{max_bind_groups} 组 · 每组 {max_bindings_per_bind_group} 项", { max_bind_groups: webgpu.limits.max_bind_groups, max_bindings_per_bind_group: webgpu.limits.max_bindings_per_bind_group })}</Row>
        <Row label={t("缓冲上限")}>{t("存储 {value1} · Uniform {value2}", { value1: formatBytes(webgpu.limits.max_storage_buffer_binding_size), value2: formatBytes(webgpu.limits.max_uniform_buffer_binding_size) })}</Row>
        <Row label={t("计算")}>{t("{max_compute_invocations_per_workgroup} 调用 · {max_compute_workgroup_size_x}×{max_compute_workgroup_size_y}×{max_compute_workgroup_size_z}", { max_compute_invocations_per_workgroup: webgpu.limits.max_compute_invocations_per_workgroup, max_compute_workgroup_size_x: webgpu.limits.max_compute_workgroup_size_x, max_compute_workgroup_size_y: webgpu.limits.max_compute_workgroup_size_y, max_compute_workgroup_size_z: webgpu.limits.max_compute_workgroup_size_z })}</Row>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">{t("特性 {length} 个", { length: webgpu.features.length })}</p>
          <Chips values={webgpu.features} />
        </div>
      </Section>

      <Section title={t("音频与媒体设备")}>
        <Row label="AudioContext">{t("{sample_rate} Hz · {max_channel_count} 声道", { sample_rate: audio.sample_rate, max_channel_count: audio.max_channel_count })}</Row>
        <Row label={t("延迟")}>
          base {Math.round(audio.base_latency * 10000) / 10} ms · output{" "}
          {Math.round(audio.output_latency * 10000) / 10} ms
        </Row>
        <Row label={t("压缩器")}>
          threshold {audio.compressor.threshold} dB · knee {audio.compressor.knee} dB · ratio{" "}
          {audio.compressor.ratio}:1 · attack {audio.compressor.attack}s · release{" "}
          {audio.compressor.release}s
        </Row>
        <Row label={t("媒体设备")}>{t("音频输入 {audio_inputs} · 音频输出 {audio_outputs} · 视频输入 {video_inputs}", { audio_inputs: fp.media.audio_inputs, audio_outputs: fp.media.audio_outputs, video_inputs: fp.media.video_inputs })}</Row>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">{t("设备 ID（每个 64 位十六进制，按来源随机化）")}</p>
          <div className="space-y-1">
            {fp.media.device_ids.map((id) => (
              <p key={id} className="selectable break-all font-mono text-[9.5px] text-faint">
                {id}
              </p>
            ))}
          </div>
        </div>
        <Row label={t("噪声种子")} mono>
          Canvas 0x{fp.canvas_seed.toUpperCase()} · Audio 0x{fp.audio_seed.toUpperCase()}
        </Row>
      </Section>

      <Section title={t("网络、存储与电池")}>
        <Row label={t("连接")}>{t("{effective_type} · RTT {rtt_ms} ms · {downlink_mbps} Mbps · 省流 {value4}", { effective_type: fp.network.effective_type, rtt_ms: fp.network.rtt_ms, downlink_mbps: fp.network.downlink_mbps, value4: boolText(fp.network.save_data) })}</Row>
        <Row label={t("存储配额")}>{t("{value1}（{value2} 字节）", { value1: formatBytes(fp.storage.quota_bytes), value2: fp.storage.quota_bytes.toLocaleString(locale) })}</Row>
        <Row label={t("已用 / 持久化")}>
          {formatBytes(fp.storage.usage_bytes)} · {boolText(fp.storage.persisted)}
        </Row>
        <Row label={t("电池")}>{t("充电 {value1} · 电量 {value2}% · 充满还需 {charging_time}s · 放电剩余 {value4}", { value1: boolText(fp.battery.charging), value2: Math.round(fp.battery.level * 100), charging_time: fp.battery.charging_time, value4: fp.battery.discharging_time === null ? "—" : `${fp.battery.discharging_time}s` })}</Row>
      </Section>

      <Section title={t("字体")}>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">{t("已安装 {length} 个", { length: fp.fonts.length })}</p>
          <Chips values={fp.fonts} />
        </div>
      </Section>

      <Section title={t("插件与 MIME 类型")}>
        <div className="py-1.5">
          <p className="mb-1 text-[11px] text-faint">{t("插件 {length} 个", { length: fp.plugins.length })}</p>
          <Chips values={fp.plugins} />
          <p className="mb-1 mt-2 text-[11px] text-faint">{t("MIME 类型 {length} 个", { length: fp.mime_types.length })}</p>
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

      <Section title={t("语音合成")}>
        {fp.voices.map((voice) => (
          <Row key={voice.name} label={voice.lang} mono>
            {voice.name} · {voice.local_service ? t("本地") : t("远程")}
            {voice.default ? t(" · 默认") : ""}
          </Row>
        ))}
      </Section>

      <Section title={t("API 能力")}>
        <Chips values={fp.api_features} />
      </Section>

      <p className="px-1 text-[10.5px] leading-relaxed text-faint">{t("以上字段覆盖请求头与浏览器可观测属性。应用不运行网页 JS，也不模拟 TLS / HTTP2 握手指纹，因此无法保证在所有检测维度上完全隐身，实际兼容性取决于目标站的检测方式。")}</p>
    </div>
  );
};
