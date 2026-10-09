/**
 * FSM-xxxx判据 —— 用户报障第1 条「底栏闪『非法状态转移：…』」
 *
 * 🔴🔴 这批判据针对的是**内部异常泄漏到用户界面**这一类故障。
 *   症状不是"同步坏了"，而是"同步其实好好的，但底栏闪了一下红点"——
 *   也就是说用户看到的是**开发者的话**，产品却把它当成了状态文案。
 *
 *   根因是三处联动（缺一处就复现）：
 *     ① fsm.ts 对非法转移抛 IllegalTransitionError（消息模板「非法状态转移：…」）
 *② sync/client.ts send() catch 到它后调 onError
 *     ③ main.ts:1567-1569 的 onError 是 footStatus('offline', msg)
 *        —— 把内部异常消息当作用户可见文案推到屏幕底栏
 *
 *   基准是**老项目**（index.html，12400 行单文件）：
 *     · 根本没有状态机，底栏只有 setStatus(on, text) 一个函数（:1723）
 *     · 文案是 30 句固定白名单，`grep -o "setStatus(\(true\|false\), *'[^']*'" index.html | sort -u`
 *       可复现 —— 里面**从来没有**"非法状态转移"这个概念
 *     · SSE 收到推送后的动作是 `sseSource.onmessage = () => { poll(); }`（:10047）
 *       —— 重新拉一次，**永远不报状态错误**
 *
 * 判据纪律：
 *   · 必须 import 生产代码（fsm.ts / client.ts），不把实现抄进测试
 *   · 每条「应该有」配一条「不应该有」
 *   · 断言「某段代码不存在」时，输入必须是**去注释后的代码**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 🔴 必须先装垫片再 import 被测模块：client.ts 间接依赖 localStorage，
//   没有它就是 ReferenceError，症状是"用例莫名红了"，与被测逻辑无关。
import { installBrowserShims } from './dom-shims.mjs';
installBrowserShims();

const {
  ALL_EVENTS,
  ALL_STATES,
  IllegalTransitionError,
  canTransition,
  reduce,
  snapshotOf,
} = await import('../src/sync/fsm.ts');
const { SyncClient } = await import('../src/sync/client.ts');
const { deriveKey, encryptString, canonicalize } = await import('../../shared-schema/src/index.ts');

const PASS = 'pw';
const SHARED_DK = await deriveKey(PASS);
const seal = (d) => encryptString(canonicalize(d), SHARED_DK.key, 'note', SHARED_DK);

function docOf(...lines) {
  if (lines.length === 0) return { v: 1 };
  return { v: 1, blocks: lines.map((t) => ({ t: 'p', spans: [{ t }] })) };
}
const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b });
/** 等去抖到期（PUSH_DEBOUNCE_MS = 700，留足余量） */
const settle = () => new Promise((r) => setTimeout(r, 1200));

/**
 * 🔴🔴 必须垫EventSource：生产代码 openStream() 开头就是
 *   `if (typeof EventSource === 'undefined') return;`，
 *   没有它整条 SSE 分支在 node 里根本不执行 ——
 *   症状是"SSE 用例全绿"，而线上照样闪红点。
 */
const SSE_INSTANCES = [];
globalThis.EventSource = class {
  constructor(url) { this.url = url; this.closed = false; SSE_INSTANCES.push(this); }
  close() { this.closed = true; }
};
/** 触发一次"服务端推了这条笔记"（等价 client.ts:565-570 那几行） */
const deliverSse = () => SSE_INSTANCES[SSE_INSTANCES.length - 1].onmessage({
  data: JSON.stringify({ t: 'note' }),
});

/** 搭一个受控 SyncClient，把两条错误通道分开记录 */
function mkClient(fetchImpl, opts = {}) {
  const holder = { doc: opts.doc ?? docOf() };
  const userErrors = [];
  const internalErrors = [];
  globalThis.fetch = fetchImpl;
  const c = new SyncClient({
    noteId: opts.noteId ?? 'fsm-probe',
    key: SHARED_DK.key,
    dk: SHARED_DK,
    getDoc: () => holder.doc,
    setDoc: (d) => { holder.doc = d; },
    onSnapshot: () => {},
    onError: (m) => userErrors.push(m),
    onInternalError: (m) => internalErrors.push(m),
    isOnline: opts.isOnline ?? (() => true),
  });
  return {
    c,
    doc: () => holder.doc,
    setDoc: (d) => { holder.doc = d; },
    userErrors,
    internalErrors,
  };
}

