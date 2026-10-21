/**
 * 查找命中的高亮：编辑区与预览区共用一套 CSS 自定义高亮（`::highlight()`）。
 *
 * 为什么不用「往 DOM 里塞 <mark>」：
 * - 预览是 React 受控渲染的，打字时整棵树会重建；插进去的 mark 要么在下一次渲染里被冲掉，
 *   要么反过来挡住 React 的 diff（它认不出自己没建过的节点）。两种都表现为「高亮忽有忽无」；
 * - 编辑区是 contenteditable：行内一旦出现 `<mark>`，浏览器会把行拆成好几个文本节点，
 *   输入法组合期间还可能自行增删节点，React 之后再按自己的虚拟树去更新就会错位。
 *
 * 走 `::highlight()` 只往注册表里放一批 `Range`，一个 DOM 节点都不动：
 * - React 想怎么重渲染都行，range 失效了下一帧重建即可；
 * - 命中跨若干个节点（**加粗** 与普通文字混排）也能整段高亮上；
 * - 不产生额外节点，长文档不会因为开了查找就多出几千个 mark。
 *
 * 代价：只支持 Chromium 105+ / Safari 17.2+（WebView2 属于前者）。
 * 不支持时 `supportsHighlights()` 返回 false，退化成「不高亮」，不会报错。
 *
 * 另一个代价：预览里渲染后的文本与 Markdown 源文不是一一对应的（`**加粗**` 渲染成 `加粗`），
 * 所以按渲染顺序数的「第 N 个」与编辑侧的计数可能差开。计数与替换始终以编辑区为准。
 */
import { buildSearchRegExp, type SearchOptions } from "./search";

/** 普通命中的高亮名（规则由 theme.ts 的 buildHighlightRules 生成） */
const HIT_NAME = "mde-find-hit";
/** 当前命中的高亮名（规则由 theme.ts 的 buildHighlightRules 生成） */
const CURRENT_NAME = "mde-find-current";
/** 大纲跳转目标的高亮名（规则由 theme.ts 的 buildHighlightRules 生成） */
const FLASH_NAME = "mde-flash";

/**
 * 最多铺多少个命中。
 *
 * `Range` 本身很轻，但几万个区间会让绘制阶段逐段求交；而屏外的命中本来就看不见。
 * 超过就只铺前面这些——查找计数仍以编辑区为准，这里只是「画多少」的上限。
 */
const MAX_RANGES = 4000;

interface Bucket {
  hit: Range[];
  current: Range[];
}

/** 每个容器一份区间；同一时刻可能有多个编辑器实例，发布时取并集 */
const buckets = new Map<HTMLElement, Bucket>();

/**
 * 大纲跳转目标的区间单独存一份。
 *
 * 查找高亮按查询词 / 命中下标频繁重铺（`applyTextHighlights` 直接覆盖 `buckets`），
 * 混在一张表里的话重铺一次就把跳转高亮冲掉了。两件事互不相干，各自发布时取并集。
 */
const flashBuckets = new Map<HTMLElement, Range[]>();

/**
 * 代码块的 token 着色单独存一份（编辑区用）。
 *
 * 每项是「高亮名 + 区间」：名字形如 `mde-syn-keyword`，颜色由上层按当前代码配色
 * 注入成一条 `::highlight()` 规则（`::highlight` 不认 CSS 变量，只能写字面量）。
 * 和查找高亮分开存，改查询词不会把 token 颜色冲掉。
 */
interface TokenBucket {
  name: string;
  ranges: Range[];
}

const tokenBuckets = new Map<HTMLElement, TokenBucket[]>();


/** `CSS.highlights` 是 maplike，TS 的 lib.dom 只声明了 forEach，这里补上真正的形状 */
type HighlightStore = Map<string, Highlight>;

const store = (): HighlightStore | null => {
  if (typeof CSS === "undefined" || typeof Highlight !== "function") return null;
  const candidate = (CSS as unknown as { highlights?: HighlightStore }).highlights;
  return candidate && typeof candidate.set === "function" ? candidate : null;
};

/** 当前环境能不能用自定义高亮（不支持时只是没有高亮，其它功能照常） */
export const supportsHighlights = (): boolean => store() !== null;

const flush = (name: string, ranges: Range[]): void => {
  const registry = store();
  if (!registry) return;
  if (ranges.length) registry.set(name, new Highlight(...ranges));
  else registry.delete(name);
};

