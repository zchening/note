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
  ICON_CHEVRON,
  ICON_CLOCK,
  ICON_FOLDER,
  ICON_HANDOFF,
  ICON_HOME,
  ICON_INFO,
  ICON_KEY,
  ICON_LINK,
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
  host.appendChild(el);

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
    el.innerHTML = `<div class="box menu-box"><button type="button" id="menuClose" class="box-x" title="${COPY.back}" aria-label="${COPY.back}">${ICON_X()}</button>${body}</div>`;
    el.querySelector<HTMLButtonElement>('#menuClose')?.addEventListener('click', () => close());
    wire();
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
      : `<div class="empty">${COPY.favEmpty}</div>`;
    return `${head(COPY.menuFavEntry)}${kick}<div class="list-scroll">${rows}</div>`;
  };

  const renderHist = (): string => {
    // 🔴 计数行同fav：只在**有版本**时出现（老项目 :8485 `if (list.length) kick.textContent = ...`）。
    //   空列表时挂一句「版本 · 0 个」是给一个空页面加噪音。
    const kick = st.histList.length
      ? `<div class="list-kicker">${COPY.histKicker(st.histList.length)}</div>`
      : '';
    // 🔴 同fav：三列（时钟 16px + 等宽时间 + 右箭头）。老项目 :8490-8491 用 HIST_CLOCK_SVG。
    //
    // 🔴🔴 中间那个 .grow 是**必要的第四列**，不是美化：.hist-meta 自身
    //   `flex:1;min-width:0;white-space:nowrap`（styles.css:641），
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
              `<div class="list-row${open ? ' hist-open' : ''}" data-at="${at}" role="button" tabindex="0">` +
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
              `<span class="fav-go">${ICON_CHEVRON()}</span>` +
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
      : `<div class="empty">${escapeTrunc(st.histFail || COPY.histEmpty)}</div>`;
    return `${head(COPY.menuHistEntry)}${kick}<div class="list-scroll">${rows}</div>${histSaveRow()}`;
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
    const row = (id: string, label: string, on: boolean): string =>
      `<div class="menu-item" id="${id}" role="radio" aria-checked="${on}" tabindex="0">` +
      `<span class="ic">${on ? ICON_STAR(true) : ''}</span><span class="mi-l">${label}</span></div>`;
    return (
      `${head(COPY.menuLink)}` +
      `<div class="list-kicker">${COPY.linkKicker}</div>` +
      `<div class="menu-view">` +
      row('linkInApp', COPY.linkInApp, st.linkInApp) +
      row('linkBrowser', COPY.linkBrowser, !st.linkInApp) +
      `</div><div class="link-hint">${COPY.linkHint}</div>`
    );
  };

  const wire = (): void => {
    // 主视图
    for (const it of mainItems(st)) {
      bind(el.querySelector<HTMLElement>('#' + it.id), () => {
        switch (it.id) {
          case 'menuHome': close(); cb.onHome(); return;
          case 'menuFav': cb.onToggleFav(); render(); return;
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
    el.innerHTML = '';
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
