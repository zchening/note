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
  ICON_STAR,
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
  onSaveHist: () => void;
  onOpenHist: (at: string) => void;
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
    const body =
      view === 'main'
        ? renderMain()
        : view === 'fav'
          ? renderFav()
          : view === 'hist'
            ? renderHist()
            : view === 'conflict'
              ? renderConflict()
              : renderLink();
    el.innerHTML = `<div class="box menu-box"><button type="button" id="menuClose" class="box-x" title="${COPY.back}" aria-label="${COPY.back}">${ICON_X()}</button>${body}</div>`;
    el.querySelector<HTMLButtonElement>('#menuClose')?.addEventListener('click', () => close());
    wire();
  };

  const head = (title: string, extra = ''): string =>
    `<div class="menu-head"><button type="button" id="menuBack" class="box-x" title="${COPY.back}" aria-label="${COPY.back}">${ICON_BACK()}</button>` +
    `<span class="mi-l">${title}</span>${extra}</div>`;

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
    const rows = st.favList.length
      ? st.favList
          .map(
            (f) =>
              `<div class="list-row" data-name="${escapeTrunc(f.name)}" role="button" tabindex="0">` +
              `<span class="grow">${escapeTrunc(f.name)}</span></div>`,
          )
          .join('')
      : `<div class="empty">${COPY.favEmpty}</div>`;
    return `${head(COPY.menuFavEntry)}<div class="menu-view">${rows}</div>`;
  };

  const renderHist = (): string => {
    const rows = st.histList.length
      ? st.histList
          .map(
            (h) =>
              `<div class="list-row" data-at="${escapeTrunc(h.at, 30)}" role="button" tabindex="0">` +
              `<span class="grow">${escapeTrunc(h.label)}</span></div>`,
          )
          .join('')
      : `<div class="empty">${COPY.histEmpty}</div>`;
    return `${head(COPY.menuHistEntry, `<span class="sp"></span><button type="button" id="histSave" class="row-btn">${COPY.histSave}</button>`)}<div class="menu-view">${rows}</div>`;
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
          case 'menuHistEntry': view = 'hist'; render(); return;
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
    for (const row of el.querySelectorAll<HTMLElement>('.list-row[data-at]')) {
      const at = row.dataset.at ?? '';
      bind(row, () => {
        close();
        cb.onOpenHist(at);
      });
    }
    bind(el.querySelector<HTMLElement>('#histSave'), () => {
      cb.onSaveHist();
      render();
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
