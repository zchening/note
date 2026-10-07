/**
 * LAST- APK 冷启动自动进入上次笔记（五部件）
 *
 * 用户需求：「每次杀掉进程后重新进入，期望进入的是退出前所在的最后一篇笔记」。
 *
 * 🔴🔴 本文件钉的是**五部件全部**，不是其中最容易漏的那一处：
 *   ① 记住键（localStorage，永久）+ 抑制键（sessionStorage，120s 窗口）
 *   ② 三条解锁路径各写一次（老项目只有两条，bj 多一条扫码配对）
 *   ③ route() 两个空路径分支都读键跳转（bj 比老项目多一个 sanitize 后为空的兜底）
 *   ④ 三处抑制：菜单回首页 / 口令框关闭 / pagehide
 *   ⑤ 原生守卫 + 笔记名校验
 *
 * 🔴 老项目 v5.57 的教训（本文件 LN-06 钉着）：**只写一处是真 bug**。
 *   此前"记住密钥/扫码配对进来的设备"从不更新 last note ⇒ 冷启动形同虚设，
 *   而用户实测实锤。所以每条解锁路径都必须写，判据逐路径点名。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  JUMP_WINDOW_MS,
  isUsableNoteId,
  jumpedRecently,
  lastNoteToResume,
  markJumped,
  readLastNote,
  rememberLastNote,
} from '../src/route/last-note.ts';

/**
 * 装一套干净的 local/sessionStorage 桩，并在结束时还原。
 *
 * 🔴 为什么不直接用 node 的全局 localStorage：Node 22 没有全局 Web Storage，
 *   而这两处存储是本模块**唯一**的副作用面 —— 不打桩就只能测纯函数，
 *   测不到"记住 → 读回"这条主链路（那才是用户可见的行为）。
 */
function withStorage(fn) {
  const savedL = globalThis.localStorage;
  const savedS = globalThis.sessionStorage;
  const mk = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  };
  globalThis.localStorage = mk();
  globalThis.sessionStorage = mk();
  try {
    return fn();
  } finally {
    if (savedL === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = savedL;
    if (savedS === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = savedS;
  }
}

/** 源码（去注释）—— 用于"接线在不在"这类结构性判据。 */
function codeOf(rel) {
  const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 从 `start` 处那个箭头函数的 `{` 起，按花括号配平截出它的函数体（不含结尾的 `}`）。
 *
 * 🔴🔴 为什么不能按固定长度 slice：去注释后 700px 窗口会越过函数尾，
 *   把紧随其后的 `window.addEventListener('pagehide', ...)` 一起吃进来 ——
 *   于是"handler 内部不得注册第二个监听器"这条判据**恒红**（红在别人的正确代码上）。
 *   这就是"判据本身也会钉错"：它钉的是切片长度，不是语义。
 *   本仓缩进风格统一（2 空格），按 `});` 收尾行也能用，但花括号配平与缩进无关，更稳。
 */
function sliceBlock(code, start) {
  const open = code.indexOf('{', start);
  assert.ok(open > 0, '应能找到函数体的 {');
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(open, i);
    }
  }
  throw new Error('函数体花括号不配平，判据自身有问题');
}

/* ---------------- LN-01/02 存储行为 ---------------- */

test('LN-01 🔴 记住 → 读回，记住的是**净化后**的笔记名', () => {
  withStorage(() => {
    assert.equal(readLastNote(), null, '一开始没有记住任何笔记');
    rememberLastNote('myNote-1');
    assert.equal(readLastNote(), 'myNote-1', '应能读回刚记住的笔记名');
  });
});

test('LN-01 🔴 反向：非法笔记名不写、不读出（路径穿越与空串都要挡住）', () => {
  withStorage(() => {
    for (const bad of ['', '../etc', 'a/b', '名字', 'a'.repeat(65), 'a b', '<script>']) {
      rememberLastNote(bad);
      assert.equal(readLastNote(), null, `不该记住 ${JSON.stringify(bad)}`);
    }
  });
});

