/** @type {import('tailwindcss').Config} */

/**
 * 颜色全部来自 CSS 变量（App.css 的 :root / [data-theme="dark"] / 运行时内联样式）。
 *
 * 约定：组件里只允许出现「语义色名」——bg-surface / text-body / border-line / bg-danger-soft，
 * 不允许出现 slate-500、indigo-600 这类具体色板名。这样换主题、开暗色只需要改变量值，
 * 组件代码零改动。变量格式是 "r g b" 三通道，所以 /60 这类透明度修饰符照常可用。
 *
 * 命名与 interface/theme.ts 的 ThemeTokens 一一对应，改名字要三处同步：
 * ThemeTokens 字段 → 这里 --c-* 的取值 → lib/theme.ts 的 buildThemeVars。
 */
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* 页面与表面 */
        app: c("app"),
        surface: {
          DEFAULT: c("surface"),
          alt: c("surface-alt"),
          strong: c("surface-strong"),
        },
        /* 文字：ink 标题 → body 正文 → muted 次要 → faint 弱化 → faint-soft 极弱 */
        ink: c("ink"),
        body: c("body"),
        muted: c("muted"),
        faint: {
          DEFAULT: c("faint"),
          soft: c("faint-soft"),
        },
        /* 边框与分隔线 */
        line: {
          DEFAULT: c("line"),
          soft: c("line-soft"),
          strong: c("line-strong"),
        },
        /* 主题色 */
        primary: {
          50: c("primary-50"),
          100: c("primary-100"),
          200: c("primary-200"),
          300: c("primary-300"),
          400: c("primary-400"),
          500: c("primary-500"),
          600: c("primary-600"),
          700: c("primary-700"),
          800: c("primary-800"),
          900: c("primary-900"),
        },
        /* 语义色：每一档都有浅底(soft) / 描边(line) / 本体 / 强调(strong) */
        danger: {
          DEFAULT: c("danger-500"),
          soft: c("danger-50"),
          line: c("danger-200"),
          strong: c("danger-600"),
          deep: c("danger-700"),
        },
        warning: {
          DEFAULT: c("warning-500"),
          soft: c("warning-50"),
          line: c("warning-200"),
          strong: c("warning-600"),
          deep: c("warning-700"),
        },
        success: {
          DEFAULT: c("success-500"),
          soft: c("success-50"),
          line: c("success-200"),
          strong: c("success-600"),
          deep: c("success-700"),
        },
        info: {
          DEFAULT: c("info-500"),
          soft: c("info-50"),
          line: c("info-200"),
          strong: c("info-600"),
          deep: c("info-700"),
        },
        /* 深色浮层气泡与强调色上的文字 */
        tooltip: c("tooltip"),
        "on-accent": c("on-accent"),
      },
      fontFamily: {
        sans: ['"MiSans VF"', '"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', '-apple-system', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', 'sans-serif'],
      },
      // 圆角由主题的「圆角基准」统一换算（见 lib/theme.ts），视觉密度可整体调节
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        "3xl": "var(--radius-3xl)",
      },
      boxShadow: {
        // 阴影用颜色变量，暗色下不会出现"浅色投影"这种发灰的光晕
        'card': '0 1px 3px 0 rgb(var(--c-shadow) / 0.08), 0 1px 2px -1px rgb(var(--c-shadow) / 0.06)',
        'card-hover': '0 4px 12px -2px rgb(var(--c-shadow) / 0.14), 0 2px 4px -2px rgb(var(--c-shadow) / 0.08)',
        'elevated': '0 8px 24px -4px rgb(var(--c-shadow) / 0.18), 0 4px 8px -4px rgb(var(--c-shadow) / 0.1)',
        'glow': '0 0 20px -4px rgb(var(--c-primary-500) / 0.22)',
      },
      transitionTimingFunction: {
        // iOS 风格"快起慢收"：末段几乎无加速度
        soft: 'cubic-bezier(0.32, 0.72, 0, 1)',
        fluid: 'cubic-bezier(0.22, 1, 0.36, 1)',
        // 带轻微过冲的弹簧，用于图标旋转等小元素
        spring: 'cubic-bezier(0.34, 1.35, 0.5, 1)',
      },
      animation: {
        // fill-mode 用 backwards 而不是 both：动画结束态就等于元素的静态样式，
        // 不需要保留填充；保留会让元素长期停在合成层上，文字失去次像素抗锯齿而发虚。
        'fade-in': 'fadeIn 0.3s ease backwards',
        'slide-up': 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'slide-in-right': 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'pulse-dot': 'pulseDot 1.5s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.95) translateY(-4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: true,
  },
}
