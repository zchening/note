/**
 * 「打字被吞」与「冲突静默吞推送」判据（SYNC-IME / SYNC-BASE / SYNC-POLL 系列）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本文件钉的是**用户报障第 7 条与第 1 条**：
 *   第 7 条：「经常打字的时候结果换行或者正在打的字被吞掉」
 *   第 1 条：「不管怎么刷新都没法取到包含这两行内容，而且经常出现多端同步冲突的弹窗提醒」
 *
 * ── 病根（不是"同步"，是"回灌"）─────────────────────────────────────────
 *   bj 有三条把远端内容整篇写回编辑器的路径，**都没有 IME 门控**：
 *     ① SyncDeps.setDoc → docToLexical（合并/采纳远端后）
 *     ② Lexical registerUpdateListener → 提醒对账后整篇重写
 *     ③ 提醒面板 setDoc 后的回灌
 *   而 `docToLexical` 是 `root.clear()` + 整篇重建 ——
 *   在**输入法正在组字**时执行，等于把未上屏的拼音串与已提交文本对调。
 *
 * ── 第 1 条的两个独立病灶（必须分开判，症状相同、成因完全不同）────────────
 *   A. base 初值是 emptyDoc()，解锁后**从未**用刚解出的 doc 初始化
 *      ⇒ 每次开篇都被判"本地和 base 不同、远端和 base 不同" ⇒ 三方合并必冲突。
 *      老项目 index.html:3450 在解锁时就把 lastHtml 设成服务端内容。
 *   B. conflict 态下 `noteEdit()` 的 `this.send('edit')` 抛异常，被
 *      `client.ts:143-157` 捕获后只 `console.warn` ⇒ **用户零感知**，
 *      而 `setTimeout` 里 `if (this.state === 'dirty')` 恒不成立 ⇒ 推送永不执行。
 *      用户拍板：**只修「推不上去」，不改可编辑性**
 *      （保持 fsm 的 conflict→edit 无边，不动 serialize.test.mjs:680）。
 *
 * ── 判据纪律 ───────────────────────────────────────────────────────────────
 *   · 时间相关判据**必须注入时钟**（now 参数）。用真实 Date.now() 的判据
 *     要么恒绿要么恒红 —— 时间判据的经典陷阱。
 *   · 每条「应该有」配一条「不应该有」
 *   · 判据必须 import 生产代码，绝不把实现抄进测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createImeGate, TYPE_ACTIVE_MS } from '../src/sync/ime-gate.ts';
import { SyncClient, POLL_INTERVAL_MS, fetchTextWithTimeout } from '../src/sync/client.ts';
import { canonicalize, deriveKey, emptyDoc, encryptString } from '@bj/shared-schema';
import { readFileSync } from 'node:fs';

const fs_read = (u) => readFileSync(u, 'utf8');

/* 三份两两不同的文档，用来真造出三方冲突（见 SYNC-PUSH-01） */
const BASE = { v: 1, blocks: [{ t: 'p', spans: [{ t: '同一起点' }] }] };
const LOCAL = { v: 1, blocks: [{ t: 'p', spans: [{ t: '本机改过了' }] }] };
const REMOTE = { v: 1, blocks: [{ t: 'p', spans: [{ t: '远端也改过' }] }] };

/* ------------------------------------------------------------------ *
 * 一份最小 SyncDeps（真跑 SyncClient，不用替身）
 * ------------------------------------------------------------------ */

function harness(over = {}) {
  const calls = { setDoc: [], error: [], internal: [] };
  let doc = over.doc ?? emptyDoc();
  const deps = {
    noteId: 'n1',
    key: null,
    dk: null,
    getDoc: () => doc,
    setDoc: (d) => {
      calls.setDoc.push(d);
      doc = d;
    },
    push: async () => 'ok',
    pull: async () => undefined,
    onSnapshot: () => undefined,
    onError: (m) => calls.error.push(m),
    onInternalError: (m, e) => calls.internal.push(m),
    isOnline: () => true,
    ...over.deps,
  };
  return { calls, deps, getDoc: () => doc };
}

/* ------------------------------------------------------------------ *
 * SYNC-IME：IME 门控
 * ------------------------------------------------------------------ */

test('SYNC-IME-01 组字中禁止回灌，组字结束后放行', () => {
  let t = 1000;
  const gate = createImeGate(() => t);

  // 「应该有」：空闲态可回灌
  assert.equal(gate.canApply(), true, '空闲时应可回灌');

  // 组字中 ⇒ 必须禁止
  gate.setComposing(true);
  assert.equal(gate.composing, true);
  assert.equal(gate.canApply(), false, '🔴 组字中绝不许回灌（吞字/吞回车的直接原因）');

  // 组字结束 ⇒ 立刻恢复可回灌（compositionend 会刷新活跃期）
  // 🔴 注：这里走的是**手动 setComposing(false)** 降级路径，不触发冷却。
  //   真实 compositionend 事件会额外进入 4s 冷却期（覆盖语音句间停顿），
  //   见 sync-ime-voice.test.mjs 的 SYNC-IME-VOICE-01。两者不矛盾：
  //   降级场景本就没有 composition 事件，"刚组完字"无从判断。
  gate.setComposing(false);
  assert.equal(gate.canApply(), true, '组字结束应立即放行');
  t += 100;
  assert.equal(gate.canApply(), true);
});

