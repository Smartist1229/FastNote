/**
 * 浏览器指纹（`fingerprint_info` 的返回结构）。
 *
 * 字段与 Rust 端 `BrowserFingerprint` 一一对应，命名保持 snake_case；
 * 种子由后端序列化成十六进制字符串（u64 直接走 JSON 会丢精度）。
 */
export interface FingerprintBrand {
  brand: string;
  version: string;
}

export interface FingerprintScreen {
  width: number;
  height: number;
  avail_width: number;
  avail_height: number;
  color_depth: number;
  pixel_depth: number;
  device_pixel_ratio: number;
  orientation: string;
  orientation_angle: number;
  is_extended: boolean;
}

export interface FingerprintNavigator {
  app_code_name: string;
  app_name: string;
  app_version: string;
  product: string;
  product_sub: string;
  vendor: string;
  vendor_sub: string;
  webdriver: boolean;
  cookie_enabled: boolean;
  on_line: boolean;
  pdf_viewer_enabled: boolean;
  max_touch_points: number;
  global_privacy_control: boolean;
}

export interface FingerprintWindow {
  device_pixel_ratio: number;
  inner_width: number;
  inner_height: number;
  outer_width: number;
  outer_height: number;
  screen_x: number;
  screen_y: number;
}

export interface FingerprintWebgl {
  /** gl.getParameter(gl.VENDOR) */
  vendor: string;
  /** gl.getParameter(gl.RENDERER) */
  renderer: string;
  unmasked_vendor: string;
  unmasked_renderer: string;
  version: string;
  shading_language_version: string;
  webgl2_version: string;
  max_texture_size: number;
  max_cube_map_texture_size: number;
  max_renderbuffer_size: number;
  max_viewport_dims: [number, number];
  max_vertex_attribs: number;
  max_texture_image_units: number;
  max_combined_texture_image_units: number;
  max_vertex_uniform_vectors: number;
  max_fragment_uniform_vectors: number;
  max_varying_vectors: number;
  max_samples: number;
  antialias: boolean;
  alpha: boolean;
  depth: boolean;
  stencil: boolean;
  premultiplied_alpha: boolean;
  preserve_drawing_buffer: boolean;
  extensions: string[];
}

export interface FingerprintWebGpuLimits {
  max_texture_dimension_2d: number;
  max_texture_array_layers: number;
  max_bind_groups: number;
  max_bindings_per_bind_group: number;
  max_dynamic_uniform_buffers_per_pipeline_layout: number;
  max_sampled_textures_per_shader_stage: number;
  max_samplers_per_shader_stage: number;
  max_storage_buffers_per_shader_stage: number;
  max_storage_textures_per_shader_stage: number;
  max_uniform_buffers_per_shader_stage: number;
  max_uniform_buffer_binding_size: number;
  max_storage_buffer_binding_size: number;
  max_vertex_buffers: number;
  max_vertex_attributes: number;
  max_vertex_buffer_array_stride: number;
  max_compute_workgroup_storage_size: number;
  max_compute_invocations_per_workgroup: number;
  max_compute_workgroup_size_x: number;
  max_compute_workgroup_size_y: number;
  max_compute_workgroup_size_z: number;
  max_compute_workgroups_per_dimension: number;
}

export interface FingerprintWebGpu {
  available: boolean;
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  fallback_adapter: boolean;
  features: string[];
  limits: FingerprintWebGpuLimits;
}

export interface FingerprintCompressor {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

export interface FingerprintAudio {
  sample_rate: number;
  max_channel_count: number;
  base_latency: number;
  output_latency: number;
  compressor: FingerprintCompressor;
}

export interface FingerprintMedia {
  audio_inputs: number;
  video_inputs: number;
  audio_outputs: number;
  device_ids: string[];
}

export interface FingerprintNetwork {
  effective_type: string;
  rtt_ms: number;
  downlink_mbps: number;
  save_data: boolean;
}

export interface FingerprintStorage {
  quota_bytes: number;
  usage_bytes: number;
  persisted: boolean;
}

export interface FingerprintBattery {
  charging: boolean;
  level: number;
  charging_time: number;
  discharging_time: number | null;
}

export interface FingerprintMimeType {
  mime_type: string;
  suffixes: string;
  description: string;
}

export interface FingerprintVoice {
  name: string;
  lang: string;
  local_service: boolean;
  default: boolean;
}

export interface BrowserFingerprint {
  user_agent: string;
  chrome_major: number;
  chrome_version: string;
  /** navigator.userAgentData.brands */
  brands: FingerprintBrand[];
  /** navigator.userAgentData 的高熵版本列表 */
  full_version_list: FingerprintBrand[];
  /** navigator.platform */
  platform: string;
  /** Sec-CH-UA-Platform */
  ua_platform: string;
  ua_platform_version: string;
  ua_architecture: string;
  ua_bitness: string;
  ua_mobile: boolean;
  ua_model: string;
  ua_wow64: boolean;
  ua_form_factors: string[];
  language: string;
  languages: string[];
  timezone: string;
  /** JS `getTimezoneOffset()` 语义：UTC+8 为 -480 */
  timezone_offset_minutes: number;
  hardware_concurrency: number;
  device_memory_gb: number;
  color_scheme: string;
  reduced_motion: boolean;
  do_not_track: string | null;
  navigator: FingerprintNavigator;
  screen: FingerprintScreen;
  window: FingerprintWindow;
  webgl: FingerprintWebgl;
  webgpu: FingerprintWebGpu;
  audio: FingerprintAudio;
  media: FingerprintMedia;
  network: FingerprintNetwork;
  storage: FingerprintStorage;
  battery: FingerprintBattery;
  /** 十六进制字符串 */
  canvas_seed: string;
  /** 十六进制字符串 */
  audio_seed: string;
  fonts: string[];
  plugins: string[];
  mime_types: FingerprintMimeType[];
  voices: FingerprintVoice[];
  api_features: string[];
}
