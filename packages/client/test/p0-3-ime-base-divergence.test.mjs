/**
 * P0-3 回归测试：「IME 组字中，base 推进与编辑器回灌必须同进同退」
 *
 * 🔴🔴 病状（用户报障第 1 条的另一面）：旧实现里 `main.ts` 的 `setDoc` 在 IME 组字中
 *   裸 return 不回灌，但 `client.ts` 的 `decryptAndMerge` 仍把 `this.base` 推进成远端 ⇒
 *   base（上次同步成功的版本）与编辑器（仍是旧内容）悄悄分叉 ⇒ 后续三方合并把
 *   「用户在远端删掉、本机还在显示」的内容当成「本地新增」复活（复活的删除）。
 *
 * 🔴🔴 判据设计（不抄第二份实现，只钉用户可见结果）：
 *   构造「base == 本地 == D_base（含 A、B 两块），远端 == D_remote（只含 A，B 被删）」。
 *   ① 组字期（imeCanApply()==false）先拉一次：必须**既不回灌、也不推进 base**；
 *      —— 复刻 main.ts 的 IME 门控：setDoc 桩在 ime 关时**同样不落盘**（只记录 ime 开时的回灌）。
 *   ② 组字结束后（imeCanApply()==true）再拉一次：必须**把 D_remote 原样回灌**，
 *      即「被删的 B 不复活」。
 *   旧实现下，第①步会把 base 推进成 D_remote（setDoc 桩静默丢弃），第②步走
 *   `eq(remoteDoc, base)` 顶层分支只 push 本地、**根本不回灌** ⇒ applied 永远为空、
 *   且 B 在编辑器里被保留 ⇒ 判据「applied 恰好 1 次且不含 beta」会红。
 *
 * 🔴 判据纪律：必须同时断言「不该变的没变」—— 这里就是「被删的 B 不许回来」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey } from '@bj/shared-schema';
import { SyncClient } from '../src/sync/client.ts';

// ───────── 被测文档 ─────────
// A 始终存在；B 是「远端被删、本机还在显示」的那一块（复活的对象）。
const A = { t: 'p', spans: [{ t: 'alpha' }] };
const B = { t: 'p', spans: [{ t: 'beta' }] };
const D_base = { v: 1, blocks: [A, B] };
const D_remote = { v: 1, blocks: [A] }; // B 在远端被删

// 把文档序列化成「服务端信封里那份明文」并加密（与 client.ts 解密同密钥）。
async function makeEnvelope(dk, doc) {
  const { encryptString } = await import('@bj/shared-schema');
  return encryptString(JSON.stringify(doc), dk.key, 'note', dk);
}

// ───────── 单个场景的装配 ─────────
async function setup(imeRef) {
  const noteId = 'note-p0-3';
  const dk = await deriveKey('pw');
  const envelope = await makeEnvelope(dk, D_remote);

  // 当前真源（被 getDoc 读、被 setDoc 写）。初始 == D_base（与 base 一致）。
  let currentDoc = D_base;
  const applied = []; // 只在 ime 开时落盘（复刻 main.ts 的 IME 门控）

  // 复刻 main.ts 的 setDoc 守卫：组字中裸 return 不回灌（与线上同口径，才能复现旧分歧）。
  const deps = {
    noteId,
    key: dk.key,
    dk,
    initialDoc: D_base,
    getDoc: () => currentDoc,
    setDoc: (d) => {
      if (imeRef()) {
        applied.push(d);
        currentDoc = d;
      }
    },
    onSnapshot: () => {},
    onError: () => {},
    // 🔴 Node 22 有全局 navigator 但没有 onLine 字段 ⇒ online() 返回 undefined ⇒
    //   pullInner 会在入口判 offline 早退、根本进不了 decryptAndMerge（两条用例全红的根因）。
    //   用 SyncDeps 预留的测试注入口，不碰全局。
    isOnline: () => true,
    imeCanApply: () => imeRef(),
  };

  return { c: new SyncClient(deps), envelope, applied, dk, noteId };
}

// 全局桩：浏览器 API 在 Node 下不存在，按需打桩；每个用例自己还原。
function installGlobals() {
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realLocalStorage = globalThis.localStorage;

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.EventSource = class {
    constructor() {}
    addEventListener() {}
    close() {}
  };
  // 不真正排程轮询；把回调抓出来只用于证明它没被自动触发（我们手动 pull）。
  globalThis.setInterval = () => ({ unref() {} });
  globalThis.clearInterval = () => {};

  return function restore() {
    globalThis.fetch = realFetch;
    globalThis.EventSource = realEventSource;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.localStorage = realLocalStorage;
  };
}

// 让 fetch 桩在给定 envelope 下返回远端信封（note GET），其余（claim）一律 ok。
function fetchStub(envelope) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/note/') && !u.includes('/claim')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(envelope) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
}

function docHasBeta(d) {
  return JSON.stringify(d).includes('beta');
}
function docHasAlpha(d) {
  return JSON.stringify(d).includes('alpha');
}

test('P0-3 正向对照：IME 全程放行 ⇒ 首次 pull 即把 D_remote（删 B）原样回灌', async (t) => {
  const restore = installGlobals();
  const ime = () => true; // 全程放行
  try {
    const { c, envelope, applied } = await setup(ime);
    fetchStub(envelope);
    await c.start(); // 首次 pull 跑完
    c.stop();

    assert.equal(applied.length, 1, '应当恰好回灌 1 次远程版本');
    assert.ok(docHasAlpha(applied[0]), '回灌结果必须保留 A');
    assert.ok(!docHasBeta(applied[0]), '回灌结果不得复活被删的 B（P0-3 核心断言）');
  } finally {
    restore();
  }
});

test('P0-3 核心：IME 组字中 pull 不回灌也不推进 base；组字结束后才正确回灌（B 不复活）', async (t) => {
  const restore = installGlobals();
  let imeOn = false; // 第一阶段：组字中
  const ime = () => imeOn;
  try {
    const { c, envelope, applied } = await setup(ime);
    fetchStub(envelope);

    // ① 组字期先拉一次：IME 关 ⇒ 必须既不回灌、也不推进 base。
    await c.start();
    assert.equal(applied.length, 0, '组字期不得回灌（main.ts 门控 + client.ts 同进同退）');

    // ② 组字结束后再拉一次：IME 开 ⇒ 必须原样回灌 D_remote。
    imeOn = true;
    await c.pull('syncing'); // 直接驱动一次确定性 pull（state 仍为 syncing）
    c.stop();

    assert.equal(applied.length, 1, '组字结束后应恰好回灌 1 次');
    assert.ok(docHasAlpha(applied[0]), '回灌结果必须保留 A');
    assert.ok(!docHasBeta(applied[0]), '组字结束后的回灌不得复活被删的 B（P0-3 核心断言）');
  } finally {
    restore();
  }
});