test('SYNC-IME-02 打字活跃期内禁止回灌，超过 1.5s 放行', () => {
  let t = 10000;
  const gate = createImeGate(() => t);
  gate.noteInput();

  // 「应该有」：刚打完字还在活跃期
  assert.equal(gate.typingActive, true, '刚输入应为打字活跃期');
  assert.equal(gate.canApply(), false, '🔴 打字活跃期不许回灌（老项目 1.5s 静默推迟）');

  // 活跃期内移动 ⇒ 仍禁止
  t += TYPE_ACTIVE_MS - 100;
  assert.equal(gate.canApply(), false, '活跃期内任何时刻都禁止');

  // 超过活跃期 ⇒ 放行
  t += 200;
  assert.equal(gate.typingActive, false, '超时应离开活跃期');
  assert.equal(gate.canApply(), true, '超时后必须放行，否则远端永远进不来');
});

test('SYNC-IME-03 🔴 组字态优先于活跃期，两者独立', () => {
  let t = 5000;
  const gate = createImeGate(() => t);
  // 「不应该有」：不能因为"活跃期恰好过了"就在组字中放行。
  // 这条是变异设计的靶心：把 canApply 写成只判 typingActive 的话，
  // 下面这条会在 typingActive 为 false 时**错误放行**。
  t += TYPE_ACTIVE_MS + 1000;
  gate.setComposing(true);
  assert.equal(gate.canApply(), false, '组字中必须独立拦住（哪怕活跃期已过）');

  // 反向：活跃期内但没组字 ⇒ 也必须拦（另一条独立的闸）
  gate.setComposing(false);
  gate.noteInput();
  assert.equal(gate.canApply(), false, '活跃期内即使没组字也要拦');
});

test('SYNC-IME-04 attach 真的挂上四个事件，且解绑后不再拦', () => {
  const t = 1000;
  const gate = createImeGate(() => t);
  const seen = [];
  const host = {
    addEventListener: (k, f, o) => seen.push(['add', k, f, o]),
    removeEventListener: (k, f, o) => seen.push(['remove', k, f, o]),
  };

  const off = gate.attach(host);
  const adds = seen.filter((x) => x[0] === 'add').map((x) => x[1]);
  // 「应该有」：三条事件全挂上
  // 🔴🔴 compositionstart / compositionend / blur 缺一不可 ——
  //   漏 blur 的症状是"点走后组字卡住、整篇再也回灌不了"（老项目 index.html:1000 有）。
  for (const k of ['compositionstart', 'compositionend', 'blur', 'input']) {
    assert.ok(adds.includes(k), '必须挂 ' + k);
  }

  // 🔴🔴 **blur 必须用 capture**：Lexical 的 blur 是冒泡到宿主的，
  //   而组字被打断时 target 可能已不在 host 内 ⇒ 不加 capture 会漏收。
  const blurEntry = seen.find((x) => x[0] === 'add' && x[1] === 'blur');
  assert.equal(blurEntry[3], true, '🔴 blur 必须 capture，否则点走时组字复位收不到');

  // 解绑后不该再拦（mountEditor 换笔记时必须调 off，否则状态跨挂载残留）
  off();
  const removes = seen.filter((x) => x[0] === 'remove').map((x) => x[1]);
  assert.equal(removes.length, 4, '解绑必须撤掉全部四条监听');
  assert.deepEqual(removes.sort(), adds.slice().sort(), '解绑的必须是挂上去的那四条');
});

test('SYNC-IME-05 门控按挂载实例独立，跨挂载不残留', () => {
  // 🔴🔴 这是「不能简化成模块级布尔」的钉子：
  //   bj 是多页 SPA，会反复 mountEditor。模块级单例在换笔记时残留 true
  //   ⇒ 新编辑器永远不回灌 ⇒ 症状"同步功能坏了"，而本机一切正常。
  let t = 1000;
  const g1 = createImeGate(() => t);
  g1.setComposing(true);

  // 新挂载实例必须是干净的（不是同一个标志）
  const g2 = createImeGate(() => t);
  assert.equal(g2.composing, false, '🔴 新挂载实例必须干净（组字态不跨编辑器）');
  assert.equal(g2.canApply(), true, '新实例必须能回灌，否则等于同步坏掉');
});

