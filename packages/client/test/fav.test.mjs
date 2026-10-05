/**
 * 收藏夹纯逻辑层单测（FAV 系列）
 *
 * 🔴 纪律来源同 UPLOAD 系列：**能在 node 里测的逻辑不许混进 DOM 模块**。
 *   favs.ts 全程不碰 document/window，注入了最小 localStorage 接口，
 *   所以这里能逐条钉死归一、排序、上限、合并口径。
 *
 * 🔴 判据不许手写第二份实现：上限用**导入的 FAVS_MAX**，不写死 100 ——
 *   写死的话老项目把上限从 20 调到 100 时测试仍然全绿，护栏形同虚设。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAVS_KEY,
  FAVS_MAX,
  favListOf,
  isFav,
  mergeFavs,
  normalizeFavs,
  readFavs,
  toggleFav,
  writeFavs,
} from '../src/fav/favs.ts';

// 🔴 类型只走 JSDoc：`.mjs` 里写不了 `type FavStore` 这种 TS 内联导入
//   （Node 只对 .ts 做类型剥离，.mjs 会直接 SyntaxError）。项目老坑。
/** @typedef {import('../src/fav/favs.ts').FavStore} FavStore */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 内存版 localStorage。可注入脏数据用来验容错。 */
function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

test('FAV-01 🔴 键名必须是 notesync_bj_ 前缀，绝不复用老项目的 notesync_favs', async () => {
  // 🔴 这是"新旧项目数据完全独立"的硬要求：共用键 ⇒ 在 bj 域收藏一篇，
  //   打开 biji 域也冒出来；老项目冻结后两边还会互相覆盖。
  assert.equal(FAVS_KEY, 'notesync_bj_favs');
  assert.notEqual(FAVS_KEY, 'notesync_favs');
  // 顺带钉住前缀本身（改键名要连带改测试，但那时必须是有意的）
  assert.ok(FAVS_KEY.startsWith('notesync_bj_'), '必须带项目独立前缀');
  void HERE;
});

test('FAV-02 新收藏排最前（老项目 unshift 语义）', () => {
  const s = memStore();
  toggleFav(s, 'a');
  toggleFav(s, 'b');
  toggleFav(s, 'c');
  assert.deepEqual(readFavs(s), ['c', 'b', 'a']);
});

test('FAV-03 取消收藏从列表里移除，且不改动其余项的相对顺序', () => {
  const s = memStore();
  ['a', 'b', 'c'].forEach((n) => toggleFav(s, n));
  assert.equal(isFav(s, 'b'), true);
  toggleFav(s, 'b');
  assert.equal(isFav(s, 'b'), false);
  assert.deepEqual(readFavs(s), ['c', 'a'], '移除 b 后 c/a 相对序不能变');
});

test('FAV-04 🔴🔴 toggle 是幂等对：连按两次回到原状', () => {
  const s = memStore();
  toggleFav(s, 'x');
  toggleFav(s, 'x');
  assert.deepEqual(readFavs(s), []);
  toggleFav(s, 'x');
  assert.deepEqual(readFavs(s), ['x']);
});