/* ==================================================================
 * 1. 补的边：真实网络时序下**必须合法**
 * ==================================================================*/

test('FSM-01 offline + remote-arrived 不再抛（用户报障第 1 条的正身）', () => {
  // 触发路径：PC 端更新 → 移动端 SSE 收到 remote-arrived（client.ts:569）
  //→ 此刻状态机在 offline（先前某次 fetch 失败落的）→ 此前无此边 → 抛
  assert.equal(
    canTransition('offline', 'remote-arrived'),
    true,
    'SSE 推送到达时状态机完全可能在 offline：SSE 连接还活着（所以推送收得到），但先前一次 fetch 失败把它落在了 offline',
  );
  assert.equal(reduce('offline', 'remote-arrived'), 'syncing', '语义是"去重拉一次"（老项目 :10047 有推送就 poll）');
  // 闭环：拉不成时 pull 自己会 network-fail 回offline（既有边）
  assert.equal(reduce('syncing', 'network-fail'), 'offline', '重拉失败必须能回到 offline，否则这条边会把状态机卡死在 syncing');
});

test('FSM-02 pushing + push 合法（合并干净后的自动重推，此前必抛）', () => {
  // client.ts decryptAndMerge 末尾 send('merge-clean') 把状态推到 pushing，
  // 紧接着 await this.push()，而 push() 第一句就是 send('push')。
  assert.equal(canTransition('pushing', 'push'), true, '合并干净 → 自动重推是最常见的正常协作路径，此前必抛');
  assert.equal(reduce('pushing', 'push'), 'pushing', '只能自环：仍在推，不许倒退到 dirty');
});

test('FSM-03 dirty 的迟到结论四条边合法，且**绝不清 dirty**', () => {
  // 成因都是同一个：pull/push 是异步的，等它await 回来时用户又打字了。
  assert.equal(canTransition('dirty', 'pushed'), true, 'push 在途时用户又打字（pushing--edit-->dirty），POST 回来才发 pushed');
  assert.equal(canTransition('dirty', 'pulled'), true, 'pull 在途时用户又打字，pulled 迟到');
  assert.equal(canTransition('dirty', 'merge-clean'), true, '同上');
  assert.equal(canTransition('dirty', 'merge-conflict'), true, '同上');

  // 🔴 反向（这里最关键）：pushed绝不能清 dirty。
  // 那批字还没推上去，清了就是「静默降级」：用户以为存上了，实际只在内存里。
  assert.equal(reduce('dirty', 'pushed'), 'dirty', 'pushed 绝不许把 dirty 清成 idle：那批字还没推上去');
  assert.equal(snapshotOf('dirty').unsaved, true, 'dirty 必须继续显示"未同步"');

  assert.equal(reduce('dirty', 'merge-clean'), 'pushing', '合并干净且本地确有改动 → 去推');
  assert.equal(reduce('dirty', 'merge-conflict'), 'conflict', '真冲突 → 回退到等用户裁决');
});

/* ==================================================================
 * 2. 用真实 SyncClient跑真实时序：整条链路上onError 必须干净
 * ==================================================================*/

test('FSM-04 真实时序：offline 状态收到 SSE 推送，全程零用户可见错误', async () => {
  const env = await seal(docOf('x'));
  const { c, userErrors, internalErrors } = mkClient(async () => ok(env), {
    isOnline: () => false, // 让 start() 立刻 network-fail落offline
  });
  await c.start();
  assert.equal(c.getState(), 'offline', '前置：本用例必须真的处在 offline，否则测的不是这条边');

  deliverSse();
  await settle();

  assert.deepEqual(userErrors, [], '底栏绝不能出现内部异常消息（老项目 30 句白名单里没有"非法状态转移"）');
  assert.deepEqual(internalErrors, [], '本用例的边已补齐，不该再有内部异常被上报');
  c.stop();
});