test('SYNC-IME-06 三条回灌路径都必须过门控（接线）', async () => {
  const fs = await import('node:fs/promises');
  const main = await fs.readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

  // 🔴 反向闸：main.ts 里不许出现**绕过门控**的回灌。
  //   docToLexical 的调用点若全都在门控内，是对的；
  //   这里钉的是「门控必须真的接进 mountEditor 并被解绑」，
  //   以及「不得引入第二套并行的 IME 标志」（那正是老项目单例在本仓会炸的原因）。
  assert.match(main, /createImeGate\(/, 'mountEditor 必须建门控');
  assert.match(main, /\.attach\(/, '门控必须真的 attach 到宿主');
  assert.match(main, /imeGate\w*\.canApply\(\)/, '回灌前必须判 canApply');
  // 不许在 main.ts 里另开一个模块级 isComposing（跨挂载残留的老坑）
  assert.doesNotMatch(main, /^let isComposing/m, '不许模块级 isComposing（跨挂载残留）');
});

/* ------------------------------------------------------------------ *
 * SYNC-BASE：base 初值（第 1 条病灶 A）
 * ------------------------------------------------------------------ */

test('SYNC-BASE-01 SyncDeps 有 initialDoc，且 start 后 base 用它初始化', async () => {
  // 🔴 判据形状说明：这里**不**跑真实网络（那属于 e2e 层），
  //   判的是「SyncDeps 提供 initialDoc 且 client 把它当 base 起点」这一契约。
  //   承重点在**反向闸**：没有 initialDoc 时必须红。
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/sync/client.ts', import.meta.url), 'utf8');

  assert.match(src, /initialDoc\??:\s*Doc/, 'SyncDeps 必须有可选的 initialDoc 字段');
  assert.match(src, /this\.base\s*=\s*deps\.initialDoc|this\.base\s*=\s*initialDoc/,
    'base 必须由 initialDoc 初始化（否则首篇必冲突）');
});

test('SYNC-BASE-02 没有 initialDoc 时退回 emptyDoc，不报错', async () => {
  const h = harness();
  const c = new SyncClient(h.deps);
  // 不调 start（避免真 fetch），只验证构造不炸
  assert.ok(c, '构造必须容许 initialDoc 缺省');
  assert.equal(c.getState(), 'locked', '初始态必须是 locked');
  c.stop();
});

/* ------------------------------------------------------------------ *
 * SYNC-PUSH：conflict 态推得上去（第 1 条病灶 B）
 * ------------------------------------------------------------------ */

test('SYNC-PUSH-01 🔴 conflict 态下用户编辑仍能推上去（不静默丢）', async () => {
  // 🔴 用户拍板：只修「推不上去」，不改可编辑性。
  //   ⇒ **不**断言 conflict→edit 的 FSM 边被放开；
  //   断言的是「conflict 态下的编辑有出路」—— 推送请求必须真的发出。
  //
  // 🔴🔴 这条第一版写成 `assert.ok(pushed >= 0)`，是**恒真断言**（本项目最忌）。
  //
  // 🔴🔴🔴 第二版数错了对象：把 `deps.push` 当推送计数。
  //   但 `noteEdit` → 内部 `private push()` → `fetch(PUT)`，**根本不走 deps.push**
  //   （deps.push 是给测试用的"推送结果"回调，不是推送通道本身）。
  //   于是计数恒为 0，而实现其实是对的 —— 这就是"数错对象 ⇒ 判据恒红"。
  //   正确口径：**数真正的网络写请求**（method === 'PUT'）。
  const dk = await deriveKey('口令');
  let writes = 0;
  let gets = 0;
  globalThis.fetch = async (_url, init) => {
    // 🔴 推送走的是 **POST** /api/note/...（client.ts push 里的 method:'POST'），
    //   不是 PUT —— 第三版数 PUT 恒为 0，又一次"数错对象"。
    if (init && (init.method === 'POST' || init.method === 'PUT')) {
      writes++;
      return new Response('', { status: 200 });
    }
    gets++;
    return new Response(JSON.stringify(await encryptString(canonicalize(REMOTE), dk.key, 'note', dk)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const h = harness();
  const c = new SyncClient({
    ...h.deps,
    key: dk.key,
    dk,
    getDoc: () => LOCAL,
    setDoc: () => undefined,
    initialDoc: BASE,
  });
  await c.start();
  // 🔴 `start()` 的 await 不保证下游 continuation 跑完（解密/合并是 WebCrypto 真异步），
  //   必须轮询等状态落到 conflict，不能只 await 一次。
  for (let i = 0; i < 50 && c.getState() !== 'conflict'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(c.getState(), 'conflict', 'sanity：应真进 conflict 态（否则这条判据测不到东西）');

  const before = writes;
  c.noteEdit();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(writes > before,
    '\uD83D\uDD34 conflict 态下编辑必须仍推得上去（不许静默吞）；实得写请求 ' + (writes - before) + ' 次');

  // 🔴🔴 反向闸：修法不许是"放开 conflict→edit 边"（用户拍板不改可编辑性）。
  //   放开那条边会让用户没拍板就改文档，比推不上去更糟。
  const fsm = fs_read(new URL('../src/sync/fsm.ts', import.meta.url));
  const conflictCase = fsm.slice(fsm.indexOf("case 'conflict':"));
  assert.doesNotMatch(conflictCase.slice(0, 400), /'edit'/,
    '\uD83D\uDD34 不许给 conflict 态加 edit 边（用户拍板：只修推不上去，不改可编辑性）');

  c.stop();
});

test('SYNC-PUSH-02 🔴 conflict 态不再静默吞推送：必须走 resolve 或报错，不能零感知', async () => {
  const fs = await import('node:fs/promises');
  // 🔴 去注释再匹配：noteEdit 的注释里就写着 'conflict'，留着注释则删掉真守卫也照样命中 ⇒ 恒绿。
  const src = (await fs.readFile(new URL('../src/sync/client.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const seg = src.slice(src.indexOf('noteEdit(): void'), src.indexOf('noteEdit(): void') + 1200);

  // 🔴 承重：noteEdit 里必须显式处理 conflict 态。
  //   病态是 `this.send('edit')` 抛 → 被 catch → 只 console.warn → 用户零感知。
  assert.match(seg, /conflict/, 'noteEdit 必须显式处理 conflict 态（不能靠抛异常被吞）');
  // 反向闸：不许只剩 console.warn 那种黑洞式处理
  assert.doesNotMatch(seg, /reportInternal\([^)]*非法转移/, 'noteEdit 不能只把 conflict 当非法转移上报');
});

/* ------------------------------------------------------------------ *
 * SYNC-POLL：轮询（第 1 条"刷新也取不到"的兜底）
 * ------------------------------------------------------------------ */

test('SYNC-POLL-01 有 2 秒轮询，且 conflict/推送中不重拉', async () => {
  const fs = await import('node:fs/promises');
  // 🔴🔴 必须**去注释**再匹配：pull 函数体里的注释就写着 'conflict' / 'pushing' / 'syncing'
  //   （讲"为什么要有这些守卫"），留着注释的话，把真正的守卫删掉、正则照样命中 ⇒ **恒绿**
  //   （本项目栽过的那类坑：断言"某段代码存在/不存在"，输入必须去注释后的代码）。
  const src = (await fs.readFile(new URL('../src/sync/client.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  assert.match(src, /POLL_INTERVAL_MS\s*=\s*2_?000/, '必须有 2 秒轮询基线（老项目 POLL_INTERVAL=2000）');

  // 🔴 两条硬守卫（缺任一条，轮询上线后就会变成故障放大器）：
  //   conflict 态重拉 ⇒ 每 2 秒抛 IllegalTransitionError
  //   pushing/syncing 中重拉 ⇒ 推拉震荡
  // 🔴🔴🔴 采样窗口本身就是 bug 的藏身处（本项目栽过两次）：
  //   第一版这里切 `indexOf(...) + 600`，而守卫前面那段注释有 20 多行，
  //   600 字符只够读到函数签名 —— 三条守卫全在窗口之外，
  //   判据于是**恒红**（把"注释写长了"误报成"没实现"）。
  //   ⇒ 窗口必须覆盖**整个函数体**，判据里因此不写魔法数字。
  const pullAt = src.indexOf('private async pull(');
  const pullEnd = src.indexOf('private async decryptAndMerge(');
  assert.ok(pullAt >= 0 && pullEnd > pullAt, '应能定位 pull 函数体');
  const pullSeg = src.slice(pullAt, pullEnd);
  assert.match(pullSeg, /'conflict'/, 'pull 必须有 conflict 守卫（否则每 2 秒抛异常）');
  assert.match(pullSeg, /'pushing'|'syncing'/, 'pull 必须有 pushing/syncing 守卫（否则推拉震荡）');

  // stop() 必须清掉定时器（不清 ⇒ 换笔记后旧实例仍在轮询）
  const stopAt = src.indexOf('stop(): void');
  const stopEnd = src.indexOf('private online()');
  assert.ok(stopAt >= 0 && stopEnd > stopAt, '应能定位 stop 函数体');
  const stopSeg = src.slice(stopAt, stopEnd);
  assert.match(stopSeg, /clearInterval/, 'stop() 必须 clearInterval');
});

test('SYNC-POLL-02 轮询基线真会打网络，且 stop 之后立刻不再打', async () => {
  // 🔴🔴🔴 这一条重写过三次。前两版都是**恒真断言**，等于没有断言：
  //
  //   第一版：`c = new SyncClient(deps); c.stop(); 等 100ms; assert(pulls === 0)`
  //     —— 它**从来没调过 start()**，轮询压根没启动过，pulls 必然是 0。
  //     把 start() 删掉它照样绿。而当时真正被它"覆盖"的 bug 恰恰是
  //     「stop 之后旧实例仍在每 2 秒拉」（换笔记后流量翻倍）。
  //
  //   第二版：给 SyncDeps 塞 `pull: async () => { pulls++ }` 想数调用次数——
  //     那是**替身回调**，而生产代码的 poll 走的是 `this.pull()` 私有方法，
  //     根本不经过 deps.pull ⇒ 计数恒 0，又是恒绿。
  //     （同一个坑本轮在 SYNC-PUSH-01 上又踩了一次：数 deps.push 回调，
  //       而 noteEdit 走的是内部 private push() → fetch(POST)。）
  //
  //   ⇒ 教训：**要数通道，数真正的通道**（这里是 fetch），不是替身。
  const gets = [];
  const DK = await deriveKey('pw');
  // 🔴 直接接管 globalThis.fetch 数真正的网络通道（不数 deps 里的替身回调，
  //   理由见上方那段"要数通道，数真正的通道"）。
  const saved = globalThis.fetch;
  const emptyEnv = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  globalThis.fetch = async (url, init) => {
    gets.push((init && init.method) || 'GET');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(emptyEnv),
      json: async () => emptyEnv,
    };
  };

  const hh = harness({
    doc: BASE,
    deps: { key: DK.key, dk: DK, noteId: 'poll-probe' },
  });
  const c = new SyncClient(hh.deps);
  try {
    await c.start();
    const afterStart = gets.length;
    assert.ok(afterStart >= 1, `start() 应至少拉一次（前置：轮询根本没起来）实际 ${afterStart}`);

    // 等过一个完整轮询周期 ⇒ 轮询必须自己又打了
    // 🔴 用导出的 POLL_INTERVAL_MS 而不是写死 2000：数字写两份就会漂。
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    const afterPoll = gets.length;
    assert.ok(
      afterPoll > afterStart,
      `过了 ${POLL_INTERVAL_MS}ms 轮询必须自己打一次（SSE 全挂时它是唯一兜底），实际 ${afterStart} → ${afterPoll}`,
    );

    c.stop();
    const atStop = gets.length;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(
      gets.length,
      atStop,
      '🔴 stop 后不得再有任何网络请求（换笔记后旧实例仍每 2 秒拉 ⇒ 流量翻倍、底栏同步时间乱跳）',
    );
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-POLL-03 定时器发起的拉必须自带错误边界（不许让异常逃成未捕获）', async () => {
  // 🔴🔴🔴 病态由探针 probe8 实锤：`setInterval` 回调里 `void this.pull()`，
  //   而 pull 的下游（res.status）一旦抛错，rejected promise 从回调里逃出去
  //   = **未捕获异常**：浏览器里变 unhandledrejection，Node/单测里直接终止进程。
  //   症状是"同步毫无征兆地死了"——不弹提示、不进底栏状态，且每 2 秒复发一次。
  //
  //   老项目口径：`poll()` 整个函数体包在 try 里（index.html:9933），
  //   catch 分三类报状态（:10026-10030）—— 明确规定轮询里的问题只降级、不逃逸。
  //
  // 🔴 本判据用的是**变异**而不是源码形状：让 fetch 返回一个 undefined 响应
  //   （模拟任何未预料的形态），若没有 catch，进程会被打死/用例会红。
  //   形状断言（grep `.catch(`）在这条上是恒真的 —— `pull()` 自己内部就有
  //   无数 `.catch`，grep 命中任何一个都算通过，压根不知道是不是定时器那条。
  const DK = await deriveKey('pw');
  const h = harness({ doc: BASE, deps: { key: DK.key, dk: DK, noteId: 'poll-throw' } });
  const saved = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    // 第一次给正常空体，之后给 undefined —— 复刻 probe8 的越界形态
    if (n === 1) return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    return undefined;
  };
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    // 熬过一个完整轮询周期：这一轮 pull 一定会在 res.status 上炸
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    // 「不应该有」：异常不许进用户可见通道（底栏文案是白名单，见 FSM-xxxx 文件头）
    assert.deepEqual(
      h.calls.error.filter((m) => /status|undefined|Cannot read/.test(m)),
      [],
      '内部异常绝不许进 onError（会被 main.ts 当用户文案推到底栏）',
    );
    // 也不许打死进程：能走到这一行本身就是断言
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-POLL-04 从状态机事件发起的那次拉必须放行（不许被守卫自己挡死）', async () => {
  // 🔴🔴🔴 这是本轮真实踩中的 bug（探针 probe7 实锤），判据当时**尚未覆盖**。
  //
  //   `pull()` 的守卫是「conflict/pushing/syncing 时不许拉」，配套
  //   `fromStateEntry` 参数表达"这次拉是我自己发起的"。
  //   而 SSE 回调写的是 `send('remote-arrived'); void this.pull();`
  //   —— **没传 fromStateEntry** ⇒ send 刚把状态推进 syncing，
  //   守卫反过来把 SSE 自己发起的拉挡死。
  //   症状：收得到推送、底栏显示 syncing、但一个 GET 都不发，1200ms 后卡在 syncing。
  //   用户看到的是"同步偶尔不更新"，**没有任何报错**。
  //
  //   这个 bug 与早先的 probe1（`start()` 第一次拉被自己挡死）**同一个根因**，
  //   而上一轮只改了 startPoll 一处、漏了 SSE 这处 ⇒
  //   **凡新增 pull() 调用点，必须逐个核对自己是不是刚刚 send 过状态机事件。**
  //
  // 判据形状：走真 openStream → 真 SSE onmessage → 数 fetch 里有没有 GET#2。
  //   不用 grep 源码（grep 只会验证"传了这个字面量"，验不出守卫是否真的放行）。
  const DK = await deriveKey('pw');
  const saved = globalThis.fetch;
  const gets = [];
  const first = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const second = await encryptString(canonicalize(REMOTE), DK.key, 'note', DK);
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    gets.push(m);
    if (m === 'POST') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    n += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(n === 1 ? first : second), json: async () => ({}) };
  };

  // 🔴 必须垫 EventSource，否则 openStream() 第一句就 return，整条 SSE 分支不执行
  const INSTANCES = [];
  const savedES = globalThis.EventSource;
  globalThis.EventSource = class {
    constructor(url) { this.url = url; INSTANCES.push(this); }
    close() { this.closed = true; }
  };

  const h = harness({ doc: BASE, deps: { key: DK.key, dk: DK, noteId: 'sse-probe' } });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    assert.equal(gets.filter((m) => m === 'GET').length, 1, '前置：start() 应恰好拉一次');
    // 本机改动 ⇒ 与远端不同，SSE 到达后必须真的去拉。
    // 🔴 harness 的 doc 是闭包 `let`，从外面改不到 ⇒ 必须覆写 deps.getDoc，
    //   否则 harness 交出去的仍是初始 BASE，"本机也改过"这个前提根本没成立
    //   （那会让断言变成"远端==base"的平淡路径，守卫放不放行都能过）。
    h.deps.getDoc = () => LOCAL;

    INSTANCES[INSTANCES.length - 1].onmessage({ data: JSON.stringify({ t: 'note' }) });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(
      gets.filter((m) => m === 'GET').length,
      2,
      '🔴 SSE 推送到达后必须真的发第二次 GET —— 不发就是"SSE 自己发起的拉被守卫挡死"（本轮真 bug，症状零报错）',
    );
  } finally {
    c.stop();
    globalThis.fetch = saved;
    globalThis.EventSource = savedES;
  }
});

/* ------------------------------------------------------------------ *
 * SYNC-QUIET：用户报障第 7 条 —— idle 态的例行轮询必须静默
 *
 *   症状：没做任何编辑，底栏在「已同步」和「保存中」之间每 2 秒抖一次。
 *   根因：轮询回调**无条件** `send('remote-arrived')` ⇒ idle→syncing（底栏「连接中…」），
 *         拉完又回 idle ⇒ 内容一字未变却每 2 秒抖一次。
 *   老项目不抖（唯一权威）：`poll()` 拉成功后无条件 `setStatus(true,'已同步')`，
 *         轮询**从不产生中间态**（index.html:9933-9937）。
 *   ⇒ 修法：idle 态走 `quietPoll()`，**先比内容再决定要不要进状态机**。
 *
 *   判据纪律：状态抖动是"状态序列"上的性质，**必须记录完整快照序列**再断言
 *   "中间没有 syncing"，只断言最终态（idle）会让抖动实现照样全绿。
 * ------------------------------------------------------------------ */

/** 带快照序列采集的 harness（不用替身 push/pull，真跑网络通道 = fetch） */
function quietHarness(over = {}) {
  const snaps = [];
  const errors = [];
  let doc = over.doc ?? BASE;
  const deps = {
    noteId: over.noteId ?? 'quiet-probe',
    key: over.key ?? null,
    dk: over.dk ?? null,
    getDoc: () => doc,
    setDoc: (d) => { doc = d; },
    onSnapshot: (s) => snaps.push(s.state),
    onError: (m) => errors.push(m),
    isOnline: over.isOnline ?? (() => true),
  };
  return { snaps, errors, deps, getDoc: () => doc };
}

test('SYNC-QUIET-01 🔴 idle 例行轮询、远端与本机一致 ⇒ 状态序列里**不许出现 syncing**', async () => {
  const DK = await deriveKey('pw');
  const env = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  const gets = [];
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    gets.push(m);
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    assert.equal(c.getState(), 'idle', '前置：远端==本机，start 后应落到 idle');
    const getsAfterStart = gets.filter((m) => m === 'GET').length;

    // 🔴🔴 承重点：清空快照序列，只观察「静默轮询」这一段。
    //   若实现是"先 send('remote-arrived') 再拉"，这里必然录到 'syncing'。
    h.snaps.length = 0;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));

    assert.ok(
      gets.filter((m) => m === 'GET').length > getsAfterStart,
      '前置：轮询必须真的打了网络（否则这条判据什么都没测到）',
    );
    assert.deepEqual(
      h.snaps,
      [],
      `🔴 内容没变时轮询不许动状态机（底栏抖动根因）：实测状态序列 ${JSON.stringify(h.snaps)}`,
    );
    assert.equal(c.getState(), 'idle', '内容没变，必须一直停在 idle（老项目『已同步』恒定）');
    assert.deepEqual(h.errors, [], '内容没变不该有任何用户可见提示');
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-02 🔴 idle 例行轮询、远端**确实变了** ⇒ 必须采纳，不许静默吞掉真变化', async () => {
  const DK = await deriveKey('pw');
  const envSame = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const envNew = await encryptString(canonicalize(REMOTE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    n += 1;
    const env = n === 1 ? envSame : envNew; // 第一次拉 = 本机内容；之后远端改成 REMOTE
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    assert.equal(c.getState(), 'idle', '前置：初始应 idle');

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));

    const texts = (h.getDoc().blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join(''));
    assert.ok(
      texts.includes('远端也改过'),
      `🔴 静默轮询把真变化一起吞了：远端改动没进本机（${JSON.stringify(texts)}）`,
    );
    assert.equal(c.getState(), 'idle', '采纳远端后应收口到 idle');
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-03 🔴 idle 例行轮询遇网络失败 ⇒ 切 offline，且**不许先闪 syncing**', async () => {
  const DK = await deriveKey('pw');
  const env = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    if (fail) throw new Error('network down');
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    assert.equal(c.getState(), 'idle', '前置：初始应 idle');

    fail = true;
    h.snaps.length = 0;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));

    // 断网必须让用户看见（老项目 poll catch 会 setStatus(false,…)）
    assert.equal(c.getState(), 'offline', `断网轮询必须落到 offline，实际 ${c.getState()}`);
    // 🔴 反向（与 QUITE-01 同一条纪律）：不许走 idle→syncing→offline 两条边，
    //   那会在底栏先闪一下「连接中…」——正是用户报障第 7 条要消除的抖动。
    assert.ok(
      !h.snaps.includes('syncing'),
      `🔴 断网轮询不许先闪 syncing：实测序列 ${JSON.stringify(h.snaps)}`,
    );
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-04 🔴 接线：轮询回调在 idle 态必须走 quietPoll，不许无条件 send(remote-arrived)', async () => {
  const src = fs_read(new URL('../src/sync/client.ts', import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const at = src.indexOf('private startPoll(');
  const end = src.indexOf('private async quietPoll(');
  assert.ok(at >= 0 && end > at, '应能定位 startPoll 函数体');
  const seg = src.slice(at, end);
  assert.match(seg, /this\.state === 'idle'/, 'startPoll 必须对 idle 态单独分支（否则每 2 秒 send(remote-arrived) 抖底栏）');
  assert.match(seg, /quietPoll\(\)/, 'idle 分支必须走静默轮询');
  // 反向闸：idle 分支之后才允许无条件 send —— 用「quietPoll 出现在 send 之前」钉住顺序
  assert.ok(
    seg.indexOf('quietPoll()') < seg.indexOf("send('remote-arrived')"),
    '🔴 idle 分支必须在 send(remote-arrived) 之前 return，否则 idle 照样抖',
  );
});

test('SYNC-QUIET-05 🔴🔴 offline 态例行轮询连续失败 ⇒ 不许每 2 秒闪 syncing（对抗审 MAJOR-1）', async () => {
  const DK = await deriveKey('pw');
  const env = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    if (fail) throw new Error('network down');
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    fail = true;
    // 先落 offline
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'offline', `前置：断网必须已落 offline，实际 ${c.getState()}`);

    // 🔴🔴 承重点：清空序列，再观察**两个**轮询周期。
    //   此前 offline 落到 `send('remote-arrived')`（offline→syncing）再拉失败回 offline，
    //   ⇒ 每 2 秒闪一次 syncing。老项目 poll catch 只 setStatus(false,…)，从不产生中间态。
    h.snaps.length = 0;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 2 + 400));
    assert.ok(
      !h.snaps.includes('syncing'),
      `🔴 offline 态轮询不许闪 syncing：实测状态序列 ${JSON.stringify(h.snaps)}`,
    );
    assert.equal(c.getState(), 'offline', '持续失败必须一直停在 offline');
    assert.deepEqual(h.errors, [], 'offline 抖动不该产生用户可见错误');
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-06 🔴🔴 offline 态轮询拉成功且无改动 ⇒ 回 idle（网络恢复），不许永久停离线', async () => {
  const DK = await deriveKey('pw');
  const env = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    if (fail) throw new Error('network down');
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    fail = true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'offline', '前置：断网应落 offline');

    fail = false;
    h.snaps.length = 0;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'idle', `网络恢复后轮询应回 idle（已同步），实际 ${c.getState()}`);
    assert.ok(
      !h.snaps.includes('syncing'),
      `回 idle 不许经过 syncing（否则又闪『连接中…』）：${JSON.stringify(h.snaps)}`,
    );
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-07 🔴 非 2xx：5xx 必须降级 offline（不许谎报已同步），429 静默退避', async () => {
  const DK = await deriveKey('pw');
  const env = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  let status = 200;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    if (status !== 200) return { ok: false, status, text: async () => '', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    assert.equal(c.getState(), 'idle', '前置：初始 idle');

    // 429：静默退避，停在 idle（老项目把 429 排除在"同步中断"之外）
    status = 429;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'idle', '429 必须静默退避，不惊扰底栏');

    // 🔴 5xx：必须降级 offline —— 否则服务端持续 500 时底栏永久谎报『已同步』而内容不更新
    status = 500;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'offline', `5xx 必须降级 offline，实际 ${c.getState()}`);
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-08 🔴🔴 idle 静默轮询遇解密失败 ⇒ 不许静默谎报『已同步』（对抗审 MAJOR 回归）', async () => {
  // 形状：「他端改了口令」—— 远端信封本机 key 解不开。
  // 改前 idle 轮询走 pull ⇒ 解密失败会 onError + offline；静默轮询若静默 return，
  // 则底栏永久『已同步』而内容再也不更新（最坏的一类静默降级）。
  const DK = await deriveKey('pw');
  const DKother = await deriveKey('other-pw');
  const envOk = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const envBad = await encryptString(canonicalize(BASE), DKother.key, 'note', DKother);
  const saved = globalThis.fetch;
  let useBad = false;
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    const env = useBad ? envBad : envOk;
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    // 🔴 反向（前置）：正常信封时不许报错、不许降级
    assert.equal(c.getState(), 'idle', '前置：正常信封 ⇒ idle');
    assert.deepEqual(h.errors, [], '前置：正常时无任何用户可见错误');

    useBad = true; // 远端变成本机解不开的信封
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'offline', `解密失败必须降级 offline，实际 ${c.getState()}`);
    assert.ok(
      h.errors.some((m) => /解密|口令/.test(m)),
      `解密失败必须给出用户可见错误（不许静默），实际 ${JSON.stringify(h.errors)}`,
    );
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

test('SYNC-QUIET-09 🔴🔴 offline 态轮询遇 200+空体 ⇒ 必须回 idle（服务器可达），不许永久停离线', async () => {
  // 🔴 病根（对抗审 MINOR）：pullInner 对 200+空体发 `pulled`→idle，
  //   而 quietPoll 曾在此**静默 return** ⇒ offline 态下服务端可达却返回空体时，
  //   `offline --pulled--> idle` 那条边永远走不到 ⇒ 底栏永久停在『离线中』。
  //   这条判据钉住两条路径的**同口径**（同一 HTTP 结果 ⇒ 同一状态收场）。
  const DK = await deriveKey('pw');
  const env = await encryptString(canonicalize(BASE), DK.key, 'note', DK);
  const saved = globalThis.fetch;
  let mode = 'env'; // 'env' | 'fail' | 'empty'
  globalThis.fetch = async (url, init) => {
    const m = (init && init.method) || 'GET';
    if (m !== 'GET') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    if (mode === 'fail') throw new Error('network down');
    if (mode === 'empty') return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(env), json: async () => env };
  };

  const h = quietHarness({ doc: BASE, key: DK.key, dk: DK });
  const c = new SyncClient(h.deps);
  try {
    await c.start();
    assert.equal(c.getState(), 'idle', '前置：远端==本机 ⇒ idle');

    mode = 'fail';
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'offline', '前置：断网应落 offline');

    // 服务器恢复可达，但这篇在服务端**确实没有**（200+空体）
    mode = 'empty';
    h.snaps.length = 0;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 400));
    assert.equal(c.getState(), 'idle', `200+空体 = 服务器可达 ⇒ 必须回 idle，实际 ${c.getState()}`);
    assert.ok(
      !h.snaps.includes('syncing'),
      `回 idle 不许经过 syncing（否则又闪『连接中…』）：${JSON.stringify(h.snaps)}`,
    );
  } finally {
    c.stop();
    globalThis.fetch = saved;
  }
});

