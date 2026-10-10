/**
 * 「豆包智能整理丢字」判据（SYNC-IME-PUSH 系列）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 用户报障（2026-10-11，带 3 张截图实锤）：
 *   豆包语音说完 → 点「结束」→ 豆包「识别优化中」→ 优化完成，笔记里**只剩最后一段**
 *   （「3. 银吉喜欢吃大闸蟹…」），开头的「帮我记录3件事」与前两件事全丢。
 *   同样的内容在小米自带笔记里**完整**（它没有这条同步—合并链路）。
 *
 * ── 机制（探针实测，不是推断）─────────────────────────────────────────────
 *   「智能整理」= 豆包**整段删除原文、再分批插入**整理稿。删除落地那一刻推上去的
 *   是「空」或「只剩最后一段」的**中间态**。后续 pull 拿它当远端：
 *     base = 上一个完整版 / local = 整理稿 / remote = 中间态
 *     ⇒ 三个 eq 全假 ⇒ 掉进三方合并 ⇒ 实测产出 2~3 条 blocks 冲突
 *     ⇒ setDoc(res.doc) 走 docToLexical（root.clear() + 整篇重建），
 *       正好落在豆包**还在分批插入**的窗口里 ⇒ Android 的 InputConnection
 *       文本视图与真实 DOM 错位 ⇒ 后续 commitText 按**旧偏移**操作 ⇒
 *       前面几段被整段替换（症状：只剩最后一段）。
 *
 * ── 修法（本组判据钉的两条）───────────────────────────────────────────────
 *   ① 远端是**空文档**而本机还有内容 ⇒ 那是"清空"或"删完还没插完"的中间态，
 *      **绝不拿它去动本机**，直接把本机这一版推回去。
 *      （老项目 index.html:9485「合并结果空/变空一律不落地（防误清空）」同口径。）
 *   ② 合并结果与本机**实质一致** ⇒ **绝不回灌**（内容与本机一字不差却把整棵 DOM
 *      推倒重来，就是上面那条打断插入的重建）；但若真有冲突条目，
 *      **必须照旧交用户拍板** —— 静默站本机＝静默覆盖远端，是老项目铁律禁区。
 *
 * ── 本组判据钉什么 ────────────────────────────────────────────────────────
 *   钉**用户可见结果**：服务器**收到几次**、收到的**是哪一版**（解密后逐字比对）、
 *   编辑器**有没有被整篇重建**（setDoc 调用次数）、冲突**有没有被静默吞掉**。
 *
 * 🔴 判据纪律：钉「应有」必配「不应有」—— 除了「本机这一版必须被推出去」，
 *   还必须断言「一次都不许回灌」「冲突不许被吞」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, decryptString, encryptString } from '@bj/shared-schema';
import { SyncClient } from '../src/sync/client.ts';

/**
 * 一次去抖窗口的等待时长。
 *
 * 🔴 必须**大于**实现里的 `PUSH_DEBOUNCE_MS = 700`，且留足余量让异步的
 *   `encryptString` + fetch 跑完（推是异步的，只等 700ms 会读到"还没发出去"）。
 *   不 import 那个常量是因为它没导出 —— 这里用 900 表达「明显越过一个窗口」，
 *   真把去抖改成 800 以上时本组判据会失效，属已知的取样窗口右界，
 *   改动去抖常数时必须同步看这里。
 */
const PUSH_WINDOW_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模拟豆包场景的三个文档形态：
const GREET = { t: 'p', spans: [{ t: '帮我记录3件事' }] }; // 识别原文的开头（丢的那段）
const S1 = { t: 'p', spans: [{ t: '1. 第一件事整理稿' }] }; // 整理稿第 1 段
const S3 = { t: 'p', spans: [{ t: '3. 第三件事整理稿' }] }; // 整理稿最后一段（截图里幸存的那段）
const D_FULL = { v: 1, blocks: [GREET, S1, S3] }; // 识别原文（完整，也是服务器当前版本）
// 🔴 中间态：删完、还没插。**必须写成 canonical 形态**（`{v:1}`，不写空 blocks）——
//   `parseDoc` 只接受 canonical 字节（`canonicalize` 会省略空数组），
//   写成 `{v:1,blocks:[]}` 会被服务端那一侧当成"数据坏"拒收，判据就测不到想去的地方。
const D_MID = { v: 1 };
const D_FINAL = { v: 1, blocks: [S1, S3] }; // 整理完成（最终态）