test('FSM-05 真实时序：合并干净 → 自动重推，零用户可见错误', async () => {
  // PC 与手机改**不同处**（不是冲突路径，是最常见的正常协作路径）
  let n = 0;
  const { c, userErrors, setDoc } = mkClient(async (u, init) => {
    if (init && init.method === 'POST') return ok({ v: 7 });
    n += 1;
    if (n === 1) return ok(await seal(docOf('A', 'B', 'C')));
    return ok(await seal(docOf('A', 'B', 'C-remote')));
  });
  await c.start();
  setDoc(docOf('A-local', 'B', 'C'));
  userErrors.length = 0;

  deliverSse();
  await settle();

  assert.deepEqual(userErrors, [], '合并干净后的自动重推此前必抛 pushing--push-->');
  assert.equal(c.getState(), 'idle', '推成功应收口到 idle');
  c.stop();
});

test('FSM-06 真实时序：推送在途时用户又打字，pushed 不得把 dirty 清掉', async () => {
  const env = await seal(docOf('a'));
  let gate;
  const hold = new Promise((r) => { gate = r; });
  const { c, userErrors, setDoc } = mkClient(async (u, init) => {
    if (init && init.method === 'POST') { await hold; return ok({ v: 2 }); }
    return ok(env);
  });
  await c.start();
  setDoc(docOf('a', 'edit1'));
  c.noteEdit();
  await settle();                       // push 已发出并卡在 POST
  assert.equal(c.getState(), 'pushing', '前置：必须处在 pushing');

  setDoc(docOf('a', 'edit1', 'edit2')); // 用户在 push 在途时又打字
  c.noteEdit();
  userErrors.length = 0;
  gate();                               // 放行 → push() 末尾 send('pushed')
  // 🔴 只等POST 落地，不等去抖窗口（700ms）：要抓的是"第一次 pushed 之后"那个瞬间。
  //   等满settle() 会看到 idle —— 那是**对**的：noteEdit 挂的去抖定时器又推了一次，
  //   第二批字真的上去了。先前我误把最终态当判据，判据自己写错了。
  await new Promise((r) => setTimeout(r, 250));

  assert.deepEqual(userErrors, [], '此前会抛 dirty--pushed-->');
  assert.equal(
    c.getState(),
    'dirty',
    '第一次 pushed 之后必须停在 dirty：那批字还没推上去，清成 idle 就是静默降级',
  );

  await settle();                // 让去抖把第二批字真的推上去
  assert.equal(c.getState(), 'idle', '第二批字最终必须能推上去并收口到 idle（不许只停在 dirty 卡住）');
  c.stop();
});

test('FSM-07 真实时序：冲突未裁决时收到 SSE，不重拉也不改文档', async () => {
  const envTheirs = await seal(docOf('L1', 'theirs'));
  // 本地 docOf('L1','mine') 与远端 theirs 改同一处 ⇒ 真冲突
  const { c, userErrors, doc } = mkClient(async (u, init) => {
    if (init && init.method === 'POST') return ok({ v: 5 });
    return ok(envTheirs);
  }, { doc: docOf('L1', 'mine') });
  await c.start();
  deliverSse();
  await settle();

  assert.equal(c.getState(), 'conflict', '前置：本用例必须真的处在 conflict');
  userErrors.length = 0;
  const snapshotBefore = JSON.stringify(doc());

  deliverSse(); // 用户还没拍板，PC 端又推了一次
  await settle();

  assert.deepEqual(userErrors, [], '冲突期间收到推送此前会连抛两条（conflict--remote-arrived--> 与 conflict--merge-conflict-->）');
  assert.equal(c.getState(), 'conflict', '必须仍在 conflict：用户没拍板就不许自己恢复');
  assert.equal(JSON.stringify(doc()), snapshotBefore, '用户没拍板前，文档不许被再合并一次改掉');
  c.stop();
});