/** 把所有容器的区间并起来重新发布一次（注册表里每个名字只有一个高亮） */
const publish = (): void => {
  const hit: Range[] = [];
  const current: Range[] = [];
  const flash: Range[] = [];
  const tokens = new Map<string, Range[]>();
  for (const bucket of buckets.values()) {
    for (const range of bucket.hit) hit.push(range);
    for (const range of bucket.current) current.push(range);
  }
  for (const ranges of flashBuckets.values()) {
    for (const range of ranges) flash.push(range);
  }
  for (const bucket of tokenBuckets.values()) {
    for (const entry of bucket) {
      const list = tokens.get(entry.name);
      if (list) list.push(...entry.ranges);
      else tokens.set(entry.name, [...entry.ranges]);
    }
  }
  flush(HIT_NAME, hit);
  flush(CURRENT_NAME, current);
  flush(FLASH_NAME, flash);
  for (const [name, ranges] of tokens) flush(name, ranges);
};

/** 清掉某个容器的高亮（关闭查找 / 切模式 / 卸载时调用） */
export const clearHighlights = (container: HTMLElement): void => {
  if (!buckets.delete(container)) return;
  publish();
};

/**
 * 直接把算好的两组区间交给某个容器。
 *
 * 编辑区用这条：命中是「编辑区偏移 → DOM 位置」换出来的，不必再跑一遍正则。
 * 调用方负责在容器内容变化后重新调用一次（区间是活的，但节点被换掉就失效了）。
 */
export const setHighlightRanges = (container: HTMLElement, hit: Range[], current: Range[]): void => {
  if (!store()) return;
  buckets.set(container, { hit, current });
  publish();
};

/**
 * 大纲跳转目标的高亮：给标题文字铺一层底色（编辑区与预览区都走这条）。
 *
 * 传空数组即清掉。与查找高亮分开存，查询词或命中下标一变不会把它冲掉。
 */
export const setFlashRanges = (container: HTMLElement, ranges: Range[]): void => {
  if (!store()) return;
  if (ranges.length) flashBuckets.set(container, ranges);
  else if (!flashBuckets.delete(container)) return;
  publish();
};

/**
 * 编辑区代码块的 token 着色：按高亮名分组的一批区间（名字见 `syntaxHighlightName`）。
 *
 * 传空数组即清掉（关掉着色 / 切视图 / 卸载）。区间必须是「这一行当前的文本节点」里的，
 * 行被重新渲染之后要重新铺一次。
 */
export const setTokenRanges = (container: HTMLElement, groups: TokenBucket[]): void => {
  if (!store()) return;
  if (groups.length) tokenBuckets.set(container, groups);
  else if (!tokenBuckets.delete(container)) return;
  publish();
};

export interface TextHighlightResult {
  /** 铺了多少个命中 */
  count: number;
  /** 被当作「当前命中」的那一个；跳转时要滚到它那儿去 */
  current: Range | null;
}

/**
 * 在容器里按查询词扫文本节点铺高亮（预览区用这条）。
 *
 * 按文档顺序给命中编号，编号等于 `currentIndex` 的那一个用「当前命中」的颜色。
 * 跨文本节点的命中这里连不起来——真要连就得维护一张「渲染文本 ↔ 编辑区偏移」的映射表，
 * 代价与收益不成比例。
 */
export const applyTextHighlights = (
  container: HTMLElement,
  query: string,
  options: SearchOptions,
  currentIndex: number,
  cap: number = MAX_RANGES,
): TextHighlightResult => {
  const registry = store();
  if (!registry) return { count: 0, current: null };
  const regex = buildSearchRegExp(query, options);
  if (!regex) {
    clearHighlights(container);
    return { count: 0, current: null };
  }

  const doc = container.ownerDocument;
  const bucket: Bucket = { hit: [], current: [] };
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let seen = 0;
  while (node && seen < cap) {
    const text = node.nodeValue;
    if (text) {
      regex.lastIndex = 0;
      let found: RegExpExecArray | null;
      while ((found = regex.exec(text)) !== null) {
        const value = found[0];
        if (value.length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        const range = doc.createRange();
        range.setStart(node, found.index);
        range.setEnd(node, found.index + value.length);
        if (seen === currentIndex) bucket.current.push(range);
        else bucket.hit.push(range);
        seen += 1;
        if (seen >= cap) break;
        if (found.index === regex.lastIndex) regex.lastIndex += 1;
      }
    }
    node = walker.nextNode();
  }

  buckets.set(container, bucket);
  publish();
  return { count: seen, current: bucket.current[0] ?? null };
};
