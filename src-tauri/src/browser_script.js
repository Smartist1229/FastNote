/*
 * 内置浏览器的初始化脚本（document-start 注入，主线程与 Worker 各跑一遍）。
 *
 * 由 `browser.rs` 在创建浏览器窗口的 webview 时通过 `initialization_script` 注入；
 * `__FASTNOTE_FINGERPRINT__` 会被替换成一份 `BrowserFingerprint` 的 JSON，
 * `__FASTNOTE_WORKER_SCRIPT__` 会被替换成同一份脚本的字符串（Worker 里先用它跑一遍，
 * 否则 Worker 里的 platform / languages / 时区仍是浏览器原值，与主线程对不上）。
 *
 * 网络层身份（UA / UA-CH / Accept-Language）由 Rust 侧写进 WebView2 内核并逐请求覆盖
 * 请求头；内核已经返回伪造值的字段这里不再覆盖，只有内核没改成功时才兜底。
 *
 * 覆盖必须看起来像原生实现：所有被替换的 getter / 方法都登记到 `Function.prototype.toString`
 * 的白名单里，属性定义在原型上而不是实例上——检测脚本会读属性描述符并要求函数源码里
 * 带 `[native code]`，也会比较主线程与 Worker 的取值。
 *
 * 所有覆盖都包在 try/catch 里，任何一项失败都不能把目标网页弄挂。
 */