/* ==================================================================
 * 3. 反向：这些边**仍然**必须非法（不许为"不报错"把边全放开）
 * ==================================================================*/

test('FSM-08 反向：locked 态仍然只有 unlock 一条路', () => {
  assert.deepEqual(
    ALL_EVENTS.filter((ev) => canTransition('locked', ev)),
    ['unlock'],
    '没有密钥时编辑/重拉/推送在语义上都是无意义的，绝不能为了不报错而放开',
  );
});

test('FSM-09 反向：locked + edit / conflict + edit 仍必须抛', () => {
  // locked + edit：老项目就是在这里让人"锁着也能改、改了不保存"，已知 bug
  assert.equal(canTransition('locked', 'edit'), false, '锁着不许编辑');
  // conflict + edit：未裁决时继续打字会覆盖对方
  assert.equal(canTransition('conflict', 'edit'), false, '未裁决时不该允许继续打字覆盖对方');
  assert.throws(
    () => reduce('locked', 'edit'),
    (e) => e instanceof IllegalTransitionError,
    'locked--edit--> 必须仍抛 IllegalTransitionError',
  );
});

test('FSM-10 反向：conflict 态**故意没有** remote-arrived 边', () => {
  // 老项目 index.html:9947 `if (pendingRemoteNote) { pendingRemoteNote = note; return; }`
  //   —— 挂起期的远端更新是"存起来等用户拍板"，不是"再合并一次"。
  // ⇒ 合法做法是 client.ts 在 conflict 时不重拉，而不是给状态机开这条边。
  assert.equal(canTransition('conflict', 'remote-arrived'), false, '开了这条边就会在用户没拍板时又改一次文档');
  assert.equal(canTransition('conflict', 'pulled'), false, '同上');
  assert.equal(canTransition('conflict', 'merge-clean'), false, '同上');
  // 而 client.ts 必须真的挡了
  const src = readFileSync(new URL('../src/sync/client.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(
    src,
    /if\s*\(this\.state === 'conflict'\)\s*return;/,
    'client.ts 必须在 conflict 态跳过自动重拉（与 fsm.ts 缺这条边是配套的）',
  );
});

/* ==================================================================
 * 4. 结构一致性：边表与 reducer 必须对得上（穷举 8×14 = 112）
 * ==================================================================*/

test('FSM-11 边表与 reducer 一致（穷举 8 状态 × 14 事件 = 112 组合）', () => {
  for (const from of ALL_STATES) {
    for (const ev of ALL_EVENTS) {
      if (!canTransition(from, ev)) {
        assert.throws(
          () => reduce(from, ev),
          (e) => e instanceof IllegalTransitionError && e.from === from && e.ev === ev,
          `${from}--${ev}--> 应当抛 IllegalTransitionError`,
        );
      } else {
        const next = reduce(from, ev);
        assert.ok(ALL_STATES.includes(next), `${from}--${ev}--> 返回了非法状态 ${next}`);
      }
    }
  }
});

test('FSM-12 补边只增不减：locked 与 conflict 的可走事件集合没被放宽', () => {
  // 逐条钉住"不该被放开的"，防止后来者为了图省事把边全放开
  assert.equal(canTransition('locked', 'push'), false);
  assert.equal(canTransition('locked', 'pulled'), false);
  assert.equal(canTransition('locked', 'pushed'), false);
  assert.equal(canTransition('conflict', 'edit'), false);
  assert.equal(canTransition('conflict', 'pushed'), false);
  assert.equal(canTransition('conflict', 'push'), false);
  // 反向：offline 仍然不许直接推送（网络不可达，推了也是白推）
  assert.equal(canTransition('offline', 'push'), false, '离线时直接推送在语义上就是错的');
  assert.equal(canTransition('offline', 'pushed'), false);
});

test('FSM-12b 补边不许吞掉 lock：任何非锁态的 lock 都必须回 locked', () => {
  // 🔴🔴 这条是被真bug 逼出来的：给 dirty 补"迟到结论"边时，我在reduce 里写了
  //   `if (ev==='merge-clean')…; if (ev==='merge-conflict')…; return 'dirty';`
  //   —— `return 'dirty'` 把 **lock** 一起吞了，于是用户点"退出锁定"锁不掉，
  //   dirty--lock--> 返回 dirty。是既有的 S3-37 抓到的。
  //   教训：往reduce 的某个 case 里加"兜底 return"时，必须先确认兜底不会吃掉
  //   那个 case 原有的其它合法事件。
  for (const st of ALL_STATES) {
    if (st === 'locked') continue;
    assert.equal(reduce(st, 'lock'), 'locked', `${st}--lock--> 应回 locked`);
  }
  // 反向：locked 态自己不该再收到 lock（无意义，且会把状态机锁死出不来）
  assert.equal(canTransition('locked', 'lock'), false, 'locked 态只有 unlock 一条路');
});

/* ==================================================================
 * 5. 通道纪律：内部错误**可观测但不入UI**（这是修复的第二处联动）
 * ==================================================================*/

test('FSM-13 非法转移走 onInternalError，绝不走 onError（用户可见通道）', async () => {
  // 造一个必然抛的状态机：直接调send('edit') 时状态是 locked → locked--edit--> 非法
  const { c, userErrors, internalErrors } = mkClient(async () => ok(await seal(docOf())));
  // start() 前状态是 locked（见 client.ts 字段初始值），此时 noteEdit 会打到 locked--edit-->
  c.noteEdit();

  assert.deepEqual(userErrors, [], '内部/编程错误绝不许进 onError —— 它会被 main.ts:1567 当用户文案推到底栏');
  assert.equal(internalErrors.length, 1, '但必须可观测（不许静默吞成黑洞）');
  assert.match(internalErrors[0], /非法转移/, '内部通道要带得出手的定位信息');
  assert.ok(
    !userErrors.some((m) => m.includes('非法状态转移')),
    '"非法状态转移"绝不允许出现在用户可见文案里',
  );
  c.stop();
});

test('FSM-14 反向：用户可见错误（口令错等）仍必须走 onError，不许被一起屏蔽', async () => {
  const bad = await import('../../shared-schema/src/index.ts');
  const env = bad.Envelope
    ? { t: 'note', ct: 'AAAA', iv: 'AAAA', s: 'AAAAAAAAAAAAAAAAAAAAAA' }
    : { t: 'note', ct: 'AAAA', iv: 'AAAA', s: 'AAAAAAAAAAAAAAAAAAAAAA' };
  const { c, userErrors, internalErrors } = mkClient(async () => ok(env));
  await c.start();

  assert.deepEqual(internalErrors, [], '口令错是用户可见错误，不是内部错误');
  assert.equal(userErrors.length, 1, '口令错必须仍然提示用户（老项目白名单里有「已锁定，请稍后」）');
  assert.match(userErrors[0], /口令不对/, '文案必须是用户能据此行动的那句');
  assert.ok(
    !/非法状态转移/.test(userErrors.join('|')),
    '用户可见文案里绝不许混进内部异常消息',
  );
  c.stop();
});

test('FSM-15 SyncDeps 同时提供两条通道，且 onInternalError 是可选的', () => {
  const src = readFileSync(new URL('../src/sync/client.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(src, /onInternalError\?:/, 'onInternalError 必须是可选的：不传时退化 console.warn，不逼调用方立刻改');
  assert.match(src, /console\.warn/, '不传 onInternalError 时必须有退化出口，否则日志会被静默丢弃');
  // 反向：send() 的 catch 里不许再出现 onError
  const sendBody = src.match(/private send\(ev: SyncEvent\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(sendBody.length > 0, '未找到 send()，判据失效');
  assert.doesNotMatch(
    sendBody,
    /this\.d\.onError\(/,
    'send() 的 catch 里绝不许再调 onError —— 那正是把内部异常推给用户的根因',
  );
});

test('FSM-17 🔴 idle --network-fail--> offline：静默轮询断网要能落 offline，且不许先闪 syncing', () => {
  // 用户报障第 7 条配套：idle 态例行轮询（client.ts quietPoll）断网时，
  // 必须能把底栏切成「离线中」——老项目 poll 的 catch 就是 setStatus(false,…)。
  assert.equal(canTransition('idle', 'network-fail'), true, 'idle 直连 offline 必须合法，否则断网只能走 idle→syncing→offline 两条边');
  assert.equal(reduce('idle', 'network-fail'), 'offline', '静默轮询拉失败必须落 offline');
  // 🔴 反向：补这条边**不许**顺手放开 idle 的推送类事件（离线/空闲时推送在语义上就是错的）
  assert.equal(canTransition('idle', 'push'), false, 'idle 不许直接 push');
  assert.equal(canTransition('idle', 'pushed'), false, 'idle 不许直接 pushed');
  assert.equal(canTransition('idle', 'merge-clean'), false, 'idle 不许直接 merge-clean');
});

test('FSM-18 🔴 offline --pulled--> idle：静默轮询网络恢复要能回「已同步」，且不许永久停 offline', () => {
  // 用户报障第 7 条配套（对抗审 MAJOR-1）：offline 态例行轮询拉成功且无改动 ⇒ 网络恢复，
  // 必须能回 idle。没有这条边时 offline 只能靠 window 'online' 事件回 idle，
  // 而"navigator.onLine 恒 true 但服务端不可达"（隧道/半死 socket）时浏览器不派发 'online'
  // ⇒ 底栏永久停在『离线中』。
  assert.equal(canTransition('offline', 'pulled'), true, 'offline 必须能回 idle，否则网络恢复后永久停离线');
  assert.equal(reduce('offline', 'pulled'), 'idle', '拉成功且无改动 ⇒ 已同步');
  // 🔴 反向：不许顺手放开 offline 的推送类事件（离线时推送在语义上就是错的）
  assert.equal(canTransition('offline', 'push'), false, 'offline 不许直接 push');
  assert.equal(canTransition('offline', 'pushed'), false, 'offline 不许直接 pushed');
  assert.equal(canTransition('offline', 'merge-clean'), false, 'offline 不许直接 merge-clean');
});

test('FSM-16 🔴 采纳远端必须刷新本机离线缓存（S4：不刷 = 离线重开读到静默回滚的旧版）', async () => {
  // 场景：两次拉取之间本地没改（local == base）→ 走 client.ts 的"直接采纳"分支。
  // 🔴 该分支此前只 setDoc 不写缓存 ⇒ 缓存里还是第一次 pull 的旧信封，
  //   而 unlock 的缓存命中分支**不查服务器** ⇒ 下次离线重开，用户看到旧正文且零报错。
  const env1 = await seal(docOf('first'));
  const env2 = await seal(docOf('second'));
  assert.notEqual(env1.iv, env2.iv, '前置：两封信封 iv 必须真的不同（GCM 随机 iv），否则判据恒真');
  let n = 0;
  const { c, userErrors } = mkClient(async (u, init) => {
    if (init && init.method === 'POST') return ok({ v: 9 });
    n += 1;
    return ok(n === 1 ? env1 : env2);
  });
  await c.start(); // 第一次 pull：远端 first → 采纳

  // 前置：采纳后缓存里必须是第一封信封
  const raw1 = globalThis.localStorage.getItem('notesync_bj_cache_fsm-probe');
  assert.ok(raw1, '第一次采纳后离线缓存必须已有记录');
  const c1 = JSON.parse(raw1);
  assert.equal(c1.iv, env1.iv, '前置：缓存存的是第一封信封');

  deliverSse(); // 第二次 pull：远端 second → 走采纳分支
  await settle();

  assert.deepEqual(userErrors, [], '全程零用户可见错误');
  const raw2 = globalThis.localStorage.getItem('notesync_bj_cache_fsm-probe');
  assert.ok(raw2, '第二次采纳后缓存记录必须还在');
  const c2 = JSON.parse(raw2);
  assert.equal(c2.iv, env2.iv, '🔴 采纳远端后缓存必须刷新成新信封（承重断言）');
  assert.equal(c2.ct, env2.ct, 'ct 也必须是新信封的（只刷 iv 不刷 ct = 半截修复）');
  c.stop();
});