async function setup(imeRef, opts = {}) {
  const noteId = 'note-ime-push';
  const dk = await deriveKey('pw');
  const remote = opts.remote ?? D_FULL; // 服务器当前那一版
  const base = opts.base ?? D_FULL; // 上次同步成功的那一版（initialDoc）
  const local0 = opts.local ?? D_FULL; // 编辑器（真源）初始形态
  const remoteEnvelope = await encryptString(JSON.stringify(remote), dk.key, 'note', dk);

  let currentDoc = local0; // 真源（getDoc 读它、豆包的"删/插"改它）
  const posts = []; // 服务器实际收到的每一次 POST
  const setDocs = []; // 每一次回灌（setDoc）—— 04 要断言"一次都不许有"

  const deps = {
    noteId,
    key: dk.key,
    dk,
    initialDoc: base,
    getDoc: () => currentDoc,
    setDoc: (d) => setDocs.push(d),
    onSnapshot: () => {},
    onError: (m) => {
      if (opts.onError) opts.onError(m);
    },
    isOnline: () => true, // Node 22 全局 navigator 无 onLine，必须显式注入
    imeCanEditTree: () => imeRef(),
  };

  const restore = installGlobals();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/note/') && !u.includes('/claim')) {
      if (init?.method === 'POST') {
        posts.push(String(init.body ?? ''));
        return { ok: true, status: 200, text: async () => '{}' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(remoteEnvelope) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  return {
    c: new SyncClient(deps),
    posts,
    dk,
    setDocs,
    /** 豆包改真源（删 / 插） */
    setSource: (d) => {
      currentDoc = d;
    },
    restore,
  };
}

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
    addEventListener() {}
    close() {}
  };
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

/** 把捕获到的每一次 POST 解成明文（服务器真正收到的那一版）。 */
async function plainOfPosts(posts, dk) {
  const out = [];
  for (const body of posts) {
    out.push(await decryptString(JSON.parse(body), dk.key, 'note'));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// ① 远端停在「空」中间态（豆包删完还没插）
// ════════════════════════════════════════════════════════════════════════════

test('SYNC-IME-PUSH-01 🔴🔴🔴 远端是空中间态：不许回灌、不许弹冲突，直接把本机整理稿推回去', async () => {
  const errs = [];
  const ime = () => true; // 已停笔（这里测的不是门控，是"远端那版是空的"怎么处置）
  const { c, posts, dk, setDocs, restore } = await setup(ime, {
    base: D_FULL, // 上次同步成功的完整识别原文
    remote: D_MID, // 服务器停在"删完还没插完"的空中间态
    local: D_FINAL, // 本机：整理稿已插完
    onError: (m) => errs.push(m),
  });
  try {
    await c.start(); // 首拉即撞上"远端是空的"

    assert.equal(
      setDocs.length,
      0,
      '🔴 一次都不许回灌：setDoc → docToLexical 是 root.clear() + 整篇重建，' +
        '落在输入法还在分批插入的窗口里就按旧偏移整段替换（用户丢字的直接病灶）',
    );
    assert.deepEqual(errs, [], `不该弹冲突条：本机内容好好的，只是服务器那版是空的：${JSON.stringify(errs)}`);
    assert.equal(c.getConflicts().length, 0, '不该留下待裁决的冲突（没有"保留哪一份"可挑）');
    assert.equal(posts.length, 1, '必须把本机这一版推回去（否则服务器永远停在空的那版）');

    const [plain] = await plainOfPosts(posts, dk);
    assert.ok(plain.includes('1. 第一件事整理稿'), `推回去的必须是本机整理稿（含第 1 段）：${plain}`);
    assert.ok(plain.includes('3. 第三件事整理稿'), `推回去的必须是本机整理稿（含第 3 段）：${plain}`);
    assert.notEqual(plain.replace(/\s/g, ''), '{"v":1}', `推回去的绝不能是空的那一版：${plain}`);
  } finally {
    c.stop();
    restore();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ② 远端非空、却是"删掉了一部分"的中间态 ⇒ 真冲突，但不许白重建
// ════════════════════════════════════════════════════════════════════════════

test('SYNC-IME-PUSH-02 🔴🔴 合并结果与本机逐字相同：不许回灌（白重建），但冲突必须交用户拍板', async () => {
  const errs = [];
  const ime = () => true; // 已停笔：冲突要能弹出来
  // 远端只插到最后一件事（豆包分批插入的另一种中间态），本机已插完
  const D_PARTIAL = { v: 1, blocks: [S3] };
  const { c, posts, setDocs, restore } = await setup(ime, {
    base: D_FULL,
    remote: D_PARTIAL,
    local: D_FINAL,
    onError: (m) => errs.push(m),
  });
  try {
    await c.start();

    assert.equal(
      setDocs.length,
      0,
      '🔴 合并结果与本机逐字相同时**绝对不许回灌**：内容一字不差却把整棵 DOM 推倒重来，' +
        '那次重建正是打断输入法分批插入的元凶',
    );
    // 🔴 "不应有"的另一半：不许因为"结果等于本机"就把冲突也吞掉 ——
    //   静默站本机＝静默覆盖远端，是老项目铁律禁区。
    assert.ok(c.getConflicts().length > 0, '双方真的改了同一处 ⇒ 冲突必须留给用户拍板（不许静默站本机）');
    assert.ok(
      errs.some((m) => m.includes('需要你选保留哪一份')),
      `冲突必须**可见**（不许静默）：${JSON.stringify(errs)}`,
    );
    assert.equal(c.getState(), 'conflict', '必须停在 conflict 等用户拍板，不许自己收口成已同步');
    assert.equal(posts.length, 0, '未拍板前不许把任何一方当成权威写回服务器');
  } finally {
    c.stop();
    restore();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 非空洞对照：去抖到点**确实会推**（证明 01 的 posts=1 不是白捡的）
// ════════════════════════════════════════════════════════════════════════════

test('SYNC-IME-PUSH-03 非空洞对照：noteEdit 去抖到点确实会推一次（中间态也会推）', async () => {
  const ime = () => true;
  const { c, posts, dk, setSource, restore } = await setup(ime);
  try {
    await c.start();
    assert.equal(posts.length, 0, '前置：启动阶段不该有 push');

    setSource(D_MID); // 真源变成空中间态
    c.noteEdit();
    await sleep(PUSH_WINDOW_MS);

    assert.equal(posts.length, 1, '去抖到点就该推一次（这条证明 01 里的"收到 1 次"确实是被断言逼出来的）');
    const [plain] = await plainOfPosts(posts, dk);
    assert.equal(plain.replace(/\s/g, ''), '{"v":1}', `推上去的正是中间态空文档：${plain}`);
  } finally {
    c.stop();
    restore();
  }
});