(() => {
  "use strict";
  const F = __FASTNOTE_FINGERPRINT__;
  if (!F || !F.user_agent) return;
  /** Worker 线程里要预载的脚本；Worker 自己那份为 null（不再嵌套包装） */
  const WORKER_SOURCE = __FASTNOTE_WORKER_SCRIPT__;
  const G = globalThis;
  const nav = G.navigator;

  /* ---------- 原生外观 ---------- */
  const nativeToString = Function.prototype.toString;
  const disguised = new WeakMap();
  /** 让 `fn.toString()` 看起来是原生实现（`[native code]`） */
  const asNative = (fn, name) => {
    try {
      disguised.set(fn, `function ${name}() { [native code] }`);
    } catch (_) {}
    return fn;
  };
  try {
    const patchedToString = asNative(function toString() {
      if (disguised.has(this)) return disguised.get(this);
      return nativeToString.call(this);
    }, "toString");
    Object.defineProperty(Function.prototype, "toString", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: patchedToString,
    });
  } catch (_) {}

  const defineGetter = (target, key, getter) => {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get: asNative(getter, `get ${key}`),
      });
    } catch (_) {}
  };
  const defineMethod = (target, key, method) => {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: asNative(method, key),
      });
    } catch (_) {}
  };
  const defineValue = (target, key, value) => {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: typeof value === "function" ? asNative(value, key) : value,
      });
    } catch (_) {}
  };
  /** 属性定义在它原本所在的对象上（通常是原型），实例上不留自己的描述符 */
  const ownerOf = (instance, key) => {
    let owner = instance;
    try {
      while (owner && !Object.getOwnPropertyDescriptor(owner, key)) {
        owner = Object.getPrototypeOf(owner);
      }
    } catch (_) {}
    return owner || instance;
  };
  const defineGetterOnOwner = (instance, key, getter) => {
    defineGetter(ownerOf(instance, key), key, getter);
  };
  const defineMethodOnOwner = (instance, key, method) => {
    defineMethod(ownerOf(instance, key), key, method);
  };

  /* ---------- navigator ---------- */
  try {
    if (nav) {
      const N = F.navigator || {};
      /*
       * 内核（CDP + 请求头改写）已经返回伪造值时不动原生 getter；
       * 只有值对不上时才覆盖，覆盖后也伪装成原生实现。
       * `key in nav` 是给 WorkerNavigator 用的：它没有 vendor / plugins 等字段，
       * 凭空加一个属性反而会被「属性集合不一致」抓到。
       */
      const overrideUnless = (key, expected, equals) => {
        if (!(key in nav)) return;
        try {
          const current = nav[key];
          if (equals ? equals(current) : current === expected) return;
        } catch (_) {}
        defineGetterOnOwner(nav, key, () => expected);
      };
      const sameList = (current) =>
        !!current &&
        current.length === F.languages.length &&
        F.languages.every((language, index) => current[index] === language);

      overrideUnless("userAgent", F.user_agent);
      overrideUnless("appVersion", N.app_version);
      overrideUnless("platform", F.platform);
      overrideUnless("appCodeName", N.app_code_name);
      overrideUnless("appName", N.app_name);
      overrideUnless("product", N.product);
      overrideUnless("productSub", N.product_sub);
      overrideUnless("vendor", N.vendor);
      overrideUnless("vendorSub", N.vendor_sub);
      overrideUnless("language", F.language);
      overrideUnless("languages", Object.freeze(F.languages.slice()), sameList);
      overrideUnless("maxTouchPoints", N.max_touch_points);
      overrideUnless("webdriver", !!N.webdriver);
      overrideUnless("cookieEnabled", !!N.cookie_enabled);
      overrideUnless("onLine", !!N.on_line);
      overrideUnless("pdfViewerEnabled", !!N.pdf_viewer_enabled);
      overrideUnless("doNotTrack", F.do_not_track ?? null);
      overrideUnless("globalPrivacyControl", !!N.global_privacy_control);

      // 硬件信息不属于 UA 元数据，内核不会改，必须覆盖
      if ("hardwareConcurrency" in nav) {
        defineGetterOnOwner(nav, "hardwareConcurrency", () => F.hardware_concurrency);
      }
      if ("deviceMemory" in nav) {
        defineGetterOnOwner(nav, "deviceMemory", () => F.device_memory_gb);
      }

      /* UA-CH：brands / 高熵值。定义在 NavigatorUAData.prototype 上，
         页面实例与 Worker 实例共用同一份，实例上没有自己的描述符。 */
      const brands = (F.brands || []).map((item) => ({ brand: item.brand, version: item.version }));
      const fullVersionList = (F.full_version_list || []).map((item) => ({
        brand: item.brand,
        version: item.version,
      }));
      const highEntropy = Object.freeze({
        brands,
        mobile: !!F.ua_mobile,
        platform: F.ua_platform,
        platformVersion: F.ua_platform_version,
        architecture: F.ua_architecture,
        bitness: F.ua_bitness,
        model: F.ua_model,
        wow64: !!F.ua_wow64,
        fullVersionList,
        formFactors: (F.ua_form_factors || []).slice(),
        uaFullVersion: F.chrome_version,
      });
      const uaProto = G.NavigatorUAData && G.NavigatorUAData.prototype;
      if (uaProto) {
        defineGetter(uaProto, "brands", () => brands);
        defineGetter(uaProto, "mobile", () => !!F.ua_mobile);
        defineGetter(uaProto, "platform", () => F.ua_platform);
        defineMethod(uaProto, "getHighEntropyValues", function getHighEntropyValues(hints) {
          const wanted = Array.isArray(hints) ? hints : [];
          const result = {};
          for (const key of wanted) {
            if (Object.prototype.hasOwnProperty.call(highEntropy, key)) {
              result[key] = highEntropy[key];
            }
          }
          return Promise.resolve(result);
        });
        defineMethod(uaProto, "toJSON", function toJSON() {
          return { brands, mobile: !!F.ua_mobile, platform: F.ua_platform };
        });
      } else if (nav.userAgentData) {
        // 老内核没有 NavigatorUAData 构造函数：退回实例覆盖
        defineGetterOnOwner(nav, "userAgentData", () => ({
          brands,
          mobile: !!F.ua_mobile,
          platform: F.ua_platform,
          getHighEntropyValues: asNative(function getHighEntropyValues(hints) {
            const wanted = Array.isArray(hints) ? hints : [];
            const result = {};
            for (const key of wanted) {
              if (Object.prototype.hasOwnProperty.call(highEntropy, key)) {
                result[key] = highEntropy[key];
              }
            }
            return Promise.resolve(result);
          }, "getHighEntropyValues"),
          toJSON: asNative(function toJSON() {
            return { brands, mobile: !!F.ua_mobile, platform: F.ua_platform };
          }, "toJSON"),
        }));
      }
    }
  } catch (_) {}

  /* ---------- screen / 窗口位置（只在有 DOM 的主线程里有） ---------- */
  try {
    const S = F.screen || {};
    const Wn = F.window || {};
    const screen = G.screen;
    if (screen) {
      // 同一个对象反复返回：原生 getter 也是每次给同一个实例
      const orientation = {
        type: S.orientation,
        angle: S.orientation_angle,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      };
      defineGetterOnOwner(screen, "width", () => S.width);
      defineGetterOnOwner(screen, "height", () => S.height);
      defineGetterOnOwner(screen, "availWidth", () => S.avail_width);
      defineGetterOnOwner(screen, "availHeight", () => S.avail_height);
      defineGetterOnOwner(screen, "colorDepth", () => S.color_depth);
      defineGetterOnOwner(screen, "pixelDepth", () => S.pixel_depth);
      defineGetterOnOwner(screen, "orientation", () => orientation);
      if ("isExtended" in screen) {
        defineGetterOnOwner(screen, "isExtended", () => !!S.is_extended);
      }
    }
    if ("devicePixelRatio" in G) {
      defineGetterOnOwner(G, "devicePixelRatio", () => S.device_pixel_ratio);
    }
    /*
     * 窗口尺寸不覆盖：`innerWidth/Height` 必须和真实布局（`clientWidth`、
     * 媒体查询）一致，和实际值不同的随机数一眼就能被抓到。只覆盖窗口在屏幕上的
     * 位置——页面拿不到任何真实数据来对照它。
     */
    for (const [key, value] of [
      ["screenX", Wn.screen_x],
      ["screenY", Wn.screen_y],
      ["screenLeft", Wn.screen_x],
      ["screenTop", Wn.screen_y],
    ]) {
      if (key in G && typeof value === "number") {
        defineGetterOnOwner(G, key, () => value);
      }
    }
  } catch (_) {}

  /* ---------- 时区 ---------- */
  try {
    const offset = Number(F.timezone_offset_minutes);
    let nativeOffset = null;
    try {
      nativeOffset = Date.prototype.getTimezoneOffset.call(new Date());
    } catch (_) {}
    /* 指纹时区就是本机时区时什么都不改：原生实现最不容易被识破，
       只有跨时区（本机不是出口 IP 所在地）时才需要覆盖。 */
    if (nativeOffset !== offset) {
      defineMethod(Date.prototype, "getTimezoneOffset", function getTimezoneOffset() {
        return offset;
      });
    }
    const proto = G.Intl && G.Intl.DateTimeFormat && G.Intl.DateTimeFormat.prototype;
    if (proto) {
      const original = proto.resolvedOptions;
      let nativeZone = "";
      try {
        nativeZone = original.call(new G.Intl.DateTimeFormat()).timeZone;
      } catch (_) {}
      if (nativeZone !== F.timezone) {
        defineMethod(proto, "resolvedOptions", function resolvedOptions() {
          const options = original.call(this);
          try {
            options.timeZone = F.timezone;
          } catch (_) {}
          return options;
        });
      }
    }
  } catch (_) {}

  /* ---------- 配色 / 减少动画偏好 ---------- */
  try {
    if (typeof G.matchMedia === "function") {
      const original = G.matchMedia.bind(G);
      const makeQuery = (query, matches) => ({
        media: query,
        matches,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      });
      /** 按顶层 `and` 拆分媒体查询；括号里的 `and` 不拆 */
      const splitAnd = (query) => {
        const parts = [];
        const lower = query.toLowerCase();
        let depth = 0;
        let start = 0;
        for (let i = 0; i < query.length; i += 1) {
          const ch = query[i];
          if (ch === "(") depth += 1;
          else if (ch === ")") depth = Math.max(0, depth - 1);
          else if (depth === 0 && i > 0 && lower.startsWith("and", i)) {
            const before = query[i - 1];
            const after = query[i + 3];
            if (/\s/.test(before) && (after === undefined || /[\s(]/.test(after))) {
              parts.push(query.slice(start, i).trim());
              start = i + 3;
              i += 2;
            }
          }
        }
        parts.push(query.slice(start).trim());
        return parts;
      };
      /** 只认整条就是某个偏好特性的原子条件；`not (...)` 之类原样交给内核 */
      const evaluatePreference = (term) => {
        const t = term.trim().toLowerCase().replace(/\s+/g, " ");
        if (/^\(?\s*prefers-color-scheme\s*:/.test(t)) {
          if (t.includes("dark")) return F.color_scheme === "dark";
          if (t.includes("light")) return F.color_scheme !== "dark";
        }
        if (/^\(?\s*prefers-reduced-motion\s*:/.test(t)) {
          if (t.includes("no-preference")) return !F.reduced_motion;
          if (t.includes("reduce")) return !!F.reduced_motion;
        }
        return null;
      };
      defineMethodOnOwner(G, "matchMedia", function matchMedia(query) {
        const terms = splitAnd(String(query));
        const known = [];
        const rest = [];
        for (const term of terms) {
          const value = evaluatePreference(term);
          if (value === null) rest.push(term);
          else known.push(value);
        }
        if (!known.length) return original(query);
        // 组合查询里其余条件（宽度、分辨率等）仍按内核真实值求值再与结果合并
        const restMatches = rest.length ? original(rest.join(" and ")).matches : true;
        return makeQuery(query, restMatches && known.every(Boolean));
      });
    }
  } catch (_) {}

  /* ---------- 插件 / MIME（Worker 里没有） ---------- */
  try {
    if (nav && "plugins" in nav && G.MimeType && G.Plugin) {
      const MimeTypeProto = G.MimeType.prototype;
      const PluginProto = G.Plugin.prototype;
      const MimeTypeArrayProto = G.MimeTypeArray ? G.MimeTypeArray.prototype : Object.prototype;
      const PluginArrayProto = G.PluginArray ? G.PluginArray.prototype : Object.prototype;
      const makeList = (proto, items, named) => {
        const list = Object.create(proto);
        items.forEach((item, index) => defineValue(list, String(index), item));
        defineValue(list, "length", items.length);
        defineValue(list, "item", function item(index) {
          return items[index] || null;
        });
        defineValue(list, "namedItem", function namedItem(name) {
          return named(name);
        });
        return list;
      };
      const mimes = (F.mime_types || []).map((item) => {
        const mime = Object.create(MimeTypeProto);
        defineValue(mime, "type", item.mime_type);
        defineValue(mime, "suffixes", item.suffixes);
        defineValue(mime, "description", item.description);
        defineValue(mime, "enabledPlugin", null);
        return mime;
      });
      const plugins = (F.plugins || []).map((name) => {
        const plugin = Object.create(PluginProto);
        defineValue(plugin, "name", name);
        defineValue(plugin, "filename", "internal-pdf-viewer");
        defineValue(plugin, "description", "Portable Document Format");
        defineValue(plugin, "length", mimes.length);
        mimes.forEach((mime, index) => defineValue(plugin, String(index), mime));
        defineValue(plugin, "item", function item(index) {
          return mimes[index] || null;
        });
        defineValue(plugin, "namedItem", function namedItem(name) {
          return mimes.find((mime) => mime.type === name) || null;
        });
        return plugin;
      });
      mimes.forEach((mime) => defineValue(mime, "enabledPlugin", plugins[0] || null));
      const mimeArray = makeList(MimeTypeArrayProto, mimes, (name) => {
        return mimes.find((mime) => mime.type === name) || null;
      });
      const pluginArray = makeList(PluginArrayProto, plugins, (name) => {
        return plugins.find((plugin) => plugin.name === name) || null;
      });
      // 真实 PluginArray 有 refresh()（永远返回 undefined），缺了会被检测出来
      if (G.PluginArray && PluginArrayProto !== Object.prototype) {
        defineMethod(PluginArrayProto, "refresh", function refresh() {});
      }
      defineGetterOnOwner(nav, "plugins", () => pluginArray);
      defineGetterOnOwner(nav, "mimeTypes", () => mimeArray);
    }
  } catch (_) {}

  /* ---------- Canvas 噪声 ---------- */
  try {
    const seed = parseInt(F.canvas_seed, 16) >>> 0;
    const noiseAt = (index) => {
      let value = (seed ^ Math.imul(index + 1, 2654435761)) >>> 0;
      value ^= value >>> 15;
      value = Math.imul(value, 2246822519) >>> 0;
      value ^= value >>> 13;
      return value & 1 ? 1 : -1;
    };
    const clampByte = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);
    /*
     * 只改有纹理的区域：纯色区域（与右邻 / 下方像素同色）一点不动。
     * 检测方会先画一块纯色再读回来看有没有噪声，纯色块保持原样才不会被判「Canvas 被改」。
     */
    const addNoise = (pixels, width) => {
      const stride = Math.max(1, width) * 4;
      for (let i = 0; i < pixels.length; i += 32) {
        const right = i + 4;
        const below = i + stride;
        if (right < pixels.length && pixels[i] === pixels[right]) continue;
        if (below < pixels.length && pixels[i] === pixels[below]) continue;
        const delta = noiseAt(i);
        pixels[i] = clampByte(pixels[i] + delta);
        pixels[i + 1] = clampByte(pixels[i + 1] - delta);
        pixels[i + 2] = clampByte(pixels[i + 2] + delta);
      }
    };
    /** 主线程与 Worker 都要打：CanvasRenderingContext2D / OffscreenCanvas 2D */
    const patchImageData = (proto) => {
      if (!proto || !proto.getImageData) return;
      const original = proto.getImageData;
      defineMethod(proto, "getImageData", function getImageData(...args) {
        const data = original.apply(this, args);
        try {
          addNoise(data.data, data.width);
        } catch (_) {}
        return data;
      });
    };
    patchImageData(G.CanvasRenderingContext2D && G.CanvasRenderingContext2D.prototype);
    patchImageData(
      G.OffscreenCanvasRenderingContext2D && G.OffscreenCanvasRenderingContext2D.prototype
    );
    /*
     * 在副本上打噪声再把副本导出：原画布保持原样，同一个画布反复导出结果一致。
     * `context.getImageData` 已经被上面的补丁改过，副本里的像素自然带噪声。
     */
    const noisyCopy = (source) => {
      if (!source || !source.width || !source.height) return null;
      let copy;
      let context;
      if (G.document && typeof G.document.createElement === "function") {
        copy = G.document.createElement("canvas");
        copy.width = source.width;
        copy.height = source.height;
        context = copy.getContext("2d");
      } else if (G.OffscreenCanvas) {
        copy = new G.OffscreenCanvas(source.width, source.height);
        context = copy.getContext("2d");
      } else {
        return null;
      }
      if (!context) return null;
      try {
        context.drawImage(source, 0, 0);
        const data = context.getImageData(0, 0, source.width, source.height);
        context.putImageData(data, 0, 0);
        return copy;
      } catch (_) {
        return null;
      }
    };
    const CanvasProto = G.HTMLCanvasElement && G.HTMLCanvasElement.prototype;
    if (CanvasProto && CanvasProto.toDataURL) {
      const originalToDataURL = CanvasProto.toDataURL;
      defineMethod(CanvasProto, "toDataURL", function toDataURL(...args) {
        const copy = noisyCopy(this);
        return copy ? originalToDataURL.apply(copy, args) : originalToDataURL.apply(this, args);
      });
    }
    if (CanvasProto && CanvasProto.toBlob) {
      const originalToBlob = CanvasProto.toBlob;
      defineMethod(CanvasProto, "toBlob", function toBlob(...args) {
        const copy = noisyCopy(this);
        return originalToBlob.apply(copy || this, args);
      });
    }
    const OffscreenProto = G.OffscreenCanvas && G.OffscreenCanvas.prototype;
    if (OffscreenProto && OffscreenProto.convertToBlob) {
      const originalConvertToBlob = OffscreenProto.convertToBlob;
      defineMethod(OffscreenProto, "convertToBlob", function convertToBlob(...args) {
        const copy = noisyCopy(this);
        return originalConvertToBlob.apply(copy || this, args);
      });
    }
  } catch (_) {}

  /* ---------- WebGL ---------- */
  try {
    const W = F.webgl || {};
    const common = {
      37445: W.unmasked_vendor,
      37446: W.unmasked_renderer,
      7936: W.vendor,
      7937: W.renderer,
      3379: W.max_texture_size,
      34076: W.max_cube_map_texture_size,
      34024: W.max_renderbuffer_size,
      3386: W.max_viewport_dims,
      34921: W.max_vertex_attribs,
      34930: W.max_texture_image_units,
      35660: W.max_combined_texture_image_units,
      36347: W.max_vertex_uniform_vectors,
      36348: W.max_fragment_uniform_vectors,
      36349: W.max_varying_vectors,
    };
    /*
     * VERSION（7938）与 SHADING_LANGUAGE_VERSION（35724）在两个上下文里不同：
     * WebGL1 报 GLSL ES 1.0，WebGL2 报 GLSL ES 3.00，共用一份值一眼就能看出来。
     */
    const parametersV1 = Object.assign({}, common, {
      7938: W.version,
      35724: W.shading_language_version,
    });
    const parametersV2 = Object.assign({}, common, {
      7938: W.webgl2_version,
      35724: W.webgl2_shading_language_version || W.shading_language_version,
      // MAX_SAMPLES 只有 WebGL2 有
      36183: W.max_samples,
    });
    const patch = (proto, parameters) => {
      if (!proto || !proto.getParameter) return;
      const original = proto.getParameter;
      defineMethod(proto, "getParameter", function getParameter(name) {
        /*
         * 先按原生路径取一次再替换返回值：检测脚本会数「固定时间内能调多少次」，
         * 直接返回缓存值会让调用快得离谱，从而被判成「WebGL 被改写」。
         */
        const value = original.call(this, name);
        if (Object.prototype.hasOwnProperty.call(parameters, name)) {
          const spoofed = parameters[name];
          if (spoofed === undefined || spoofed === null) return value;
          return Array.isArray(spoofed) ? Int32Array.from(spoofed) : spoofed;
        }
        return value;
      });
    };
    patch(G.WebGLRenderingContext && G.WebGLRenderingContext.prototype, parametersV1);
    patch(G.WebGL2RenderingContext && G.WebGL2RenderingContext.prototype, parametersV2);
  } catch (_) {}

  /* ---------- 音频噪声 ---------- */
  try {
    const seed = parseInt(F.audio_seed, 16) >>> 0;
    const noiseAt = (index) => {
      let value = (seed ^ Math.imul(index + 1, 2654435761)) >>> 0;
      value ^= value >>> 16;
      value = Math.imul(value, 2246822519) >>> 0;
      value ^= value >>> 13;
      return (value >>> 0) / 4294967296 - 0.5;
    };
    const BufferProto = G.AudioBuffer && G.AudioBuffer.prototype;
    if (BufferProto && BufferProto.getChannelData) {
      const original = BufferProto.getChannelData;
      const patched = new WeakSet();
      defineMethod(BufferProto, "getChannelData", function getChannelData(channel) {
        const data = original.call(this, channel);
        try {
          // 同一个缓冲只扰一次：反复读取得到同样的值
          if (!patched.has(data)) {
            patched.add(data);
            for (let i = 0; i < data.length; i += 1) data[i] += noiseAt(i) * 1e-7;
          }
        } catch (_) {}
        return data;
      });
    }
    const AnalyserProto = G.AnalyserNode && G.AnalyserNode.prototype;
    if (AnalyserProto && AnalyserProto.getFloatFrequencyData) {
      const original = AnalyserProto.getFloatFrequencyData;
      defineMethod(AnalyserProto, "getFloatFrequencyData", function getFloatFrequencyData(array) {
        original.call(this, array);
        try {
          for (let i = 0; i < array.length; i += 1) array[i] += noiseAt(i) * 1e-6;
        } catch (_) {}
        return undefined;
      });
    }
  } catch (_) {}

  /* ---------- 网络 / 存储 / 电池 ---------- */
  try {
    const Net = F.network || {};
    if (nav && "connection" in nav) {
      const connection = {
        effectiveType: Net.effective_type,
        rtt: Net.rtt_ms,
        downlink: Net.downlink_mbps,
        saveData: !!Net.save_data,
        type: "wifi",
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      };
      defineGetterOnOwner(nav, "connection", () => connection);
    }
  } catch (_) {}

  try {
    const ST = F.storage || {};
    const storage = nav && nav.storage;
    if (storage && "estimate" in storage) {
      defineMethodOnOwner(storage, "estimate", function estimate() {
        return Promise.resolve({ quota: ST.quota_bytes, usage: ST.usage_bytes });
      });
      defineMethodOnOwner(storage, "persisted", function persisted() {
        return Promise.resolve(!!ST.persisted);
      });
    }
  } catch (_) {}

  try {
    const B = F.battery || {};
    if (nav && "getBattery" in nav) {
      defineMethodOnOwner(nav, "getBattery", function getBattery() {
        return Promise.resolve({
          charging: !!B.charging,
          level: B.level,
          chargingTime: B.charging_time,
          dischargingTime: B.discharging_time === null ? Infinity : B.discharging_time,
          onchargingchange: null,
          onlevelchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
        });
      });
    }
  } catch (_) {}

  /* ---------- 媒体设备 / 语音 ---------- */
  try {
    const M = F.media || {};
    const mediaDevices = nav && nav.mediaDevices;
    if (mediaDevices && Array.isArray(M.device_ids) && M.device_ids.length) {
      const kinds = [];
      for (let i = 0; i < (M.audio_inputs || 0); i += 1) kinds.push("audioinput");
      for (let i = 0; i < (M.audio_outputs || 0); i += 1) kinds.push("audiooutput");
      for (let i = 0; i < (M.video_inputs || 0); i += 1) kinds.push("videoinput");
      const devices = M.device_ids.map((id, index) => ({
        deviceId: id,
        groupId: M.device_ids[(index + 1) % M.device_ids.length],
        kind: kinds[index] || "audioinput",
        label: "",
        toJSON() {
          return {
            deviceId: this.deviceId,
            groupId: this.groupId,
            kind: this.kind,
            label: this.label,
          };
        },
      }));
      defineMethodOnOwner(mediaDevices, "enumerateDevices", function enumerateDevices() {
        return Promise.resolve(devices.slice());
      });
    }
  } catch (_) {}

  try {
    const synth = G.speechSynthesis;
    if (synth && Array.isArray(F.voices)) {
      const voices = F.voices.map((voice) => ({
        name: voice.name,
        lang: voice.lang,
        localService: !!voice.local_service,
        default: !!voice.default,
        voiceURI: voice.name,
      }));
      defineMethodOnOwner(synth, "getVoices", function getVoices() {
        return voices.slice();
      });
    }
  } catch (_) {}

  /* ---------- Worker：先跑同一份脚本再加载网页自己的代码 ---------- */
  try {
    const NativeWorker = G.Worker;
    if (typeof WORKER_SOURCE === "string" && NativeWorker) {
      const makeBlobUrl = (source) => {
        const blob = new G.Blob([source], { type: "text/javascript" });
        return G.URL.createObjectURL(blob);
      };
      /*
       * Worker 脚本是异步拉取的：构造完立刻 revoke 会让它起不来，
       * 所以延迟回收，避免每建一个 Worker 就漏一个 blob URL。
       */
      const revokeLater = (url) => {
        try {
          G.setTimeout(() => {
            try {
              G.URL.revokeObjectURL(url);
            } catch (_) {}
          }, 5000);
        } catch (_) {}
      };
      const wrapScript = (url, type) => {
        let absolute;
        try {
          absolute = new G.URL(String(url), G.location.href);
        } catch (_) {
          return null;
        }
        /*
         * 只包页面自己用 Blob 拼出来的 Worker：检测脚本要跑自定义代码都这么用，
         * 而这类 Worker 一定允许 blob:（不然页面自己就创建不了），不会被 CSP 拦掉。
         * 网站自己的 .js Worker 不包——有些站点的 worker-src 不含 blob:，
         * 换掉地址反而会让它的 Worker 起不来。
         */
        if (absolute.protocol !== "blob:") return null;
        if (absolute.origin !== G.location.origin) return null;
        if (type === "module") {
          /*
           * 模块 Worker 不能用 importScripts：先 import 指纹脚本，再 import
           * 页面自己的模块。静态 import 按源码顺序求值，指纹仍先于页面代码执行。
           */
          const fingerprintUrl = makeBlobUrl(WORKER_SOURCE);
          const wrapperUrl = makeBlobUrl(
            `import ${JSON.stringify(fingerprintUrl)};\nimport ${JSON.stringify(absolute.href)};`
          );
          return { url: wrapperUrl, created: [fingerprintUrl, wrapperUrl] };
        }
        const wrapperUrl = makeBlobUrl(
          `${WORKER_SOURCE}\nimportScripts(${JSON.stringify(absolute.href)});`
        );
        return { url: wrapperUrl, created: [wrapperUrl] };
      };
      /*
       * 用 Proxy 包一层：Worker.prototype、静态属性、instanceof 都还是原生的，
       * 只有构造时额外注入；blob 被 CSP 拦下时退回原生写法，页面不至于打不开 Worker。
       */
      G.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const options = args[1] && typeof args[1] === "object" ? args[1] : {};
          let wrapped = null;
          try {
            wrapped = wrapScript(args[0], options.type);
          } catch (_) {}
          if (!wrapped) return Reflect.construct(target, args);
          try {
            const worker = Reflect.construct(target, [wrapped.url, args[1]]);
            for (const url of wrapped.created) revokeLater(url);
            return worker;
          } catch (_) {
            // 构造函数抛错说明这次替换没被接受，立刻回收刚建的 blob
            for (const url of wrapped.created) {
              try {
                G.URL.revokeObjectURL(url);
              } catch (_) {}
            }
            return Reflect.construct(target, args);
          }
        },
      });
    }
  } catch (_) {}
})();
