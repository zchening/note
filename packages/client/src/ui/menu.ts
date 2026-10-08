/**
 * 菜单面板：主视图 11 项 + 三个二级视图（收藏夹 / 历史版本 / 链接打开方式）
 *
 * 🔴🔴 复刻纪律：
 *   1. **恰好 11 项**，id 与 copy.ts 的 MENU_ITEM_IDS 一一对应，不多不少。
 *      "顺手加一项"看起来是好事，实际是复刻失败 —— 用户会问"这个新按钮是干什么的"。
 *   2. 收藏项是**互斥双文案**（收藏笔记 / 取消收藏），随收藏态切换，不是两个菜单项。
 *   3. 主题项也是互斥双文案（夜间模式 / 日间模式），且**点击是切换**不是"选中"，
 *      没有第三态（老项目没有"跟随系统"，见 ui/theme.ts 的 resolveTheme）。
 *   4. 二级视图只有"返回"，没有路由 —— 面板内换 view，老项目就是这样。
 *
 * 文案全从 copy.ts 取，图标全从 icons.ts 取，本文件不写字面量。
 */

import { COPY, MENU_ITEM_IDS } from './copy.ts';
import { escapeTrunc } from './escape.ts';
import {
  ICON_BACK,
  ICON_CHECK,
  ICON_CHEVRON,
  ICON_CLOCK,
  ICON_FOLDER,
  ICON_HANDOFF,
  ICON_HOME,
  ICON_INFO,
  ICON_KEY,
  ICON_LINK,
  ICON_LINK_APP,
  ICON_LINK_BROWSER,
  ICON_LOCK,
  ICON_MOON,
  ICON_PAW,
  ICON_PLUS,
  ICON_STAR,
  ICON_STAR_FILLED,
  ICON_SUN,
  ICON_X,
} from './icons.ts';

export type MenuView = 'main' | 'fav' | 'hist' | 'link' | 'conflict';

export interface MenuState {
  /** 当前笔记是否已收藏（决定收藏项文案与星标实心）。 */
  faved: boolean;
  /** 当前是否夜间（决定主题项文案与图标）。 */
  night: boolean;
  /** 链接默认打开方式。**仅对本机生效**（老项目原文），所以只存内存 + localStorage。 */
  linkInApp: boolean;
  /** 收藏夹内容。S5 之后由真源/本地存储喂进来。 */
  favList: Array<{ name: string }>;
  /** 历史版本列表。S5 之后由真源喂进来。 */
  histList: Array<{ at: string; label: string }>;
  /**
   * 🔴 列表**拉取失败**的原因（非空时覆盖空态文案）。
   *
   * 🔴🔴 不把这层意思压进 `histList.length === 0`：那是两个完全不同的事 ——
   *   "服务端确实没有历史版本" 与 "网络断了没拉到"。
   *   合成一个空数组的话，历史页会显示「暂无历史版本」，
   *   而真实原因是"现在拿不到" —— 用户以为改动没被记下来，
   *   而历史版本是找回丢失内容的唯一指望。这是比"功能坏了"更糟的误导。
   */
  histFail: string;
  /**
   * 🔴 当前**正展开预览**的那一版时间戳（老项目 `histPreviewTs`，index.html 同名变量）。
   * 空字符串 = 都没展开。
   *
   * 🔴🔴 为什么要状态而不是"点开就往 DOM 里塞"：展开/收起是**同一个按钮**的两种结果
   *   （老项目：`const old = row.querySelector('.hist-preview'); if (old) {收起; return; }`）。
   *   若不记住"当前开着哪一版"，用户连点两行就会同时展开两个预览，
   *   而第二次点击本该把第一次收掉。`null` 与"这一版预览为空"要分得开，
   *   所以用时间戳当键而不是布尔。
   */
  histPreviewTs: string;
  /**
   * 各行**预览出来的正文**（已转纯文本），键是时间戳。
   * 空对象 = 都没预览。老项目把这段直接塞进 DOM，这里放状态是为了让
   * `render()` 能整体重画（展开/收起是同一个按钮的两种结果）。
   */
  histPreviewText: Record<string, string>;
  /**
   * 预览失败/不可用时行内落的提示（老项目 `toast('该版本不可用')`）。
   * 空 = 本行没失败。**按行存**而不是全局一条：老项目逐行标 bad，
   * 否则一个失效版本会把整页都标成"不可用"。
   */
  histPreviewErr: Record<string, string>;
  /**
   * 同步冲突条目。空数组 = 无冲突。
   * 🔴 状态里放的是**已经算好的文案**，不是原始 diff。菜单只负责显示，
   *   让它自己去理解 base/left/right 就会有两套"怎么算冲突"的理解。
   */
  conflicts: Array<{ at: string; label: string }>;
}