test('FAV-05 🔴🔴 脏数据必须被归一：非字符串 / 空名 / 重复 / 非数组 全部吃掉', () => {
  // 老项目 `a.filter(n => typeof n === 'string')` 没解释的后果：
  //   数字 42 漏过去后，渲染时会 encodeURIComponent(42) => "42"，
  //   于是点收藏夹跳到一篇名叫 42 的笔记（不存在）——零报错。
  assert.deepEqual(normalizeFavs(['a', 42, null, {}, [], true, '  ', '', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(normalizeFavs('nope'), [], '非数组一律当空');
  assert.deepEqual(normalizeFavs(null), []);
  assert.deepEqual(normalizeFavs(undefined), []);
  assert.deepEqual(normalizeFavs(0), []);
});

test('FAV-06 🔴 坏JSON 必须当空列表，绝不能抛（老项目 catch 返回 []）', () => {
  const s = memStore({ [FAVS_KEY]: '{not json' });
  assert.deepEqual(readFavs(s), []);
  // 坏数据下 toggle 也必须能工作（先覆盖掉坏值）
  const r = toggleFav(s, 'fresh');
  assert.equal(r.faved, true);
  assert.deepEqual(readFavs(s), ['fresh']);
});

test('FAV-07 🔴🔴 超上限时挤掉最旧的一条，并如实报出被挤掉的名字', () => {
  const s = memStore();
  // 先塞满 FAVS_MAX（不写死数字，用导入的上限）
  for (let i = 0; i < FAVS_MAX; i++) writeFavs(s, [...readFavs(s), `n${i}`]);
  assert.equal(readFavs(s).length, FAVS_MAX);
  const oldest = readFavs(s)[FAVS_MAX - 1];
  const r = toggleFav(s, 'overflow');
  assert.equal(r.faved, true, '新收藏的排第 0，它自己一定进得去');
  assert.equal(r.evicted, oldest, '被挤掉的应是最旧那条（列表末尾）');
  assert.equal(readFavs(s).length, FAVS_MAX, '长度不得超过上限');
  assert.equal(isFav(s, 'overflow'), true);
  assert.equal(isFav(s, oldest), false);
});

test('FAV-08 writeFavs 在**写入前**截断（不是只在读时截）', () => {
  const s = memStore();
  const tooMany = Array.from({ length: FAVS_MAX + 20 }, (_, i) => `x${i}`);
  const wrote = writeFavs(s, tooMany);
  assert.equal(wrote.length, FAVS_MAX);
  // 真正落盘的也只有上限条—— 读时截断的话存储会一直变大
  const onDisk = JSON.parse(s.dump()[FAVS_KEY]);
  assert.equal(onDisk.length, FAVS_MAX);
});

test('FAV-09 favListOf 映射成 MenuState.favList 的形态', () => {
  const s = memStore();
  toggleFav(s, 'a');
  toggleFav(s, 'b');
  assert.deepEqual(favListOf(s), [{ name: 'b' }, { name: 'a' }]);
});

test('FAV-10 🔴🔴 换机合并：备份的排前、本机并入尾部、同名只留一份', () => {
  // 口径来自老项目 backup 合并。反过来（本机在前）会让"刚恢复的收藏"
  // 排在一堆旧收藏后面 —— 刚换完机的人第一眼看不到刚导入的东西。
  const merged = mergeFavs(['bk1', 'shared', 'bk2'], ['shared', 'mine']);
  assert.deepEqual(merged, ['bk1', 'shared', 'bk2', 'mine']);
  // 备份侧不是数组时也不能崩
  assert.deepEqual(mergeFavs('bad', ['a']), ['a']);
  assert.deepEqual(mergeFavs(null, []), []);
});

test('FAV-11 🔴 写入失败（配额满/隐私模式）不得抛，只丢本次持久化', () => {
  // 🔴 注入一个 setItem 必抛的 store（配额满 / 隐私模式）。
  //   不抛就是过；返回值仍要是合法列表（调用方拿它继续渲染）。
  const boom = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  // 不抛就是过；返回值仍要是合法列表（调用方拿它继续渲染）
  const r = toggleFav(boom, 'a');
  assert.deepEqual(r.list, ['a']);
  assert.equal(r.faved, true);
  assert.equal(isFav(boom, 'a'), false, '没落盘就查不到（本机键的真实语义）');
});

test('FAV-12 读到的必须是新副本，改它不能污染存储（防止调用方误改）', () => {
  const s = memStore();
  toggleFav(s, 'a');
  const l1 = readFavs(s);
  l1.push('injected');
  assert.deepEqual(readFavs(s), ['a'], '改返回值不该改到存储');
});
