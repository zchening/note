/**
 * 导出长图 —— 离屏书纸卡渲染
 *
 * 🔴 移植依据：老项目 index.html:2884-3200（v10.0.4 形态）。两处都读过，不靠推理定案。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么是「离屏副本」而不是直接截编辑器
 *
 *   直接截编辑器会带上光标、选区、滚动条、底栏，而且桌面宽度会拖成一米宽条幅。
 *   老项目 v9.5.0 起改为**离屏渲染一张书纸卡**：外衬卡（--box-bg）裱内衬（--bg），
 *   页头一枚金题线 + 日期、页脚品牌标 + 随机题句，全图只有两处金色。
 *   桌面出图宽度封顶 640px（书内文行宽），触屏跟编辑器宽——
 *   书纸行宽是给窄条幅治的，不是给窄屏加码的。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三条纪律（每条都对应一个老项目踩过的坑）
 *
 *   1. **html2canvas 必须自托管 + 懒加载**。
 *      老项目 v7.5.1：挂公共 CDN 时 jsdelivr 在大陆常不可达，
 *      手机端表现为「图片导出组件未加载」，而用户完全看不出是网络问题。
 *      改为导出时才从同源 /html2canvas.min.js 拉一次，之后复用。
 *
 *   2. **剪贴板写入必须留在用户手势窗口内**。
 *      老项目 v7.7.0 血泪：旧链路「渲染完再 clipboard.write」——
 *      移动端 html2canvas(scale:2) 动辄数秒，用户手势(transient activation)
 *      过期必被拒；且 Android WebView 对图片写剪贴板长期不可用。
 *      新链路：①渲染 Promise **直接装进 ClipboardItem**，write() 立即调用、
 *      延迟兑现；②失败逐级回退。
 *
 *   3. **回退阶梯必须走到底，且最后一档永远可用**。
 *      阶梯：剪贴板 → APP 原生桥 → 系统分享面板 → 全屏预览（长按保存）。
 *      前三档在任何一档都可能被拒（无 API / 被拒 / 用户取消），
 *      全屏预览是唯一不依赖任何权限的出口。少一档就是"某些手机上导出无反应"。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 与老项目的差异（刻意不同，不是漏做）
 *
 *   - 老项目有 SVG foreignObject 快路（v10.0.2提速③，白名单内联 computed）。
 *     本项目**先不做**：那条路径有 200 行样式白名单，是"性能优化"而不是
 *     "功能正确"，且它的失败模式是静默回退，测试很难判红。
 *     等真机实测html2canvas 确实慢到不可接受时再上，且必须同样有单测钉。
 *   - 老项目的折叠三角在导出图里显成 ▼ 字形（离屏副本吃不到 `#editor` 作用域的
 *     ::before）。本项目折叠标记也是 ::before，同样吃不到 —— 处理办法见
 *     EXPORT_FOLD_CSS，用**属性选择器**补一段只作用于导出副本的样式。
 */

/** 页脚随机题句（老项目 v10.0.2 句池，16 句原样保留，品牌原句两份＝×2 权重）。 */
export const EXPORT_TAGLINES: readonly string[] = [
  '记录，自有回响',
  '记录，自有回响',
  '一字一句，皆有归处',
  '日常琐碎，亦是珍藏',
  '纸上烟火，人间自留',
  '微言可存，长夜不孤',
  '心事入册，岁月成篇',
  '写字的人，不慌张',
  '落笔，心就安了',
  '慢慢写，不着急',
  '落笔，自有归处',
  '写下，即成过往',
  '一言，可抵千日',
  '此刻，来日相见',
  '微末，亦是山河',
  '独语，自成天地',
  '凡记，皆不虚行',
];

/**
 * 抽一句题句。
 *
 * 🔴 用 `crypto.getRandomValues` 而不是 `Math.random()`：题句只是装饰，
 *   但抽签走 Math.random 在某些内核里会被同源预测脚本拿到序列 ——
 *   本项目的 CSP 不阻塞这条，但没理由用它。
 *   拿不到 crypto 时**回退 Math.random 而不是抛错**：装饰性功能不该让导出失败。
 */
export function pickTagline(rand: () => number = defaultRandom): string {
  const i = Math.floor(rand() * EXPORT_TAGLINES.length);
  return EXPORT_TAGLINES[Math.min(i, EXPORT_TAGLINES.length - 1)] ?? EXPORT_TAGLINES[0]!;
}

function defaultRandom(): number {
  try {
    const buf = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(buf);
    return (buf[0] ?? 0) / 0x100000000;
  } catch {
    return Math.random();
  }
}