export interface MenuCallbacks {
  onClose: () => void;
  onHome: () => void;
  onToggleFav: () => void;
  onOpenFav: (name: string) => void;
  /**
   * 存一版快照。返回 Promise 是为了**存完再重画**：
   * 快照是网络往返，直接 `cb.onSaveHist(); render();` 会先画一遍旧列表 ——
   * 用户会看到"点了没反应，过一会儿才多一行"，而那一行还是他自己刚存的当前版本。
   */
  onSaveHist: () => Promise<void> | void;
  /**
   * 进入历史二级视图时拉列表。菜单只负责触发与重画，**不认识网络**。
   */
  onLoadHist: () => Promise<void> | void;
  onOpenHist: (at: string) => void;
  /**
   * 🔴 取某一版**预览**（老项目 pv按钮，index.html:8481起）。
   * 🔴 只在菜单**外面**做（解密、网络、失败话术都在 main.ts）——
   *   菜单不认识网络也不持有密钥，这与 onLoadHist 的分工同款。
   */
  onPreviewHist: (at: string) => Promise<void> | void;
  onLinkMode: (inApp: boolean) => void;
  onBackup: () => void;
  onPet: () => void;
  onToggleTheme: () => void;
  onChangePass: () => void;
  onLock: () => void;
  onAbout: () => void;
  /** 冲突裁决：保留本机 / 保留云端 */
  onKeepLocal: () => void;
  onKeepRemote: () => void;
}

/** 11 项的图标与文案解析。**顺序即菜单显示顺序**（老项目从上到下）。 */
function mainItems(st: MenuState): Array<{ id: string; icon: string; label: string }> {
  return [
    { id: 'menuHome', icon: ICON_HOME(), label: COPY.menuHome },
    //🔴 收藏是互斥双文案，不是两项
    { id: 'menuFav', icon: ICON_STAR(st.faved), label: st.faved ? COPY.menuFavOff : COPY.menuFavOn },
    { id: 'menuFavEntry', icon: ICON_FOLDER(), label: COPY.menuFavEntry },
    { id: 'menuHistEntry', icon: ICON_CLOCK(), label: COPY.menuHistEntry },
    { id: 'menuLink', icon: ICON_LINK(), label: COPY.menuLink },
    { id: 'menuBackup', icon: ICON_HANDOFF(), label: COPY.menuBackup },
    { id: 'menuPet', icon: ICON_PAW(), label: COPY.menuPet },
    { id: 'menuTheme', icon: st.night ? ICON_SUN() : ICON_MOON(), label: st.night ? COPY.menuThemeLight : COPY.menuThemeDark },
    { id: 'menuPass', icon: ICON_KEY(), label: COPY.menuPass },
    { id: 'menuLock', icon: ICON_LOCK(), label: COPY.menuLock },
    { id: 'menuAbout', icon: ICON_INFO(), label: COPY.menuAbout },
  ];
}

export interface Menu {
  el: HTMLElement;
  /** 打开面板（回到主视图）。 */
  open: () => void;
  /** 重画当前视图（状态变了就调一次）。 */
  render: () => void;
  close: () => void;
  isOpen: () => boolean;
  /**
   * 打开面板并**直接落到指定视图**。
   * 🔴 不这么设计的话，调用方只能 open() 之后再想办法切视图 ——
   *   而 view 是模块内私有变量，外部改不了。绕开的结果通常是
   *   "先 open 主视图，用户自己点三下才看到冲突" —— 冲突不等人。
   */
  openView: (v: MenuView) => void;
}

