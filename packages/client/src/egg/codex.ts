/**
 * 彩蛋图鉴 —— `?eggs` 或菜单入口打开
 *
 * 🔴🔴 三条复刻纪律（全部来自老项目踩过的坑）：
 *   1. **未发现的彩蛋必须打码**（名字显示 ???、提示显示"还没被发现"），
 *      且**不可点**。否则用户点进去发现"啥也没有"，图鉴就失去了探秘的意义。
 *   2. **计数分子绝不大于分母**（读记录时按注册表过滤，见 registry.ts）。
 *   3. 打开图鉴要**暂停正在跑的游戏**（老项目 nsEggOpen 同款）——
 *      不暂停的话后台 rAF 继续跑，切回来时分数已经变了，而用户在看图鉴。
 *
 * 关闭时必须**把焦点还给编辑器**（老项目红线10）：桌面端编辑器失焦后
 * 光标不绘制，用户会觉得"关掉弹窗就打不了字了"。
 */

import { COPY } from '../ui/copy.ts';
import { EGGS, readDiscovered, type EggStore } from './registry.ts';

export interface Codex {
  el: HTMLElement;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

export interface CodexCallbacks {
  /** 点某个已发现彩蛋的「再玩一次」。 */
  onReplay: (id: string) => void;
  /** 关闭时归还焦点。 */
  onClosed: () => void;
  /** 打开时暂停正在跑的游戏（没有游戏在跑就什么都不做）。 */
  onPauseGame: () => void;
}

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';

const GO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export function buildCodex(host: HTMLElement, store: EggStore, cb: CodexCallbacks): Codex {
  const el = document.createElement('div');
  el.className = 'mask hidden';
  el.id = 'eggMask';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', COPY.eggBookTitle);
  host.appendChild(el);

  let open = false;

  const render = (): void => {
    const got = readDiscovered(store);
    el.innerHTML =
      '<div class="box qr-box">' +
      '<div class="modal-head">' +
      `<h1 class="qr-title">${COPY.eggBookTitle}</h1>` +
      `<div id="eggX" class="box-x" role="button" tabindex="0" title="${COPY.back}" aria-label="${COPY.back}">${CLOSE_SVG}</div>` +
      '</div>' +
      '<div id="eggList"></div>' +
      `<div class="egg-count" id="eggCount">${COPY.eggCount(got.size, EGGS.length)}</div>` +
      `<p class="link-hint">${COPY.eggBookSub}</p>` +
      `<button id="eggClose">${COPY.eggBookClose}</button>` +
      '</div>';

    const list = el.querySelector<HTMLElement>('#eggList');
    if (!list) throw new Error('图鉴结构不完整：buildCodex 与模板不同源');

    for (const e of EGGS) {
      const on = got.has(e.id);
      const row = document.createElement('div');
      row.className = 'egg-row' + (on ? '' : ' locked');
      row.setAttribute('data-egg', e.id);
      // 🔴 名字与提示都走 textContent：hint 里将来可能出现用户自定义内容
      const n = document.createElement('span');
      n.className = 'egg-name';
      n.textContent = on ? e.name : COPY.eggLockedName;
      const h = document.createElement('span');
      h.className = 'egg-hint';
      h.textContent = on ? e.hint : COPY.eggLockedHint;
      row.appendChild(n);
      row.appendChild(h);
      // 🔴 只有「已发现 **且** 可复现」才给勾。未发现的行仍挂 role=button 吗？
      //   不挂 —— 挂了就意味着"这是个能点的按钮"，而点它什么都不发生，
      //   对读屏用户是明确的坏体验。
      if (on && e.replayable) {
        const g = document.createElement('span');
        g.className = 'egg-go';
        g.innerHTML = GO_SVG;
        row.appendChild(g);
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        const go = (): void => cb.onReplay(e.id);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            go();
          }
        });
      }
      list.appendChild(row);
    }
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    el.classList.add('hidden');
    el.innerHTML = '';
    // 🔴 关闭时把焦点还给编辑器（桌面端失焦后光标不绘制 —— 老项目红线10）
    cb.onClosed();
  };

  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  // Esc 关闭。注意图鉴的 Esc 监听必须**先**于游戏外壳的（老项目踩过：
  //   冒泡阶段轮到自己时游戏已经处理完 Esc 并收壳了，图鉴关不掉）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    }
  });

  return {
    el,
    close,
    isOpen: () => open,
    open: () => {
      open = true;
      render();
      el.classList.remove('hidden');
      // 🔴 顺序：先渲染后通知暂停。反过来的话暂停回调里若读图鉴DOM 会拿到旧的
      el.querySelector<HTMLElement>('#eggClose')?.addEventListener('click', close);
      el.querySelector<HTMLElement>('#eggX')?.addEventListener('click', close);
      el.querySelector<HTMLElement>('#eggX')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          close();
        }
      });
      cb.onPauseGame();
    },
  };
}