/** 桌面出图宽度封顶（老项目 v10.0.0 实测定稿）。 */
export const EXPORT_MAX_WIDTH = 640;

/**
 * 折叠块在导出图里的补丁样式。
 *
 * 🔴🔴 为什么必须显式补：折叠块的三角与收起态都靠 `#editor` 作用域的 ::before /
 *   `[data-open="false"]` 规则，而离屏副本**不在 #editor 里面**，一条都吃不到。
 *   老项目 v10.0.2 用户实拍报障：折叠标记在导出图里**原样显成 "[折叠]" 字**；
 *   v10.0.3 又报障：折叠正文没有缩进和左引导线（同一类根因，当时只补了三角）。
 *
 * 🔴 选择器走 `[data-ns-export]` 属性而非class：编辑器 DOM 永无此属性，零渗透。
 *   （老项目用 `.ns-export` class，那会与用户正文里恰好出现的 class 名撞车。）
 *
 * 🔴 间隙必须用 px：三角挂在 font-size:0 的标记上，em 在那里归零（老项目 mockup 实锤）。
 *
 * 🔴🔴 属性只准打在**折叠把手**上，绝不能打在离屏卡 wrap 上
 *   （用户报障「导出图本体…相比老版本左上角多了个箭头」，本批量化实锤）：
 *     老项目只在 `tmp.querySelectorAll('.ns-fold-mark')` 那一枚**行内小 span** 上
 *     打 `data-ns-export`（index.html:3099），所以 ▼ 只出现在折叠标题行首。
 *     bj 此前在 buildCard 里写了 `wrap.dataset.nsExport = '1'`
 *     —— 属性落在**整张离屏卡**上，于是 `::before` 那枚 ▼ 被画在卡片正文流最前面
 *     ＝导出图左上角凭空多一个箭头；同时 `font-size:0` 还会一并作用到整张卡
 *     （那两条是给"只有 [折叠] 文本、不留字"的小 span 用的，套到卡上就是错作用域）。
 *   修法：属性下沉到折叠把手（见 buildCard），基规则改成
 *   `[data-ns-export-fold] > :first-child::before` 一条梭。
 */
export const EXPORT_FOLD_CSS = [
  // 🔴 三角：老项目出图那枚是 ▼ 字形（index.html:3104），编辑器那枚是边框画的几何
  //   三角——**两套独立画法**（老项目 v10.0.4 拍板）。
  //   🔴🔴 bj 的折叠规则**没有锁 `#editor` 作用域**（`.ns-fold > :first-child::before`），
  //   离屏副本会照画边框三角 ⇒ 这里不是"补一个 ▼"，而是**把边框三角换成 ▼**
  //   （border:0 撤掉边框 + 给 content/尺寸），否则出图里会出现
  //   "边框三角后面再跟一个 ▼"——用户看到的"多了个箭头"就是这么来的。
  '[data-ns-export-fold] > :first-child::before{content:"\\25BC";border:0;' +
  'width:auto;height:auto;font-size:12px;line-height:1.9;color:var(--muted);' +
  'vertical-align:baseline;position:static;top:auto;margin:0 7px 0 0}',
  // 恒定展开：折叠正文在导出图里全部可见
  '[data-ns-export-fold] > :not(:first-child){display:block}',
  // 缩进 + 左引导线：逐字复刻基规则的 margin/padding/border-left
  '[data-ns-export-fold] > :not(:first-child){margin-left:.5em;padding-left:1em;border-left:2px solid var(--line)}',
].join('');

export interface BuildCardDeps {
  /** 编辑器宿主（`#editor-host`）。 */
  editorHost: HTMLElement;
  /** 当前笔记 id，用于页头右侧刻印；空名不挂。 */
  noteId: string;
  /** 品牌 SVG（顶栏那颗）。取不到就退化成纯文字落款，不报错。 */
  brandSvg: Element | null;
  /** 注入的日期（测试用；默认取当前时间）。 */
  now?: Date;
}

/**
 * 建离屏书纸卡并挂到 body。
 *
 * 🔴🔴 **返回值必须带 `dispose`**：老项目 v10.0.2 有个真事故 ——
 *   离屏卡的拆除原只写在慢路的 finally 里，而快路 return 时漏拆，
 *   于是**每次手机导出都在 body 里泄漏一张离屏卡**（点几十次导出后卡顿爆掉）。
 *   把dispose 交给调用方在 finally 里调，从结构上堵死这条路。
 */
