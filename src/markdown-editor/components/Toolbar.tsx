/**
 * 工具栏。
 *
 * 结构：条目按 `config.toolbar.items` 顺序渲染，`|` 是分隔线，`{group}` 是紧凑分组。
 * 隐藏工具三种方式（优先级从低到高）：
 *   1. 换预设（TOOLBAR_PRESETS）；
 *   2. 改 items 数组；
 *   3. `exclude: ['bold', ...]` 一键隐藏。
 *
 * 两个容易踩的坑，实现里刻意绕开了：
 * - 所有按钮都 `onMouseDown` 阻止默认行为：否则点击按钮会让编辑区失焦，
 *   实时预览正在编辑的块会被立刻提交，选区也丢了，工具栏就没法作用于当前选区。
 * - 下拉菜单必须渲染到 body（portal + fixed 定位）。工具栏为了窄窗口可横向滚动设了
 *   `overflow-x: auto / overflow-y: hidden`，留在内部渲染的菜单会被整块裁掉，
 *   表现为「点了没反应」。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  MarkdownCustomTool,
  MarkdownEditorConfig,
  MarkdownEditorMode,
  ToolbarEntry,
  ToolbarItemName,
} from "../types";
import type { ActiveFormats, InlineColorProp } from "../editor/commands";
import { MdeIcon, PathIcon } from "../icons";
import { ColorPicker } from "./ColorPicker";

const MUTATING: ToolbarItemName[] = [
  "bold",
  "italic",
  "strike",
  "underline",
  "textColor",
  "bgColor",
  "mark",
  "sup",
  "sub",
  "inlineCode",
  "codeBlock",
  "quote",
  "alert",
  "callout",
  "bulletList",
  "orderedList",
  "taskList",
  "indent",
  "outdent",
  "link",
  "image",
  "table",
  "hr",
  "math",
  "mathBlock",
  "mermaid",
  "footnote",
  "toc",
  "heading",
];

const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
type AlertKind = (typeof ALERT_KINDS)[number];
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * 尾部吸附组：窗口变窄时这几个必须一直点得到（切换视图、看大纲、全屏、复制全文）。
 * 顺序与预设里 items 的末尾保持一致。
 */
const PIN_TAIL_ITEMS = new Set<ToolbarItemName>(["mode", "outline", "fullscreen", "copy"]);

/** 带下拉的工具：标题 / 提示块 / 警告提示块 / 文字颜色 / 文字底色 */
type MenuKind = "heading" | "alert" | "callout" | "textColor" | "bgColor";

/** 色盘类菜单对应的 style 属性 */
const COLOR_PROP: Partial<Record<MenuKind, InlineColorProp>> = {
  textColor: "color",
  bgColor: "background-color",
};

interface ToolbarProps {
  config: MarkdownEditorConfig;
  labels: Record<string, string>;
  mode: MarkdownEditorMode;
  available: MarkdownEditorMode[];
  formats: ActiveFormats;
  canUndo: boolean;
  canRedo: boolean;
  outlineOpen: boolean;
  fullscreen: boolean;
  readOnly: boolean;
  /** 当前没有可编辑目标（阅读模式）时禁用改写类工具 */
  inactive?: boolean;
  /** 主题变量：菜单用 portal 挂到 body，必须自带变量才不会掉样式 */
  themeVars?: CSSProperties;
  resolvedTheme?: "light" | "dark";
  onCommand: (name: ToolbarItemName) => void;
  onHeading: (level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => void;
  onAlert: (kind: AlertKind) => void;
  onCallout: (kind: AlertKind) => void;
  onModeChange: (mode: MarkdownEditorMode) => void;
  onToggleOutline: () => void;
  onToggleFullscreen: () => void;
  onCopyAll: () => void;
  /** 色盘选了颜色：`value` 为 null 表示「清除颜色」 */
  onColor: (prop: InlineColorProp, value: string | null) => void;
  onCustomTool: (tool: MarkdownCustomTool) => void;
}

/** 单个按钮 */
const ToolButton: React.FC<{
  title: string;
  active?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  label?: string;
  onClick: () => void;
  children: ReactNode;
  expanded?: boolean;
  tooltip?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}> = ({
  title,
  active,
  disabled,
  showLabel,
  label,
  onClick,
  children,
  expanded,
  tooltip = true,
  buttonRef,
  onMouseEnter,
  onMouseLeave,
}) => (
  <button
    ref={buttonRef}
    type="button"
    className={`mde-tool${active ? " is-active" : ""}${showLabel ? " has-label" : ""}${expanded ? " is-expanded" : ""}`}
    title={tooltip ? title : undefined}
    aria-label={title}
    aria-pressed={active}
    aria-expanded={expanded}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
  >
    {children}
    {showLabel && label && <span className="mde-tool-label">{label}</span>}
  </button>
);

/**
 * 浮层菜单：portal 到 body 并用 fixed 定位，避开工具栏的 overflow 裁剪；
 * 贴到视口底部时自动向上翻，左右夹进视口。
 */
const FloatingMenu: React.FC<{
  anchor: HTMLElement | null;
  nodeRef: RefObject<HTMLDivElement | null>;
  themeVars?: CSSProperties;
  resolvedTheme?: "light" | "dark";
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  children: ReactNode;
}> = ({ anchor, nodeRef, themeVars, resolvedTheme, onMouseEnter, onMouseLeave, children }) => {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const element = nodeRef.current;
      if (!element) return;
      const rect = anchor.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const below = rect.bottom + 6;
      const top =
        below + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : below;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      setPos({ left, top });
    };
    place();
    // 捕获阶段监听滚动：工具栏横向滚动、页面滚动都要跟着走（或至少不悬空）
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, nodeRef]);

  return createPortal(
    <div className="mde-portal" data-theme={resolvedTheme} style={themeVars}>
      <div
        ref={nodeRef}
        className="mde-menu is-floating"
        role="menu"
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
};