test('LN-02 🔴 抑制窗口 120s（老项目 :918逐字）：窗口内抑制、窗口外放行', () => {
  withStorage(() => {
    const t0 = 1_000_000;
    assert.equal(JUMP_WINDOW_MS, 120_000, '窗口必须是 120s（老项目 :918）');

    markJumped(t0);
    assert.equal(jumpedRecently(t0), true, '刚打标记就该抑制');
    assert.equal(jumpedRecently(t0 + JUMP_WINDOW_MS - 1), true, '窗口内最后一毫秒仍抑制');
    assert.equal(jumpedRecently(t0 + JUMP_WINDOW_MS), false, '窗口外必须放行（否则免输名特性被误杀）');
  });
});

test('LN-02 🔴🔴 时钟回拨/未来时间戳视为过期放行（老项目 :923 逐字）', () => {
  withStorage(() => {
    const t0 = 1_000_000;
    markJumped(t0);
    // 现在比标记还早 ⇒ age 为负。老项目 :923 明确按"过期"处理：
    // 不加这条，标记永不过期 ⇒ 冷启动特性被静默杀死（用户永久停在首页）。
    assert.equal(jumpedRecently(t0 - 5_000), false, '未来时间戳必须放行，不能永久抑制');
  });
});

test('LN-02 🔴 反向：抑制标记活不过一次冷启动（sessionStorage 语义）', () => {
  withStorage(() => {
    markJumped(1_000);
    assert.equal(jumpedRecently(1_000), true);
    // 模拟杀进程重进：sessionStorage 全新（这正是它选 session 而非 local 的理由）。
    // 🔴 withStorage 的 finally 会还原桩，所以这里换掉全局是安全的、且必须在这里换
    //   —— 在 withStorage 外面换会被 finally 覆盖掉，判据就变成恒绿。
    globalThis.sessionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    assert.equal(jumpedRecently(1_000), false, '新进程不该继承抑制标记，否则杀进程后永远进不去笔记');
  });
});

/* ---------------- LN-03 恢复判据（原生守卫 × 抑制 × 有键） ---------------- */

test('LN-03 🔴 原生 + 有键 + 未抑制 → 返回笔记名（这是用户要的那条路径）', () => {
  withStorage(() => {
    rememberLastNote('lastA');
    assert.equal(lastNoteToResume(true), 'lastA', 'APK 冷启动应恢复最后一篇');
  });
});

test('LN-03 🔴 反向一：网页端**绝不**恢复（老项目 :10152 的 isNativeApp 守卫）', () => {
  withStorage(() => {
    rememberLastNote('lastA');
    assert.equal(
      lastNoteToResume(false),
      null,
      '网页端不能自动进笔记 —— 那是老项目明确的口径（浏览器地址栏/后退键语义不同）',
    );
  });
});

test('LN-03 🔴 反向二：刚回过首页 → 抑制（否则「回首页」按钮形同虚设）', () => {
  withStorage(() => {
    rememberLastNote('lastA');
    markJumped();
    assert.equal(lastNoteToResume(true), null, '本会话刚主动回过首页就不该再弹回笔记');
    // 窗口过后必须恢复放行，否则用户永远进不去
    assert.equal(lastNoteToResume(true, Date.now() + JUMP_WINDOW_MS + 1), 'lastA', '窗口过后要放行');
  });
});

test('LN-03 🔴 反向三：没记住过 → 不跳（不许跳到空路径或造一个假笔记名）', () => {
  withStorage(() => {
    assert.equal(lastNoteToResume(true), null, '没有历史就不该跳');
  });
});

/* ---------------- LN-04 校验口径 ---------------- */