/* ------------------------------------------------------------------ *
 * SYNC-TIMEOUT：半死 socket —— 对抗审 MAJOR
 *
 *   症状：TCP 连着但服务端不回包 ⇒ 裸 fetch 永不 resolve ⇒ quietPoll/pull 的
 *         `finally { this.pulling = false }` 永不执行 ⇒ pulling 永久 true ⇒
 *         startPoll/SSE/refresh/retryPull 四个入口全早退 ⇒ 同步静默死，
 *         而底栏仍显示『已同步』。
 *   老项目依据：`withTimeout(apiGet(), 12000)`（index.html:9934），注释即
 *         「半死 socket 下 fetch 不再无限挂冻结状态条（『同步中断/连接中…』卡死根因）」。
 * ------------------------------------------------------------------ */

test('SYNC-TIMEOUT-01 🔴🔴 fetch 永不 resolve ⇒ fetchTextWithTimeout 必须超时 reject（否则 pulling 永久锁死）', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {}); // 永不 settle（半死 socket）
  try {
    const t0 = Date.now();
    await assert.rejects(() => fetchTextWithTimeout('/api/note/x', {}, 50), /timeout/);
    assert.ok(Date.now() - t0 < 2_000, '必须在超时后立刻 settle，不许跟着 fetch 一起挂死');
  } finally {
    globalThis.fetch = saved;
  }
});