export function buildMenu(host: HTMLElement, st: MenuState, cb: MenuCallbacks): Menu {
  const el = document.createElement('div');
  el.className = 'mask hidden';
  el.id = 'menuMask';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', COPY.titleMenu);
  // 🔴🔴🔴 菜单盒 `.box` **必须在这里建一次并常驻**，render() 只换它的 innerHTML。
  //
  //   根因（用户报障第 6 条「历史版本→点击预览的时候，页面不要闪一下」，
  //   2026-10-07 真浏览器 rAF 逐帧实锤，不是推理）：
  //   此前 render() 走 `el.innerHTML = '<div class="box menu-box">…'` —— 整块重建。
  //   而 `ui/styles.css:134` 的 `.box` 挂着
  //     `animation: nsRise .5s cubic-bezier(.2,.7,.3,1) both`
  //     （from{opacity:0;transform:translateY(10px)}）。
  //   ⇒ 每点一次预览，`.box` 作为一个**全新元素**重新入场：
  //     整张菜单在 0.5s 里从透明+下移 10px 淡入上来。
  //   实测采样（点一次预览，44 帧）：opacity 从 "0" 爬到 "1"，
  //     其中 13 帧 opacity<0.99、43 帧 transform≠none。
  //     这就是"闪一下"——不是内容问题，是**盒被重建 ⇒ 入场动画重播**。
  //
  //   老项目（index.html:686）`<div class="box" id="menuBox">` 是 **HTML 里常驻的节点**，
  //   全文没有 `menuBox.innerHTML = ''`；关菜单只 `menuMask.classList.add('hidden')`（:8035），
  //   预览走 `row.appendChild(box)`（:8512）只加一个子节点 —— **从不碰菜单盒本身**。
  //   所以老项目的 rise 只在每次真正打开菜单时播一次，state 变化不重播。
  //
  //   ⚠️ 与"删掉 .box 的 animation"是两回事：入场动画要留着（老项目 :509 有），
  //     正解是**盒子常驻 + 只换内容**，让动画有资格只在首次显示时播。
  //   判据：16-visual-views.test.js 的 VVW-30（零中间帧 + 节点身份）
  //   与 VVW-31（反向闸：首次打开仍必须播）。
  //
  // 🔴 `tabindex="-1"` 不是可选项：没有它 div 不可聚焦，`focus()` 是**静默 no-op**，
  //   Esc 照样关不掉菜单（e2e VIS-05 实锤）。-1 = 可编程聚焦但**不进 Tab 序列**
  //   （菜单不该让用户 Tab 进去逐项走）。
  const box = document.createElement('div');
  box.className = 'box menu-box';
  box.tabIndex = -1;
  el.appendChild(box);
  host.appendChild(el);

  /* ------------------------------------------------------------------ *
   * 触屏首击兜底 —— 老项目 index.html:7915-7938 `menuTapGuard`
   * ------------------------------------------------------------------ */

  /**
   * 病根（老项目 v6.2/v6.3 实测，不是推测）：菜单主视图是
   *   `#menuMainView{max-height:min(72vh,560px);overflow-y:auto}`（styles.css）
   *   这样一个**滚动容器**。触屏上手指落下时浏览器先要判"这是不是一次滚动手势"，
   *   于是**第一次点按的 click 会被吞掉** —— 用户看到的是
   *   「返回首页要点两次」「点收藏没反应」。
   *
   * 🔴 `touch-action: manipulation`（老项目 :437 / bj `.menu-item` 也有）
   *   **管不了这个**：它只去掉双击缩放那 300ms 延迟，管不了"手势判定吞掉 click"。
   *   所以必须有这段兜底，靠了 CSS 就等于没修。
   *
   * 🔴🔴 兜底的四段时序缺一不可，任何一段漏了都会变成**更坏的 bug**：
   *   1. `pointerdown` 记起点 → 才知道后面有没有位移；
   *   2. `pointermove` 超阈值判为滚动 ⇒ 不补（**真在滚动时不许误触发菜单项**，
   *      漏了这条的症状是"想滚列表却跳进了某篇笔记"）；
   *   3. `pointerup` 后等 350ms，真实 click 始终没到 ⇒ 补一次 `el.click()`；
   *   4. 万一迟到的真实 click 后到 ⇒ capture 阶段吞掉（**防一次点击执行两遍**。
   *      漏了这条的症状是"点一下开了两个弹层 / 发了两次请求"）。
   *
   * 🔴 挂在**常驻的 `box`** 上（不是每次 render 后的行）：`box` 全生命周期唯一，
   *   而 `box.innerHTML` 每次 render 都换 —— 挂在行上等于每换一次视图重新接一次线，
   *   且二级页的行在 `close()` 时被清空，监听器跟着一起丢。
   *   （这与"盒子常驻、只换内容"那条修「点预览闪一下」的纪律同源。）
   */
  (function tapGuard(): void {
    /** 位移超过这么多像素就判成滚动手势（老项目原文：10）。 */
    const MOVE_TOLERANCE_PX = 10;
    /** 等真实 click 的时长（老项目原文：350ms）。 */
    const SYNTH_WAIT_MS = 350;
    /** 补发后吞掉迟到真实 click 的窗口（老项目原文：800ms）。 */
    const SYNTH_WINDOW_MS = 800;
    /**
     * 需要兜底的行。
     *
     * 🔴 **比老项目多一个 `.list-row`**：老项目只写 `.menu-item`，但它的收藏夹 /
     *   历史版本列表同样是滚动容器（`#menuFavList/#menuHistList` 都带 max-height
     *   + overflow-y，bj 对应 `.list-scroll`），**同一个病根在二级页照样成立**，
     *   老项目那句是漏了二级页。这里按病根而不是按字面补齐。
     *   `.list-row` 里没接线的那几种（冲突页的只读行）`click()` 是 no-op，无害。
     */
    const ROW_SEL = '.menu-item, .list-row';

    let start: { x: number; y: number } | null = null;
    let moved = false;
    let gotClick = false;
    let synthUntil = 0;

    box.addEventListener(
      'pointerdown',
      (e) => {
        start = { x: e.clientX, y: e.clientY };
        moved = false;
        gotClick = false;
      },
      true,
    );
    box.addEventListener(
      'pointermove',
      (e) => {
        if (!start) return;
        if (Math.abs(e.clientX - start.x) > MOVE_TOLERANCE_PX) moved = true;
        if (Math.abs(e.clientY - start.y) > MOVE_TOLERANCE_PX) moved = true;
      },
      true,
    );
    box.addEventListener(
      'click',
      (e) => {
        // 迟到的真实 click：吞掉，避免与补发的那次重复执行
        if (Date.now() < synthUntil && e.isTrusted) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        gotClick = true;
      },
      true,
    );
    box.addEventListener(
      'pointerup',
      (e) => {
        // 鼠标不兜底（它没有"手势吞 click"这回事）；滚过了也不兜底
        if (e.pointerType === 'mouse' || moved || !start) return;
        const target = e.target;
        const row = target instanceof Element ? target.closest<HTMLElement>(ROW_SEL) : null;
        if (!row) return;
        setTimeout(() => {
          if (gotClick) return;
          synthUntil = Date.now() + SYNTH_WINDOW_MS;
          try {
            row.click();
          } catch {
            /* 补发失败也只等于"这次没点到"，不该冒到事件处理器里 */
          }
        }, SYNTH_WAIT_MS);
      },
      true,
    );
  })();

  let view: MenuView = 'main';
  let open = false;

  const render = (): void => {
    if (!open) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    // 🔴 二级视图整体套一层 .menu-sub：老项目靠 `#menuFavView .menu-item{justify-content:flex-start}`
    //   （:447）让二级页所有行左起笔，而主菜单九行仍居中。新项目用一层容器表达同一件事。
    const body =
      view === 'main'
        ? renderMain()
        : `<div class="menu-sub">${
            view === 'fav'
              ? renderFav()
              : view === 'hist'
                ? renderHist()
                : view === 'conflict'
                  ? renderConflict()
                  : renderLink()
          }</div>`;
    // 🔴🔴 菜单**没有右上角关闭 X**（老项目 index.html `<div class="box" id="menuBox">` 内
    //   确实没有 box-x，全文只有二级视图的「返回」行 + 点遮罩 + Esc 三种退出方式）。
    //   bj 曾自己加一个 #menuClose，导致收藏夹/历史版本/打开链接三个二级页右上角
    //   都多出一个预期外的 X（用户报障第 4 条）。
    //   现在删掉，退出方式与老项目一致：点遮罩空白 / 按 Esc / 点菜单项。
    // 🔴 只换**常驻盒子**的内容，**不碰盒子本身**（老项目 index.html:686 的
    //   `#menuBox` 是 HTML 常驻节点）。整块 `el.innerHTML = '<div class="box …>'`
    //   会把盒子重建 ⇒ `.box` 的 `animation: nsRise .5s both`（styles.css:134）
    //   每帧 state 变化都重播一次 ⇒ 用户看到"页面闪一下"（报障第 6 条）。
    //   逐帧实测与判据见 buildMenu 里 box 的注释。
    box.innerHTML = body;
    wire();
    // 🔴🔴 打开后必须把焦点收进菜单，否则**键盘用户按 Esc 关不掉菜单**。
    //   症状（e2e VIS-05 实锤）：`el.addEventListener('keydown')` 里判Esc 关菜单，
    //   但打开菜单时焦点仍在编辑器上 ⇒ Esc 的 target 是编辑器，事件不冒到遮罩
    //   ⇒ 菜单纹丝不动。用户接着点顶栏按钮，被遮罩拦成 "intercepts pointer events"，
    //   表现就是"菜单卡住关不掉"，零报错。
    //   role="dialog" + aria-modal="true" 按规范也要求焦点进入对话框。
    //   焦点给到**菜单盒本体**（不是某一行的 tabindex）——行是 div role=button，
    //   聚焦它会让读屏/键盘用户以为直接进入了某一菜单项。
    //   try 包住：极端环境（元素尚未布局）focus 可能抛，抛了不该让整个 open 失败。
    //   🔴 焦点给常驻盒子（不再 querySelector 重新找）——盒子是同一个对象，
    //   focus 是幂等的，不会在每次 render 时把焦点弹来弹去。
    try {
      box.focus({ preventScroll: true });
    } catch {
      /* 焦点收不进菜单不该影响菜单本身可用 */
    }
  };

  /**
   * 拉历史列表并重画历史视图。
   *
   * 🔴 三个必须都在这里挡掉，否则症状是"菜单整个坏掉"：
   *   1. 回调抛错（网络/解析）→ try 吞掉，**不能让它冒到 wire 的事件处理器里**；
   *   2. 拉的过程中用户已经返回主视图或关掉菜单 → 不许再 render，
   *      否则会把已关的面板重新 innerHTML 一遍（"关不掉菜单"）；
   *   3. 拉的过程中用户切了视图 → 同上，且不该拿这次的列表去画别的视图。
   */
  const reloadHist = async (): Promise<void> => {
    try {
      await cb.onLoadHist();
    } catch {
      /* onLoadHist 自己负责兜底文案；这里只保证不把异常抛进事件处理器 */
    }
    if (!open || view !== 'hist') return;
    render();
  };

  /**
   * 二级视图标题行 —— **标准菜单行**，不是另画的一行。
   *
   * 🔴🔴 老项目 index.html:701/706/712 的返回行就是 `.menu-item` 本体：
   *   `<div id="menuFavBack" class="menu-item"><svg …/><span class="mi-l">返回</span></div>`
   *   靠 `#menuFavView .menu-item{justify-content:flex-start}`（:447）左起笔。
   *   原新项目用的是「32px 小 box-x + 15px 粗标题」，形态与主菜单完全不同 ——
   *   同一个"菜单项"在两层视图里长成两种样子，点进去像换了个应用。
   */
  const head = (title: string): string =>
    `<div class="menu-item" id="menuBack" role="button" tabindex="0">` +
    `<span class="ic">${ICON_BACK()}</span><span class="mi-l">${title}</span></div>`;

  /**
   * 三个二级视图（收藏夹 / 历史版本 / 打开链接）的返回行。
   *
   * 🔴🔴 文案是**「返回」两字**，不是该页的标题（用户报障「历史版本界面和老版本不一样」）：
   *   老项目 index.html:701/706/712 三处返回行的 `<span class="mi-l">` 全是「返回」，
   *   页名只体现在**从主菜单点进来的那一项**上（主菜单行写着「历史版本」）。
   *   bj 此前把 `head()` 复用成"标题行"，于是历史页顶部写的是「历史版本」——
   *   一眼看去像是"自己点进了自己"，且行宽比老项目多四个字。
   */
  const backRow = (): string => head(COPY.back);

  /**
   * 二级页空态 —— **图标 + 短句**的居中构图（老项目 index.html:494-497）。
   *
   * 🔴🔴 老项目 `#menuFavEmpty` / `#menuHistEmpty` 是
   *   `display:flex;flex-direction:column;align-items:center;gap:8px;
   *    text-align:center;color:var(--muted);font-size:12.5px;padding:22px 0 16px`
   *   外加一枚 **22px / opacity .55** 的轮廓图标（收藏=空心星、历史=时钟）。
   *   bj 此前是 `.empty{padding:26px 0;font-size:13px}` 的一句裸文本，
   *   既没有图标、字号与留白也都不同 —— 空列表页看着像"报错"而不是"还没内容"。
   */
  const emptyState = (icon: string, text: string): string =>
    `<div class="empty"><span class="empty-ic">${icon}</span><span>${text}</span></div>`;

  /** 历史页底部那枚「新增历史版本」——老项目 :709 也是一条独立菜单行，不塞进标题行。 */
  const histSaveRow = (): string =>
    `<div class="menu-item" id="histSave" role="button" tabindex="0">` +
    `<span class="ic">${ICON_PLUS()}</span><span class="mi-l">${COPY.histSave}</span></div>`;

  const renderMain = (): string => {
    const items = mainItems(st)
      .map(
        (it) =>
          `<div class="menu-item" id="${it.id}" role="button" tabindex="0">` +
          `<span class="ic">${it.icon}</span><span class="mi-l">${it.label}</span></div>`,
      )
      .join('');
    return `<div id="menuMainView" class="menu-view">${items}</div>`;
  };

  const renderFav = (): string => {
    // 🔴 计数行只在**有收藏**时出现（老项目同款：`if (favs.length) kick.textContent = ...`）。
    //   空列表时挂一句「收藏 · 0 篇」是给一个空页面加噪音。
    const kick = st.favList.length
      ? `<div class="list-kicker">${COPY.favKicker(st.favList.length)}</div>`
      : '';
    // 🔴 三列结构逐字对老项目 index.html:7986-7991：金星列(fav-star 18px)
    //   + 等宽名(fav-name 13.5px) + 右箭头(fav-go 14px)。
    //   少了图标列与箭头列，行就退化成一句裸文本 —— 与主菜单的胶囊行族脱节。
    const rows = st.favList.length
      ? st.favList
          .map(
            (f) =>
              `<div class="list-row" data-name="${escapeTrunc(f.name)}" role="button" tabindex="0">` +
              `<span class="fav-star">${ICON_STAR_FILLED()}</span>` +
              `<span class="fav-name">${escapeTrunc(f.name)}</span>` +
              `<span class="fav-go">${ICON_CHEVRON()}</span></div>`,
          )
          .join('')
      : emptyState(ICON_STAR(false), COPY.favEmpty);
    return `${backRow()}${kick}<div class="list-scroll">${rows}</div>`;
  };

  const renderHist = (): string => {
    // 🔴 计数行同fav：只在**有版本**时出现（老项目 :8485 `if (list.length) kick.textContent = ...`）。
    //   空列表时挂一句「版本 · 0 个」是给一个空页面加噪音。
    const kick = st.histList.length
      ? `<div class="list-kicker">${COPY.histKicker(st.histList.length)}</div>`
      : '';
    // 🔴 三列（时钟 16px + 等宽时间 + [预览][恢复]）。老项目 :8490-8491 用 HIST_CLOCK_SVG。
    //
    // 🔴🔴 **历史行没有右箭头**（用户报障「历史版本界面和老版本不一样」）：
    //   老项目 .fav-row 有 `.fav-go`（可进入的暗示：点行=打开那篇收藏），
    //   而 .hist-item（:465）**只有时钟 + hist-line（时间 + 两枚按钮）**，
    //   行本身不可进入（点行没有行为，行为全在两枚按钮上）。
    //   bj 此前把 .fav-row 的箭头原样抄过来 ⇒ 历史页每一行末尾多一枚 14px 箭头，
    //   且它暗示了一个**不存在**的"点整行"行为。
    //
    // 🔴🔴 中间那个 .grow 是**必要的第四列**，不是美化：.hist-meta 自身
    //   `flex:1;min-width:0`（styles.css；white-space:nowrap 已按"历史版本
    //   显示完整时间"移除 —— 2026-10-08，见 styles.css .hist-meta 处注释），
    //   没有它的话 meta 会吃掉恢复按钮的宽度，把「恢复」两字挤成竖排 ——
    //   老项目那边的等价约束写在 `.hist-line{flex:1;min-width:0}`（index.html:466）。
    //
    // 🔴🔴 每行是 `[预览][恢复]` **两枚**按钮（老项目 index.html:8481-8482同款），
    //   此前只有「恢复」—— 用户报障第 4 条「历史版本页面没有预览按钮」。
    //   预览不是可有可无的附属品：**恢复是不可逆的**（老项目明确"历史不删"），
    //   用户想确认"这一版到底写了什么"只能靠先看一眼。
    //   容器 .hist-btns 承担 gap 与不压缩，meta 那个 .grow 仍必须在它之前。
    const rows = st.histList.length
      ? st.histList
          .map((h) => {
            const at = escapeTrunc(h.at, 30);
            const open = st.histPreviewTs === h.at;
            const err = st.histPreviewErr[h.at] ?? '';
            // 🔴 先收进局部变量再escapeTrunc：写在内联模板里的 `st.histPreviewText[h.at]`
            //   类型是 `string | undefined`，而 escapeTrunc 只要 string（TS2345）。
            //   顺带也让"这一版没有预览文本"与"预览文本是空串"分成两件事。
            const previewText = st.histPreviewText[h.at] ?? '';
            return (
              // 🔴 `hist-row` 不是装饰类名：老项目 `.hist-item` 与 `.fav-row` 的
              //   内边距/字号**不同**（:456 vs :465 —— 9px/13px vs 10px/14px），
              //   bj 用一个 .list-row 同时承担两族行，只能靠这一级把历史行拉回老值。
              `<div class="list-row hist-row${open ? ' hist-open' : ''}" data-at="${at}" role="button" tabindex="0">` +
              `<span class="hist-clock">${ICON_CLOCK()}</span>` +
              `<span class="hist-meta">${escapeTrunc(h.label)}</span>` +
              `<span class="grow"></span>` +
              // 🔴 失效态：老项目 markHistBad 把这一行置灰并**禁用两枚按钮**
              //   （index.html .hist-item.hist-bad{opacity:.5;border-style:dashed}）。
              //   理由是"点了必然失败"，让按钮还能点就是骗用户白等一趟网络。
              `<span class="hist-btns">` +
              `<button type="button" class="row-btn" data-preview="${at}"${err ? ' disabled' : ''}>${COPY.histPreview}</button>` +
              `<button type="button" class="row-btn" data-restore="${at}"${err ? ' disabled' : ''}>${COPY.histRestore}</button>` +
              `</span>` +
              // 🔴 预览正文放在行**末尾**（老项目 `row.appendChild(box)` 同款）：
              //   插在中间会把后面的行挤下去，且展开/收起时高度跳变。
              //   ⚠️ 300 是老项目的截断上限（index.html:8489 `.slice(0, 300)`）：
              //   预览是"看一眼"，不是把整篇读完；不截的话一个长版本会把列表撑到爆。
              (open && previewText
                ? `<div class="hist-preview">${escapeTrunc(previewText, 300)}</div>`
                : '') +
              (err ? `<div class="hist-preview">${escapeTrunc(err, 300)}</div>` : '') +
              `</div>`
            );
          })
          .join('')
      : emptyState(ICON_CLOCK(), escapeTrunc(st.histFail || COPY.histEmpty));
    return `${backRow()}${kick}<div class="list-scroll">${rows}</div>${histSaveRow()}`;
  };

  const renderConflict = (): string => {
    if (st.conflicts.length === 0) {
      return `${head(COPY.conflictTitle)}<div class="menu-view"><div class="empty">${COPY.conflictEmpty}</div></div>`;
    }
    const rows = st.conflicts
      .map(
        (c) =>
          `<div class="list-row"><span class="grow">${escapeTrunc(c.label)}</span></div>`,
      )
      .join('');
    const picks =
      `<div class="menu-view">` +
      `<div class="menu-item" id="cfKeepLocal" role="radio" aria-checked="false" tabindex="0">` +
      `<span class="ic"></span><span class="mi-l">${COPY.conflictKeepLocal}</span></div>` +
      `<div class="menu-item" id="cfKeepRemote" role="radio" aria-checked="false" tabindex="0">` +
      `<span class="ic"></span><span class="mi-l">${COPY.conflictKeepRemote}</span></div>` +
      `</div>`;
    return `${head(COPY.conflictTitle)}<div class="list-kicker">${COPY.conflictKicker}</div>${rows}${picks}`;
  };

  const renderLink = (): string => {
    // 🔴🔴 这一页此前有三处与老项目不一致（用户报障第 4 条
    //「设置链接弹窗不同、菜单栏间距不同，且**没有显示系统浏览器图标**、
    //   **没有选中状态**」）：
    //   ① 选中标记用了 **五角星**（ICON_STAR(true)）—— 老项目是**对勾** `.tick`。
    //      复选框画成星星，语义完全不对（用户会以为"收藏"）。
    //   ② **系统浏览器那一行没有图标**：老项目两行各有一个**专属**图标
    //      （应用内=手机、浏览器=地球），bj 只有一个通用槽位。
    //   ③ `.tick` 靠 CSS `visibility:hidden` 默认隐藏、选中才 visible；
    //      bj 压根没有 `.tick` 规则，也就没��"选中态"这个视觉。
    //   修法：每行传入自己的图标 + 用 ICON_CHECK 做对勾，并补 `.tick` 的 CSS。
    const row = (id: string, label: string, on: boolean, icon: string): string =>
      `<div class="menu-item link-opt" id="${id}" role="radio" aria-checked="${on}" tabindex="0">` +
      `${icon}` +
      `<span class="mi-l">${label}</span>` +
      `<span class="tick">${ICON_CHECK()}</span>` +
      `</div>`;
    return (
      `${backRow()}` +
      `<div class="list-kicker">${COPY.linkKicker}</div>` +
      `<div class="menu-view">` +
      row('linkInApp', COPY.linkInApp, st.linkInApp, ICON_LINK_APP()) +
      row('linkBrowser', COPY.linkBrowser, !st.linkInApp, ICON_LINK_BROWSER()) +
      `</div><div class="link-hint">${COPY.linkHint}</div>`
    );
  };

  const wire = (): void => {
    // 主视图
    for (const it of mainItems(st)) {
      bind(el.querySelector<HTMLElement>('#' + it.id), () => {
        switch (it.id) {
          case 'menuHome': close(); cb.onHome(); return;
          // 🔴🔴 收藏/取消收藏**不重画整个菜单**（用户要求：「不要刷新菜单栏」）。
          //   此前 `render()` 会把菜单 innerHTML 整块换掉 ⇒ 视觉上闪一下、
          //   滚动位置复位、二级视图状态被清。
          //   现在只改那一行：文案在「收藏笔记/取消收藏」间切、图标在空心/实心间切。
          case 'menuFav': {
            cb.onToggleFav();
// 🔴 只换**这一行**的内容，不动菜单其余部分。
          //   ⚠️ 图标必须写 `ICON_STAR(st.faved)`（**无条件带 svg**），不能写
          //   `st.faved ? ICON_STAR(true) : ''` —— 后者在未收藏态把整个 svg 删掉，
          //   与 mainItems/renderMain 的首屏形态不一致：那里未收藏渲染的是
          //   **空心描边星**（svg 在、path 无 gf 类），老项目亦如此。
          //   实测我第一版就是这么写的，判据 `#menuFav svg path` 直接找不到元素，
          //   且用户视觉上会看到"星星凭空消失再出现"。
          const row = el.querySelector<HTMLElement>('#menuFav');
          if (row) {
            row.innerHTML =
              `<span class="ic">${ICON_STAR(st.faved)}</span>` +
              `<span class="mi-l">${st.faved ? COPY.menuFavOff : COPY.menuFavOn}</span>`;
          }
          return;
        }
          case 'menuFavEntry': view = 'fav'; render(); return;
          // 🔴 历史：先进视图（马上能看到返回行与空态），再拉列表。
          //   反过来做（await 完再 render）的话，在网慢时点菜单会**毫无反应** ——
          //   那是这一项的老症状，不能换个实现方式又长回来。
          case 'menuHistEntry':
            view = 'hist';
            render();
            void reloadHist();
            return;
          case 'menuLink': view = 'link'; render(); return;
          case 'menuBackup': close(); cb.onBackup(); return;
          case 'menuPet': close(); cb.onPet(); return;
          case 'menuTheme': cb.onToggleTheme(); render(); return;
          case 'menuPass': close(); cb.onChangePass(); return;
          case 'menuLock': close(); cb.onLock(); return;
          case 'menuAbout': close(); cb.onAbout(); return;
          default: return;
        }
      });
    }
    // 二级视图的返回
    bind(el.querySelector<HTMLElement>('#menuBack'), () => {
      view = 'main';
      render();
    });
    // 收藏夹行
    for (const row of el.querySelectorAll<HTMLElement>('.list-row[data-name]')) {
      const name = row.dataset.name ?? '';
      bind(row, () => {
        close();
        cb.onOpenFav(name);
      });
    }
    // 历史版本行 + 存一个快照
    //
    // 🔴🔴 恢复按钮必须 `stopPropagation`，否则它在行里点一下会**同时**触发
    //   行的「进入这一版」和按钮自己的恢复 —— 一次点击发两次网络请求，
    //   且第二次请求到达时用户可能已经看到内容换了，两次写回互相覆盖。
    //   这是行内按钮的通病，不是本功能特有的。
    for (const row of el.querySelectorAll<HTMLElement>('.list-row[data-at]')) {
      const at = row.dataset.at ?? '';
      bind(row, () => {
        close();
        cb.onOpenHist(at);
      });
      const btn = row.querySelector<HTMLElement>('[data-restore]');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          close();
          cb.onOpenHist(at);
        });
      }
      // 🔴 预览按钮：**不关菜单**（老项目同款 —— 预览是"看一眼"，
      //   关掉菜单等于把要看的东西关在门后），也不触发行的"进入这一版"。
      const pv = row.querySelector<HTMLElement>('[data-preview]');
      if (pv) {
        pv.addEventListener('click', (e) => {
          e.stopPropagation();
          // 收起/展开是同一个按钮的两种结果：先问外面"这一版现在开着吗"
          if (st.histPreviewTs === at) {
            st.histPreviewTs = '';
            render();
            return;
          }
          void (async () => {
            await cb.onPreviewHist(at);
            // 🔴 外面可能已经把面板关掉了（切笔记/退出了）——
            //   这时 render() 会把一个已关的面板重新 innerHTML 一遍（"关不掉菜单"）。
            //   reloadHist() 里有同一道门，这里照抄。
            if (open && view === 'hist') render();
          })();
        });
      }
    }
    bind(el.querySelector<HTMLElement>('#histSave'), () => {
      // 🔴 存完再重画：否则新快照那一行要等下一轮网络往返才出现在列表里，
      //   而这个按钮的全部意义就是"确认这一版被记下来了"。
      void (async () => {
        await cb.onSaveHist();
        if (open && view === 'hist') await reloadHist();
      })();
    });
    // 链接打开方式
    bind(el.querySelector<HTMLElement>('#linkInApp'), () => {
      cb.onLinkMode(true);
      render();
    });
    bind(el.querySelector<HTMLElement>('#linkBrowser'), () => {
      cb.onLinkMode(false);
      render();
    });
    // 冲突裁决
    bind(el.querySelector<HTMLElement>('#cfKeepLocal'), () => {
      close();
      cb.onKeepLocal();
    });
    bind(el.querySelector<HTMLElement>('#cfKeepRemote'), () => {
      close();
      cb.onKeepRemote();
    });
  };

  /**
   * 给 div 绑点击 + 键盘。
   *🔴 role=button/ radio 的元素必须自己处理 Enter/Space，
   *   否则键盘用户完全用不了菜单 —— 这是无障碍硬要求，不是加分项。
   */
  const bind = (node: HTMLElement | null, fn: () => void): void => {
    if (!node) return;
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    });
  };

  const close = (): void => {
    open = false;
    view = 'main';
    el.classList.add('hidden');
    // 🔴🔴 只清**盒子的内容**，不拆盒子（老项目 index.html:8035 关菜单只有
    //   `menuMask.classList.add('hidden')`，全文没有 `menuBox.innerHTML = ''`）。
    //   🔴 曾经的 `el.innerHTML = ''` 会连常驻的 `.box` 一起摘掉 —— 那样
    //   下次 open() 时它就是个"全新元素"，`.box` 的 `animation: nsRise .5s both`
    //   又要重播一遍。用户报障第 6 条「点预览时页面闪一下」修不掉。
    //   焦点落在已摘节点上的风险也顺带消失（见下面的 onClose 注释）。
    box.innerHTML = '';
    // 🔴 关掉后必须把焦点**还给编辑器**（老项目红线 10，弹窗/浮层通用纪律）。
    //   打开时我们把焦点收进了菜单（否则 Esc 关不掉，见 render 里的注释），
    //   关闭时若不还回去，焦点就落在一个刚被摘干净的节点上 ——
    //   症状是"关掉菜单后打字没反应"，而用户视角是"菜单点了没反应"。
    //   try 包住：focus 在节点已被移除时会抛。
    try {
      cb.onClose();
    } catch {
      /* 归还焦点失败不该让"菜单已关闭"这件事被判定为失败 */
    }
  };

  // 点遮罩空白处关闭（点在 box 里不关）
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  // Esc 关闭
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return {
    el,
    render,
    close,
    isOpen: () => open,
    open: () => {
      open = true;
      view = 'main';
      render();
    },
    openView: (v: MenuView) => {
      open = true;
      view = v;
      render();
    },
  };
}

/** 供测试与e2e 断言：11 项 id 的顺序就是渲染顺序。 */
export const MENU_ORDER = MENU_ITEM_IDS;