test('LN-04 🔴 笔记名校验照老项目 :10154（容许大写首字符与 1 字符短名）', () => {
  // 🔴 这条是老项目与 bj 服务端那条更严正则的分歧点：
  //   服务端是 /^[a-z0-9][a-z0-9_-]{0,63}$/（还兼挡路径穿越），
  //   而这里必须用老项目出码侧口径 /^[A-Za-z0-9_-]{1,64}$/。
  //   照抄服务端那条 ⇒ 静默剔掉本机真的打得开的那几条
  //   （bj sanitizeNoteName 只剔非法字符、保留大小写）。
  for (const ok of ['A', 'a', 'Z9', 'myNote', 'my_note-1', 'A'.repeat(64)]) {
    assert.equal(isUsableNoteId(ok), true, `${JSON.stringify(ok)} 应算合法`);
  }
  for (const bad of ['', 'a'.repeat(65), 'a b', '笔记', '../x', 'a/b', 'x?y']) {
    assert.equal(isUsableNoteId(bad), false, `${JSON.stringify(bad)} 应算非法`);
  }
});

/* ---------------- LN-05 接线：三处写入（老项目 v5.57 的教训） ---------------- */

/*
 * 🔴🔴🔴 这三条是本文件**最承重**的结构性判据：它们防的是"实现写了但没接线"。
 *   症状是"手输口令能恢复、扫码进来的设备恢复不了"，用户完全无法自查。
 *
 * 🔴🔴🔴 定位必须用**每条路径独有的上下文锚点**，不能用裸的 `rememberLastNote(name)`：
 *   初版就写成 `[/rememberLastNote\(\s*name\s*\)/]` 匹配"应有两处"，
 *   结果删掉其中一处仍然数到一处 ⇒ **恒绿**（我做过这个变异测试，是它抓到的）。
 *   教训与"恒真断言 = 没有断言"同源：只要两个不同的坏掉方式能让断言同样通过，
 *   这条断言就没有区分力。
 *   ⇒ 现在三条各自锚在**紧邻的独有语句**上（pendingFresh / replaceState / goto 门控）。
 */
test('LN-05 🔴🔴 三条解锁路径各写一次 last note（口令 / 扫码 / 记忆解锁）', () => {
  const code = codeOf('src/main.ts');
  // 每条 = [标签, 该路径独有的相邻语句, 写入调用]。写入必须出现在该语句**之后**的 200 字符内。
  const spots = [
    [
      '口令解锁 showPass.onSubmit',
      /sessionPass = pass;/,
      /rememberLastNote\(\s*name\s*\)/,
    ],
    [
      '扫码配对落地 handleScanRaw',
      /history\.replaceState\(\{\}, '', '\/' \+ encodeURIComponent\(noteId\)\);/,
      /rememberLastNote\(\s*noteId\s*\)/,
    ],
    [
      '记忆解锁 route（记住密钥那条）',
      /if \(rec\.passphrase\) sessionPass = rec\.passphrase;/,
      /rememberLastNote\(\s*name\s*\)/,
    ],
  ];
  const missing = [];
  for (const [label, anchor, call] of spots) {
    const m = anchor.exec(code);
    if (!m) {
      missing.push(`${label}（锚点都没找到，判据自身可能已过期）`);
      continue;
    }
    // 🔴 窗口必须**双向**：三条路径里，口令与记忆解锁的写在锚点**之后**，
    //   而扫码那条写在 `replaceState` **之前**（先记住、后拉正地址栏）。
    //   只往后看会把"扫码没接"误报成"没接"，只往前看则会漏掉前两条。
    const around = code.slice(Math.max(0, m.index - 240), m.index + 400);
    if (!call.test(around)) missing.push(label);
  }
  assert.deepEqual(
    missing,
    [],
    `这些解锁路径没接rememberLastNote：${missing.join(', ')}（老项目 v5.57：只写一处是真 bug）`,
  );
});