test('SYNC-TIMEOUT-02 反向：fetch 在超时内返回 ⇒ 原样透传，不误伤正常请求', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  try {
    const r = await fetchTextWithTimeout('/api/note/x', {}, 5_000);
    assert.equal(r.status, 200, '正常 fetch 必须原样返回');
    assert.equal(r.text, '{}', '返回的是已读好的纯文本（读体也在超时窗口内）');
  } finally {
    globalThis.fetch = saved;
  }
});

test('SYNC-TIMEOUT-03 🔴 接线：quietPoll 与 pullInner 两条 GET 必须走 fetchTextWithTimeout（不许裸 fetch）', () => {
  // 🔴 去注释再匹配（注释里写着 fetch/fetchTextWithTimeout，留着会恒绿）
  const src = fs_read(new URL('../src/sync/client.ts', import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  // 反向（全文件）：不许还有裸 fetch 的 GET 拉取
  assert.ok(!/await fetch\(`\/api\/note\//.test(src), '不许还有裸 fetch 的 GET 拉取路径（半死 socket 会挂死 pulling）');

  // 正向：**逐方法体**断言，而不是数全文件里 `fetchTextWithTimeout(` 的个数。
  //   🔴 对抗审 nit：早先写 `uses.length >= 2` 是**弱断言** —— claim/push 两个 POST
  //      也走了同一封装，光数个数可被 POST 满足，而注释声称的"两条 GET 都覆盖"
  //      根本没被钉住（quietPoll/pullInner 任一退回裸 fetch 也照样绿）。
  //      切片到方法体，才能让"这两条 GET"名副其实。
  const sliceMethod = (text, name) => {
    const m = new RegExp(`private async ${name}\\(`).exec(text);
    if (!m) return '';
    const open = text.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(m.index, i + 1);
      }
    }
    return '';
  };
  for (const name of ['quietPoll', 'pullInner']) {
    const body = sliceMethod(src, name);
    assert.ok(body.length > 0, `必须能从 client.ts 切出 ${name} 的方法体`);
    assert.ok(
      /fetchTextWithTimeout\(\s*`\/api\/note\//.test(body),
      `${name} 的远端 GET 必须走 fetchTextWithTimeout（不许裸 fetch）`,
    );
    assert.ok(!/await fetch\(/.test(body), `${name} 方法体内不许有裸 fetch 的拉取`);
  }
});

test('SYNC-TIMEOUT-04 🔴 注入的 fetch 也走同一条超时（解锁/出码那两枪不许绕过）', async () => {
  // 🔴 解锁（unlock.ts）与出码（main.ts 的 fetchBakNote）用的是**外部注入**的 fetch，
  //   若只给 client.ts 的裸 fetch 加超时，半死 socket 只是从"同步卡住"挪到
  //   "连笔记都打不开 / 出码永远转圈" —— 同一个坑没填上。
  //   这条判据直接证明 fetchTextWithTimeout 的第 4 参（注入 f）同样受超时保护。
  const never = () => new Promise(() => {});
  const t0 = Date.now();
  await assert.rejects(() => fetchTextWithTimeout('/api/note/x', {}, 50, never), /timeout/);
  assert.ok(Date.now() - t0 < 2_000, '注入的 f 永不 settle 时，必须在超时后立刻 reject');

  // 反向：注入的 f 在超时内返回 ⇒ 原样透传（不误伤正常请求）
  const okF = async () => ({ ok: true, status: 200, text: async () => '{}' });
  const r = await fetchTextWithTimeout('/api/note/x', {}, 5_000, okF);
  assert.equal(r.status, 200, '注入的 f 正常返回时必须原样透传');
});

test('SYNC-TIMEOUT-05 🔴 接线：解锁与出码的 GET 也必须走超时（不许裸 f(...)）', () => {
  // 🔴 去注释再匹配（注释里写着 fetchTextWithTimeout/f()，留着会恒绿）
  const strip = (u) =>
    fs_read(u).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const unlock = strip(new URL('../src/sync/unlock.ts', import.meta.url));
  assert.ok(
    /fetchTextWithTimeout\(\s*`\/api\/note\//.test(unlock),
    'unlock.ts 的远端 GET 必须走 fetchTextWithTimeout',
  );
  // 反向：裸 f(`/api/note/…`) 只应剩 rekey 的 POST 一处
  //   （老项目 apiPut 不套超时，逐字承接 —— 不是漏改）
  const bareUnlock = unlock.match(/f\(`\/api\/note\//g) ?? [];
  assert.equal(bareUnlock.length, 1, `unlock.ts 裸 f() 的 /api/note 只应剩 rekey 的 POST 一处，实际 ${bareUnlock.length}`);

  const main = strip(new URL('../src/main.ts', import.meta.url));
  assert.ok(
    /fetchTextWithTimeout\(\s*`\/api\/note\//.test(main),
    'main.ts 的 fetchBakNote GET 必须走 fetchTextWithTimeout',
  );
  // 反向：裸 f(`/api/note/…`) 只应剩 putBakNote 的 POST 一处
  //   （老项目 apiPutTo 不套超时，逐字承接 —— 这里不是漏改，是有意保留）
  const bare = main.match(/f\(`\/api\/note\//g) ?? [];
  assert.equal(bare.length, 1, `main.ts 裸 f() 的 /api/note 调用只应剩 POST 一处，实际 ${bare.length}`);
});

test('SYNC-TIMEOUT-06 🔴🔴 响应头到了但读体挂死 ⇒ 仍在超时窗口内 reject（只填一半等于没填）', async () => {
  // 🔴 对抗审 MINOR：老项目 `withTimeout(apiGet(), 8000)` 里 apiGet 是
  //   `const r = await fetch(...); return await r.json();` —— **读体在窗口内**。
  //   若封装只 race 到"拿到 Response"就解除超时，则"服务端发了响应头后卡住 body"
  //   仍会挂死：unlock 永久转圈、quietPoll 的 pulling 永久 true。本判据钉死读体也在窗口内。
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  try {
    const t0 = Date.now();
    await assert.rejects(() => fetchTextWithTimeout('/api/note/x', {}, 50), /timeout/);
    assert.ok(Date.now() - t0 < 2_000, '读体挂死也必须在超时后立刻 settle，否则 unlock/quietPoll 仍会永久挂');
  } finally {
    globalThis.fetch = saved;
  }
});