/**
 * memo 包一层：工具栏有几十个按钮，而它的 props 在打字时几乎不变
 * （格式状态由上层收敛成「值不变就复用旧引用」），没有这层就会每敲一个字全量重渲染。
 */
const ToolbarImpl = ({
  config,
  labels,
  mode,
  available,
  formats,
  canUndo,
  canRedo,
  outlineOpen,
  fullscreen,
  readOnly,
  inactive = false,
  themeVars,
  resolvedTheme,
  onCommand,
  onHeading,
  onAlert,
  onCallout,
  onModeChange,
  onToggleOutline,
  onToggleFullscreen,
  onCopyAll,
  onColor,
  onCustomTool,
}: ToolbarProps) => {
  const [openMenu, setOpenMenu] = useState<MenuKind | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  /**
   * 工具栏内容比可视区宽：吸附组正压在左边按钮上，需要一层渐隐暗示「那里还有东西」。
   * 用几何判断而不是「是否滚动过」——scrollLeft 为 0 时内容照样可能已经溢出。
   */
  const [stuck, setStuck] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const menuNode = useRef<HTMLDivElement | null>(null);
  /** 各下拉按钮的 DOM，用于定位浮层菜单 */
  const anchorRefs = useRef<Partial<Record<MenuKind, HTMLButtonElement | null>>>({});
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  /** 当前菜单是悬停打开的还是点击打开的（点击打开的不因移出而关闭） */
  const hoverOpened = useRef(false);
  const { toolbar } = config;

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const closeMenu = useCallback(() => {
    clearTimers();
    hoverOpened.current = false;
    setOpenMenu(null);
    setAnchor(null);
  }, [clearTimers]);

  const openMenuAt = useCallback(
    (kind: MenuKind, element: HTMLElement, byHover: boolean) => {
      clearTimers();
      hoverOpened.current = byHover;
      setAnchor(element);
      setOpenMenu(kind);
    },
    [clearTimers],
  );

  /** 悬停展开：延迟触发，扫过工具栏时不会连闪 */
  const scheduleOpen = useCallback(
    (kind: MenuKind, element: HTMLElement) => {
      if (!toolbar.openOnHover || readOnly) return;
      clearTimers();
      openTimer.current = window.setTimeout(
        () => openMenuAt(kind, element, true),
        Math.max(0, toolbar.hoverOpenDelay),
      );
    },
    [clearTimers, openMenuAt, readOnly, toolbar.hoverOpenDelay, toolbar.openOnHover],
  );

  /** 移出后延迟关闭，给指针进入菜单留时间 */
  const scheduleClose = useCallback(() => {
    if (!hoverOpened.current) return;
    clearTimers();
    closeTimer.current = window.setTimeout(closeMenu, Math.max(0, toolbar.hoverCloseDelay));
  }, [clearTimers, closeMenu, toolbar.hoverCloseDelay]);

  /** 指针进入菜单：取消待执行的关闭 */
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // 工具栏溢出时：滚轮纵向滚动转成横向滚动，触控板横向滑动保持原生行为
  useEffect(() => {
    const element = wrapper.current;
    if (!element || !toolbar.scrollable || !toolbar.scrollWheel) return;
    const onWheel = (event: WheelEvent) => {
      // Ctrl/⌘ + 滚轮是「改字号」，不能同时把工具栏横着滚一段
      if (event.ctrlKey || event.metaKey) return;
      if (element.scrollWidth <= element.clientWidth + 1) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [toolbar.scrollable, toolbar.scrollWheel]);

  // 点击外部 / Esc 关闭；菜单在 body 上，所以要同时判断工具栏与菜单本身
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapper.current?.contains(target)) return;
      if (menuNode.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [anchor, closeMenu, openMenu]);

  const disabledFor = (name: ToolbarItemName): boolean => {
    if (readOnly && MUTATING.includes(name)) return true;
    if (inactive && MUTATING.includes(name)) return true;
    if (name === "undo") return !canUndo;
    if (name === "redo") return !canRedo;
    return false;
  };

  const activeFor = (name: ToolbarItemName): boolean => {
    switch (name) {
      case "bold":
        return formats.bold;
      case "italic":
        return formats.italic;
      case "strike":
        return formats.strike;
      case "mark":
        return formats.mark;
      case "inlineCode":
        return formats.inlineCode;
      case "quote":
        return formats.quote;
      case "bulletList":
        return formats.bulletList && !formats.taskList;
      case "orderedList":
        return formats.orderedList;
      case "taskList":
        return formats.taskList;
      case "heading":
        return formats.heading !== null;
      case "textColor":
        return formats.textColor !== null;
      case "bgColor":
        return formats.bgColor !== null;
      case "outline":
        return outlineOpen;
      case "fullscreen":
        return fullscreen;
      default:
        return false;
    }
  };

  /** 模式切换：分段控件，而不是下拉（模式切换频率高）；横向滚动时吸附在右侧 */
  const renderModeSwitch = () => (
    <div className="mde-mode-switch" role="group" aria-label={labels.mode}>
      {available.map((item) => (
        <button
          key={item}
          type="button"
          className={`mde-mode-btn${mode === item ? " is-active" : ""}`}
          title={labels[`mode.${item}`]}
          aria-label={labels[`mode.${item}`]}
          aria-pressed={mode === item}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onModeChange(item)}
        >
          <MdeIcon name={`mode-${item}`} size={14} />
          {toolbar.labels && <span className="mde-tool-label">{labels[`mode.${item}`]}</span>}
        </button>
      ))}
    </div>
  );

  const renderHeadingMenu = () => (
    <>
      <button
        type="button"
        role="menuitem"
        className={`mde-menu-item${formats.heading === null ? " is-active" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onHeading(0);
          closeMenu();
        }}
      >
        <span className="mde-menu-label">{labels.paragraph}</span>
        <span className="mde-menu-hint">P</span>
      </button>
      {HEADING_LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          role="menuitem"
          className={`mde-menu-item${formats.heading === level ? " is-active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onHeading(level);
            closeMenu();
          }}
        >
          <span className="mde-menu-label">{labels[`heading${level}`]}</span>
          <span className="mde-menu-hint">H{level}</span>
        </button>
      ))}
    </>
  );

  const renderAlertMenu = (
    hint: (kind: AlertKind) => string,
    onPick: (kind: AlertKind) => void,
  ) =>
    ALERT_KINDS.map((kind) => (
      <button
        key={kind}
        type="button"
        role="menuitem"
        className="mde-menu-item"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onPick(kind);
          closeMenu();
        }}
      >
        <span className={`mde-alert-dot is-${kind}`} />
        <span className="mde-menu-label">{labels[`alert${kind[0].toUpperCase()}${kind.slice(1)}`]}</span>
        <span className="mde-menu-hint">{hint(kind)}</span>
      </button>
    ));

  /**
   * 色盘：预设色网格 + 自绘 HSV 取色器 + 清除。
   *
   * 预设色是各自独立的 `<button>`，一行 8 个才不至于让菜单长成一条；点一下即套上也即关菜单。
   * 取色器相反：拖动期间只更新面板预览、松手才落到文档，所以**拖完不关菜单**——
   * 中途关掉等于把面板从指针底下抽走，用户连微调第二次的机会都没有。
   */
  const renderColorMenu = (kind: "textColor" | "bgColor") => {
    const prop = COLOR_PROP[kind];
    if (!prop) return null;
    const current = (kind === "textColor" ? formats.textColor : formats.bgColor) ?? "";

    return (
      <>
        <div className="mde-color-grid" role="group" aria-label={labels[kind] ?? kind}>
          {toolbar.colorSwatches.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="menuitem"
              title={swatch}
              aria-label={swatch}
              className={`mde-color-swatch${current.toLowerCase() === swatch.toLowerCase() ? " is-active" : ""}`}
              style={{ background: swatch }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onColor(prop, swatch);
                closeMenu();
              }}
            />
          ))}
        </div>
        <div className="mde-menu-sep" />
        <ColorPicker
          value={current || null}
          fallback={kind === "textColor" ? toolbar.textColorFallback : toolbar.backgroundColorFallback}
          labelCustom={labels.colorCustom}
          labelClear={labels.colorClear}
          onPick={(hex) => onColor(prop, hex)}
          onClear={() => {
            onColor(prop, null);
            closeMenu();
          }}
        />
      </>
    );
  };

  /** 当前展开的菜单内容：按 kind 取，避免每种菜单重复写一份 FloatingMenu */
  const renderMenuBody = () => {
    if (openMenu === "heading") return renderHeadingMenu();
    if (openMenu === "alert") return renderAlertMenu((kind) => kind.toUpperCase(), onAlert);
    if (openMenu === "callout") return renderAlertMenu(() => "!!!", onCallout);
    if (openMenu === "textColor") return renderColorMenu("textColor");
    if (openMenu === "bgColor") return renderColorMenu("bgColor");
    return null;
  };

  /** 带下拉的工具：悬停展开 + 点击切换；菜单走 portal */
  const renderMenuSlot = (kind: MenuKind, icon: string) => {
    const item = kind as ToolbarItemName;
    const title = labels[item] ?? item;
    const disabled = disabledFor(item);
    const active = activeFor(item);
    const element = anchorRefs.current[kind] ?? null;

    return (
      <div
        className="mde-tool-slot has-menu"
        key={item}
        onMouseEnter={() => {
          if (disabled || !element) return;
          scheduleOpen(kind, element);
        }}
        onMouseLeave={scheduleClose}
      >
        <ToolButton
          title={title}
          active={active}
          disabled={disabled}
          showLabel={toolbar.labels}
          label={title}
          expanded={openMenu === kind}
          tooltip={toolbar.tooltip}
          buttonRef={(node) => {
            anchorRefs.current[kind] = node;
          }}
          onClick={() => {
            if (openMenu === kind) {
              closeMenu();
              return;
            }
            if (element) openMenuAt(kind, element, false);
          }}
        >
          <MdeIcon name={icon} size={16} />
          <MdeIcon name="chevron-down" size={12} className="mde-tool-caret" />
        </ToolButton>
      </div>
    );
  };

  const renderItem = (item: ToolbarItemName) => {
    const title = labels[item] ?? item;
    const disabled = disabledFor(item);
    const active = activeFor(item);

    if (item === "mode") {
      if (!config.mode.showSwitch) return null;
      return (
        <div className="mde-tool-slot is-mode" key={item}>
          {renderModeSwitch()}
        </div>
      );
    }

    if (item === "heading") return renderMenuSlot("heading", "heading");
    if (item === "alert") return renderMenuSlot("alert", "alert");
    if (item === "callout") return renderMenuSlot("callout", "callout");
    if (item === "textColor") return renderMenuSlot("textColor", "textColor");
    if (item === "bgColor") return renderMenuSlot("bgColor", "bgColor");

    if (item === "outline") {
      return (
        <ToolButton
          key={item}
          title={title}
          active={outlineOpen}
          showLabel={toolbar.labels}
          label={title}
          tooltip={toolbar.tooltip}
          onClick={onToggleOutline}
        >
          <MdeIcon name="outline" size={16} />
        </ToolButton>
      );
    }

    if (item === "fullscreen") {
      return (
        <ToolButton
          key={item}
          title={title}
          active={fullscreen}
          showLabel={toolbar.labels}
          label={title}
          tooltip={toolbar.tooltip}
          onClick={onToggleFullscreen}
        >
          <MdeIcon name={fullscreen ? "fullscreen-exit" : "fullscreen"} size={16} />
        </ToolButton>
      );
    }

    if (item === "copy") {
      return (
        <ToolButton
          key={item}
          title={title}
          showLabel={toolbar.labels}
          label={title}
          tooltip={toolbar.tooltip}
          onClick={onCopyAll}
        >
          <MdeIcon name="copy" size={16} />
        </ToolButton>
      );
    }

    return (
      <ToolButton
        key={item}
        title={title}
        active={active}
        disabled={disabled}
        showLabel={toolbar.labels}
        label={title}
        tooltip={toolbar.tooltip}
        onClick={() => onCommand(item)}
      >
        <MdeIcon name={item} size={16} />
      </ToolButton>
    );
  };

  const visibleItems = toolbar.items.filter((entry) => {
    if (entry === "|") return true;
    if (typeof entry === "string") return !toolbar.exclude.includes(entry);
    return entry.group.some((name) => !toolbar.exclude.includes(name));
  });

  const renderEntry = (entry: ToolbarEntry, index: number) => {
    if (entry === "|") return <span className="mde-sep" key={`sep-${index}`} aria-hidden="true" />;
    if (typeof entry === "string") {
      if (toolbar.exclude.includes(entry)) return null;
      return renderItem(entry);
    }
    const group = entry.group.filter((name) => !toolbar.exclude.includes(name));
    if (!group.length) return null;
    return (
      <div className="mde-tool-group" key={`group-${index}`}>
        {group.map((name) => renderItem(name))}
      </div>
    );
  };

  const customVisible = toolbar.customItems.filter((tool) => tool.visible !== false);

  /*
   * 尾部吸附：把末尾这组常驻工具从流程里切出来，单独包一层 sticky 容器。
   * 只认平铺在 items 里的工具名（预设里 mode/outline/fullscreen/copy 就是这样），
   * 分组写法（`{ group: [...] }`）不参与——分组意味着「同类按钮排在一起」，
   * 拆一半出去反而更乱。
   */
  const tailStart = (() => {
    if (!toolbar.pinTail) return visibleItems.length;
    let at = visibleItems.length;
    while (at > 0) {
      const entry = visibleItems[at - 1];
      if (
        typeof entry === "string" &&
        entry !== "|" &&
        PIN_TAIL_ITEMS.has(entry) &&
        !toolbar.exclude.includes(entry)
      ) {
        at -= 1;
        continue;
      }
      break;
    }
    return at;
  })();
  const headItems = visibleItems.slice(0, tailStart);
  const tailItems = visibleItems.slice(tailStart);

  /** 每次渲染后量一次是否溢出：内容增减、紧凑模式、显示文字标签都会改变它 */
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const next = element.scrollWidth > element.clientWidth + 1;
    if (next !== stuck) setStuck(next);
  });

  /** 窗口缩放不会触发重渲染，得靠 ResizeObserver 补一次（容器宽度变了溢出状态可能翻转） */
  useEffect(() => {
    const element = wrapper.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setStuck(element.scrollWidth > element.clientWidth + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={wrapper}
      className={`mde-toolbar${toolbar.sticky ? " is-sticky" : ""}${toolbar.compact ? " is-compact" : ""}${
        toolbar.scrollable ? " is-scrollable" : ""
      }${tailItems.length > 0 ? " has-tail" : ""}`}
      role="toolbar"
      aria-label="Markdown 工具栏"
    >
      <div className="mde-toolbar-inner">
        {headItems.map(renderEntry)}
        {customVisible.length > 0 && <span className="mde-sep" aria-hidden="true" />}
        {customVisible.map((tool) => (
          <ToolButton
            key={tool.name}
            title={tool.title}
            showLabel={toolbar.labels}
            label={tool.title}
            tooltip={toolbar.tooltip}
            onClick={() => onCustomTool(tool)}
          >
            {typeof tool.icon === "string" ? <PathIcon d={tool.icon} size={16} /> : tool.icon}
          </ToolButton>
        ))}
        {tailItems.length > 0 && (
          <div className={`mde-toolbar-tail${stuck ? " is-stuck" : ""}`}>
            {tailItems.map((entry, index) => renderEntry(entry, tailStart + index))}
          </div>
        )}
      </div>

      {openMenu && (
        <FloatingMenu
          anchor={anchor}
          nodeRef={menuNode}
          themeVars={themeVars}
          resolvedTheme={resolvedTheme}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {renderMenuBody()}
        </FloatingMenu>
      )}
    </div>
  );
};

export const Toolbar = memo(ToolbarImpl, (previous: ToolbarProps, next: ToolbarProps) => {
  const changed: string[] = [];
  (Object.keys(previous) as (keyof ToolbarProps)[]).forEach((key) => {
    if (previous[key] !== next[key]) changed.push(key);
  });
  return changed.length === 0;
});