test('LN-05 🔴 反向：页面挂载**不得**无条件写（否则扫码落地前就记了错的一篇）', () => {
  const code = codeOf('src/main.ts');
  // 断言"没有把 rememberLastNote 挂进 mountEditor 这类无条件位置"：
  // mountEditor 是「任何进编辑器路径都会走」的收敛点，在那里写等于
  // "route还没判完就记住了"，破坏 lastNoteToResume 的语义。
  const mountStart = code.indexOf('function mountEditor');
  assert.ok(mountStart > 0, '应能找到 mountEditor');
  const mountHead = code.slice(mountStart, mountStart + 1200);
  assert.ok(
    !/rememberLastNote/.test(mountHead),
    'mountEditor 里不得写 last note —— 那是收敛点，写在这里等于无条件写',
  );
});

/* ---------------- LN-06 三处抑制标记 ---------------- */

test('LN-06 🔴🔴 三处都打抑制标记（菜单回首页 / 口令框关闭 / pagehide）', () => {
  const code = codeOf('src/main.ts');
  // ① 菜单 onHome：必须在 history.pushState 之前（先打标记再导航）
  const onHome = code.slice(code.indexOf('onHome:'), code.indexOf('onHome:') + 260);
  assert.ok(/markJumped\(\)/.test(onHome), '菜单回首页必须打抑制标记');
  assert.ok(
    onHome.indexOf('markJumped()') < onHome.indexOf("pushState"),
    '必须先打标记再改地址（老项目 :8038-8040 的顺序）',
  );
  // ② 口令框 onClose：与onHome 是同一段代码形状，用剩余出现次数兜
  assert.ok(
    (code.match(/markJumped\(\)/g) || []).length >= 3,
    'pagehide / onHome / 口令框 onClose 三处都要打（老项目 :10084/:8038/:10104）',
  );
  // ③ pagehide：必须**并入**现有 handler，不许注册第二个监听器
  const pagehideIdx = code.indexOf('pagehideHandler = () =>');
  assert.ok(pagehideIdx > 0, '应能找到 pagehideHandler');
  const handler = sliceBlock(code, pagehideIdx);
  assert.ok(/markJumped\(\)/.test(handler), 'pagehide handler 里必须打抑制标记');
  assert.ok(
    !/addEventListener\(\s*'pagehide'/.test(handler),
    '不得在 handler 内部再注册第二个 pagehide 监听器（会与现有的叠加）',
  );
});

test('LN-06 🔴🔴 pagehide handler 必须先摘旧 listener（既有 bug：摘的是刚赋的新值）', () => {
  const code = codeOf('src/main.ts');
  const idx = code.indexOf('pagehideHandler = () =>');
  assert.ok(idx > 0, '应能找到 pagehideHandler');
  // 赋值之前必须已有一次 removeEventListener
  const before = code.slice(Math.max(0, idx - 400), idx);
  assert.ok(
    /removeEventListener\(\s*'pagehide'/.test(before),
    '赋值新 handler 前必须先摘掉上一份 —— 否则每次切笔记都多挂一个监听器（旧闭包持有已 stop 的 SyncClient）',
  );
});

/* ---------------- LN-07 route 两个分支都要接 ---------------- */

test('LN-07 🔴🔴 route() 的**两个**空路径分支都要试恢复（bj 比老项目多一个兜底）', () => {
  const code = codeOf('src/main.ts');
  const routeStart = code.indexOf('function route()');
  assert.ok(routeStart > 0, '应能找到 route()');
  const route = code.slice(routeStart, routeStart + 1400);
  // bj 拆成 raw==='' 与 sanitize 后==='' 两个分支，两者都要调 tryResumeLastNote
  const calls = (route.match(/tryResumeLastNote\(\)/g) || []).length;
  assert.equal(calls, 2, `route() 里应有两处 tryResumeLastNote（空路径 + sanitize后为空），实际 ${calls}`);
  // 每处都必须 return，否则落地页会闪一下又被跳走
  assert.equal(
    (route.match(/if \(tryResumeLastNote\(\)\) return;/g) || []).length,
    2,
    '两处都必须 `if (tryResumeLastNote()) return;`',
  );
});

test('LN-07 🔴 反向：tryResumeLastNote 必须在网页端立刻返回 false（守卫在函数内）', () => {
  const code = codeOf('src/main.ts');
  const start = code.indexOf('function tryResumeLastNote');
  assert.ok(start > 0, '应能找到 tryResumeLastNote');
  const fn = code.slice(start, start + 500);
  assert.ok(/isNativeApp\(\)/.test(fn), '必须用 isNativeApp() 判原生（不是那个从无赋值的 __NOTESYNC_NATIVE__）');
  assert.ok(/lastNoteToResume\(\s*isNativeApp\(\)\s*\)/.test(fn), '必须把 isNativeApp() 的现读结果传进去');
  assert.ok(/location\.assign\(/.test(fn), '用 assign 而非 replace（留历史，返回键可回首页换笔记，老项目 :10156）');
  assert.ok(
    !/location\.replace\(/.test(fn),
    '不得用 replace —— 那会让返回键直接退出 App（老项目 :10150注释明确说要留历史）',
  );
});

test('LN-07 🔴 不得在 head/index.html 里加内联抢跳（与原生 loadUrl 竞速）', () => {
  // 老项目自己踩过这个坑：MainActivity.java:470-474 的"v6.3 P1 根治「点通知有时进错笔记」"
  // 整段就是在修「JS 的 location.assign 与原生 loadUrl 竞速」。
  // bj 的 capacitor.config.json 有 server.url（首屏加载线上根页），竞速条件完全成立。
  const html = readFileSync(new URL('../../../tools/build.mjs', import.meta.url), 'utf8');
  assert.ok(
    !/notesync_jumped|lastNoteToResume|last-note/.test(html),
    'build.mjs 的 indexHtml 模板里不得注入抢跳脚本（与原生 loadUrl 竞速，老项目 v6.3 已栽过）',
  );
});

/* ---------------- LN-08 数值陷阱：Number(null) 是 0，不是 NaN ---------------- */

/*
 * 🔴🔴 这条钉的是一个**真实踩过的坑**，不是假想：
 *   初版jumpedRecently 照老项目 :921-924 逐字写 `Number(sessionStorage.getItem(KEY))`。
 *   但 `Number(null) === 0`（不是 NaN）⇒
 *     ① `Number.isFinite(0)` 为 true ⇒ "压根没有标记"也过了 finite 守卫；
 *     ② age = now - 0 = now ⇒ 只要 now < 120s 就判定"刚跳走过"。
 *   真实时钟下 now ≈ 1.7e12，所以线上一直"恰好没事"——
 *   但设备时钟被改到很早、或测试注入固定 now 时，冷启动自动进入被**静默抑制**、零报错。
 *   这就是"在某个时刻恒不成立"的判据：它不是恒假，是恒真**只在某个时刻之外**成立。
 */
test('LN-08 🔴🔴 无标记时不得因Number(null)===0 被判成"刚跳走过"', () => {
  withStorage(() => {
    // 任何 now 都要放行 —— 包括 now=0（1970 时刻）与 now=1000 这种小值
    for (const now of [0, 1_000, 60_000, JUMP_WINDOW_MS - 1, Date.now()]) {
      assert.equal(
        jumpedRecently(now),
        false,
        `从未打过标记时，jumpedRecently(${now}) 必须 false（Number(null)===0 会把它算成 t=0）`,
      );
    }
  });
});

test('LN-08 🔴 反向：空串同样算"无标记"（某些浏览器/隐私模式会这么返回）', () => {
  withStorage(() => {
    globalThis.sessionStorage = {
      getItem: () => '',
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    assert.equal(jumpedRecently(1_000), false, '空串不得被当成 t=0');
  });
});

test('LN-08 🔴 非数字垃圾值 → 放行，不得当时间戳算', () => {
  withStorage(() => {
    globalThis.sessionStorage = {
      getItem: () => 'abc',
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    assert.equal(jumpedRecently(1_000), false, '"abc" → NaN，必须当过期放行');
  });
});