export interface ExportCard {
  el: HTMLElement;
  dispose: () => void;
}

/** `2026-10-05 · 星期日`（老项目同格式）。 */
export function formatExportDate(now: Date): string {
  const p2 = (n: number): string => (n < 10 ? '0' : '') + n;
  const w = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()] ?? '';
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} · 星期${w}`;
}

/**
 * 长词断行。
 *
 * 🔴 为什么要断：CSS 已有 `overflow-wrap:anywhere`，但**html2canvas 不继承
 *   断行上下文**——它按自己的测量重排，一段 30 字符无空格的串会顶出卡片右缘。
 *   在序列化前主动把长串切开，是老项目 v7.x 就在做的同一件事。
 */
export function breakLongWords(s: string): string {
  return s
    .replace(/\u200B/g, '')
    .replace(/(\S{15,})/g, (m) => m.replace(/([/.?:=&#_%-])/g, '$1 '));
}

export function buildCard(deps: BuildCardDeps): ExportCard {
  const src = deps.editorHost;
  // 🔴 触屏（pointer:coarse）跟编辑器宽，桌面封顶 640。老项目口径：
  //   桌面上"一米宽条幅"是用户实拍打回的，不是审美偏好。
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches;
  const srcW = src.clientWidth || EXPORT_MAX_WIDTH;
  const shotW = coarse ? srcW : Math.min(srcW, EXPORT_MAX_WIDTH);

  const wrap = document.createElement('div');
  wrap.className = 'ns-export';
  // 🔴🔴 绝不在这里写 `wrap.dataset.nsExport = '1'`：那会把 EXPORT_FOLD_CSS 的
  //   `::before ▼` 挂到**整张卡**上，导出图左上角凭空多一个箭头（用户报障第 3 条）。
  //   老项目这里只加 `.ns-export` class（index.html:3098），属性是打在折叠把手上的。
  wrap.setAttribute(
    'style',
    'position:absolute;left:-9999px;top:0;width:' +
      shotW +
      'px;padding:16px;background:var(--box-bg);border:1px solid var(--line);border-radius:10px',
  );
  const mat = document.createElement('div');
  mat.setAttribute(
    'style',
    'background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:30px 28px 0',
  );

  // 页头：金题线 + 日期；右角 noteId 无框等宽刻印
  const head = document.createElement('div');
  head.setAttribute(
    'style',
    'display:flex;align-items:flex-end;justify-content:space-between;gap:12px',
  );
  const hdL = document.createElement('div');
  hdL.setAttribute('style', 'display:flex;align-items:center;gap:10px;flex:none');
  const rule = document.createElement('span');
  rule.setAttribute('style', 'height:1.5px;width:52px;background:var(--accent);opacity:.85;flex:none');
  const dt = document.createElement('span');
  dt.textContent = formatExportDate(deps.now ?? new Date());
  dt.setAttribute(
    'style',
    'font:12px/1 var(--mono);color:var(--muted);letter-spacing:.03em;white-space:nowrap',
  );
  hdL.appendChild(rule);
  hdL.appendChild(dt);
  head.appendChild(hdL);
  if (deps.noteId) {
    const stamp = document.createElement('span');
    stamp.textContent = deps.noteId;
    //🔴 行高 1→1.6：盒子高=字号时 g/p/q/y/j 下伸半截被 overflow:hidden 裁掉
    //   （老项目 v10.0.1 用户实拍「字母下半显示不全」）
    stamp.setAttribute(
      'style',
      'font:11px/1.6 var(--mono);color:var(--muted);letter-spacing:.12em;opacity:.6;' +
        'white-space:nowrap;max-width:45%;overflow:hidden;text-overflow:ellipsis',
    );
    head.appendChild(stamp);
  }

  // 正文：克隆编辑器 innerHTML（老项目同构）
  const tmp = document.createElement('div');
  const cs = getComputedStyle(src);
  tmp.setAttribute(
    'style',
    'padding:26px 0 0;font:' +
      cs.font +
      ';line-height:2.2;white-space:pre-wrap;word-break:break-all;' +
      'overflow-wrap:anywhere;color:' +
      cs.color,
  );
  tmp.innerHTML = src.innerHTML;
  // 链接转纯文本：导出的是**给人看的图**，不是可点的链接
  tmp.querySelectorAll('a').forEach((a) => {
    a.replaceWith(document.createTextNode(a.textContent ?? ''));
  });
  // 长词断行：见 breakLongWords 的注释
  const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const n of textNodes) {
    if (n.nodeValue) n.nodeValue = breakLongWords(n.nodeValue);
  }
  // 窄卡防溢出：640 封顶后图片必须限宽（老项目同款）
  tmp.querySelectorAll<HTMLImageElement>('img').forEach((im) => {
    im.style.maxWidth = '100%';
  });
  // 折叠块打标记 + 恒定展开（见 EXPORT_FOLD_CSS 的注释）
  // 🔴 必须收窄成 HTMLElement：querySelectorAll 返回 Element，
  //   而 dataset 只在 HTMLElement/SVGElement 上有 —— Element 上没有。
  tmp.querySelectorAll<HTMLElement>('.ns-fold').forEach((f) => {
    f.dataset.nsExportFold = '1';
  });

  // 页脚：品牌标 + 「来自 NoteSync」+ 随机题句
  const foot = document.createElement('div');
  foot.setAttribute(
    'style',
    'display:flex;align-items:center;gap:9px;padding:15px 0;margin-top:6px;border-top:1px solid var(--line)',
  );
  const brand = deps.brandSvg?.cloneNode(true);
  if (brand instanceof Element) {
    brand.setAttribute('aria-hidden', 'true');
    brand.setAttribute('style', 'width:16px;height:16px;flex:none;color:var(--accent)');
    foot.appendChild(brand);
  }
  const wm = document.createElement('span');
  wm.setAttribute(
    'style',
    'font:11.5px/1 var(--mono);color:var(--muted);letter-spacing:.14em;white-space:nowrap',
  );
  wm.appendChild(document.createTextNode('来自 '));
  const wmB = document.createElement('b');
  wmB.textContent = 'NoteSync';
  wmB.setAttribute('style', 'color:var(--accent);font-weight:600;letter-spacing:.06em');
  wm.appendChild(wmB);
  foot.appendChild(wm);
  const tail = document.createElement('span');
  tail.textContent = pickTagline();
  // 窄卡放不下先折两行，仍容纳不下才截尾（老项目 v10.0.2 用户拍板 C+D 合体）
  tail.setAttribute(
    'style',
    'margin-left:auto;font:10.5px/1.7 var(--mono);color:var(--muted);opacity:.7;' +
      'letter-spacing:.22em;text-align:right;min-width:64px;max-height:3.4em;' +
      'overflow:hidden;text-overflow:ellipsis;display:-webkit-box;' +
      '-webkit-box-orient:vertical;-webkit-line-clamp:2',
  );
  foot.appendChild(tail);

  // 折叠补丁样式挂在**副本子树内**（不是 head）：这样序列化/克隆整棵子树时
  //   样式跟着走，两条渲染路径都同源。老项目 v10.0.2 实锤过这个姿势。
  const foldCss = document.createElement('style');
  foldCss.textContent = EXPORT_FOLD_CSS;

  mat.appendChild(head);
  mat.appendChild(tmp);
  mat.appendChild(foot);
  wrap.appendChild(mat);
  wrap.insertBefore(foldCss, wrap.firstChild);

  //🔴 借壳（国产强制反色）给 img/canvas 钉了 filter:invert(1)!important，
  //   html2canvas 从 wrap 起渲会无视祖先整层反色、却忠实执行图片自身 filter
  //   —— 不钉回去，借壳态导出图里的正文图会比卡片底多翻一次色。
  //   内联 !important 压过样式表 !important；非借壳态是无害 no-op。
  wrap.querySelectorAll<HTMLElement>('img,canvas').forEach((el) => {
    el.style.setProperty('filter', 'none', 'important');
  });

  document.body.appendChild(wrap);

  return {
    el: wrap,
    dispose: () => {
      if (wrap.parentNode === document.body) document.body.removeChild(wrap);
    },
  };
}

/**
 * 等布局与图片解码落定。
 *
 * 🔴 双 rAF + 60ms 定时器赛跑：单rAF 在无 rAF 环境（jsdom）不挂，
 *   纯定时器又会在图片未解码时开跑（老项目 v10.0.2 提速②：多图长笔记的主要耗时点）。
 */
export function settleCard(wrap: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const fin = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      requestAnimationFrame(() => requestAnimationFrame(() => fin()));
    } catch {
      /* 无 rAF 环境靠定时器兜底 */
    }
    setTimeout(fin, 60);
    const imgs = Array.prototype.slice.call(wrap.querySelectorAll('img')) as HTMLImageElement[];
    if (imgs.length === 0) return;
    void Promise.all(
      imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())),
    ).then(fin);
  });
}
