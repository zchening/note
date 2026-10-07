/**
 * 原生桥单测（REMN- 原生闹钟 / IMGSAVE- 存相册）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本文件的第一职责，是钉死**老项目 v5.55 那个 P0**：
 *
 *   notesync/www/index.html:7002-7005 注释原文：
 *   「Capacitor 7 把原生插件挂在 `window.Capacitor.Plugins` 下，**从不挂 `window.RemBridge`**
 *     —— 此前只读 `window.RemBridge`，**真机上恒为 null**，原生闹钟从未注册、通知从未发出
 *     （v5.51 起隐藏断点；**jsdom mock 恰好叫 `window.RemBridge`，测试永远绿测不出**）。」
 *
 *   那条 bug 为什么能活这么久：它**四重隐身**
 *     ① 不抛错（`if (!rb)` 静静短路）；
 *     ② 不影响页内提醒（App 开着时照样弹卡响铃）；
 *     ③ 只在"退后台 / 杀进程后到点"这条路上独有 —— 开发时撞不到；
 *     ④ ���试的 mock 名字恰好就叫 `window.RemBridge` ⇒ 100% 假绿。
 *   ⇒ 所以 REMN-01/02 不测"有没有桥"，而测**读的是哪一条路径、优先级如何**。
 *     这是 node 环境唯一能观测到的维度，也是真机唯一测不到的那一维。
 *
 * ── 判据纪律 ────────────────────────────────────────────────────────────
 *   · 全部 `import` 生产代码，**绝不把实现抄进测试**。
 *   · 断言"某段代码不存在"或"共 N 处调用"时，输入**先 stripComments 去注释**
 *     —— 本项目的注释密度极高，注释里出现的类名会让你假绿（这正是老项目那句
 *     「jsdom mock 恰好叫 window.RemBridge」的同款陷阱）。
 *   · 每条「应该有」配一条「不应该有」。
 *   · ⚠️ **本文件测不到真机**：提醒到点响铃、相册落盘都必须在APK 里验。
 *     这里能钉的只有"调用形态与守卫逻辑"。
 * ══════════════════════════════════════════════════════════════════════════
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXACT_ALARM_ASKED_KEY,
  ensureExactAlarmPermission,
  getRemBridge,
  syncRemindersToNative,
  toNativeList,
} from '../src/reminder/native-rem.ts';
import {
  getImgSaveBridge,
  nativeSaveImage,
  nativeSaveImageUrl,
} from '../src/image/native-img-save.ts';
import { COPY } from '../src/ui/copy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REM_SRC = readFileSync(resolve(HERE, '..', 'src', 'reminder', 'native-rem.ts'), 'utf8');
const REM_UI_SRC = readFileSync(resolve(HERE, '..', 'src', 'reminder', 'ui.ts'), 'utf8');
const MAIN_SRC = readFileSync(resolve(HERE, '..', 'src', 'main.ts'), 'utf8');
const VIEWER_SRC = readFileSync(resolve(HERE, '..', 'src', 'image', 'viewer.ts'), 'utf8');
const IMGSRC = readFileSync(resolve(HERE, '..', 'src', 'image', 'native-img-save.ts'), 'utf8');
const IMGK = readFileSync(
  resolve(HERE, '..', '..', '..', 'android', 'app', 'src', 'main', 'java', 'cn', 'xuyinji', 'bj', 'img', 'ImgSavePlugin.kt'),
  'utf8',
);
const REMK = readFileSync(
  resolve(HERE, '..', '..', '..', 'android', 'app', 'src', 'main', 'java', 'cn', 'xuyinji', 'bj', 'rem', 'RemPlugin.kt'),
  'utf8',
);

/**
 * 🔴🔴 **去注释后再grep** —— 纪律要求的硬前提。
 *
 *   本项目的注释里到处写着类名与文件名（"照 main.ts:866 nativeCopyImage 同款"、
 *   "老项目 :7013 的 skip-no-note 闸"…）。不去注释直接数，
 *   `import` 行、类型标注、注释里的字面量全部会被数进去 ⇒ 恒绿 ⇒ 判据报废。
 *
 *  覆盖：块注释、行注释、字符串字面量、模板字符串。
 *   （字符串也剥：文案常量里出现"saveImageUrl"同样会让人假绿。）
 *
 * @param {{ keepStrings?: boolean }} [opt]
 *   `keepStrings: true` 时**只去注释、保留字符串字面量内容**。
 *   判"文案必须明说某句话"这类断言必须用它 —— 默认模式会把句子一起抹掉。
 *   （负向断言如"不许出现「已保存」"仍用默认模式或本模式：
 *    注释里的「已保存」已被去注释干掉，剩下的才是真文案。）
 */
export function stripComments(src, opt = {}) {
  const keepStrings = opt.keepStrings === true;
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c2 === '//') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c2 === '/*') {
      i += 2;
      while (i < n && src.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      let lit = '';
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          lit += src[i];
          i += 1;
        }
        lit += src[i];
        i += 1;
      }
      i += 1;
      out += keepStrings ? lit : '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 去注释后的源码 + 按行计数（某类名出现多少次 / 出现在哪些行号）。
 *
 * @param callsOnly 默认 true = 只数 `name(` 形态（排除类型标注与定义）；
 *                  传 false 则数名字本身（`import { name }` 这种没有括号的才算）。
 */
function occurrences(src, needle, opt = {}) {
  const callsOnly = opt.callsOnly !== false;
  const clean = stripComments(src);
  const lines = clean.split('\n');
  const lines_ = [];
  let count = 0;
  lines.forEach((ln, idx) => {
    // 数的是**调用形态**：名字后面必须紧跟 `(`，否则是类型标注或定义
    const hits = callsOnly ? ln.split(needle + '(').length - 1 : ln.split(needle).length - 1;
    if (hits > 0) {
      count += hits;
      lines_.push(idx + 1);
    }
  });
  return { count, lines: lines_ };
}

/** 造一个假的 window：可分别注入 Capacitor 路径 / 裸挂路径。 */
function fakeWin(opts = {}) {
  const win = {};
  // 🔴 Plugins 对象只要**任一**桥被注入就要建起来 —— 否则 `capacitorImgSave`
  //   单注入时整个 Capacitor 路径不存在，测试会假绿成"回退生效"。
  if (opts.capacitorBridge !== undefined || opts.capacitorImgSave !== undefined) {
    const plugins = {};
    if (opts.capacitorBridge !== undefined) plugins.RemBridge = opts.capacitorBridge;
    if (opts.capacitorImgSave !== undefined) plugins.ImgSave = opts.capacitorImgSave;
    win.Capacitor = { Plugins: plugins };
  }
  if (opts.bareBridge !== undefined) win.RemBridge = opts.bareBridge;
  if (opts.bareImgSave !== undefined) win.ImgSave = opts.bareImgSave;
  if (opts.localStorage !== undefined) win.localStorage = opts.localStorage;
  return win;
}

/** 记录调用的假 sync 桥。 */
function spySync(impl) {
  const calls = [];
  const bridge = {
    sync: (o) => {
      calls.push(o);
      return impl ? impl(o) : Promise.resolve({ scheduled: o.list.length, failed: 0 });
    },
  };
  return { bridge, calls };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、桥探测：老项目 v5.55 P0 的正面战场
 * ══════════════════════════════════════════════════════════════════════════ */

test('REMN-01 🔴🔴 优先读 Capacitor.Plugins.RemBridge，不被 window.RemBridge 抢走', async () => {
  const cap = spySync();
  const bare = spySync();
  const win = fakeWin({ capacitorBridge: cap.bridge, bareBridge: bare.bridge });

  await syncRemindersToNative([{ at: new Date(Date.now() + 60000).toISOString(), text: '开会' }], 'n1', win);

  assert.equal(cap.calls.length, 1, 'Capacitor 路径必须被调用');
  assert.equal(bare.calls.length, 0, 'window.RemBridge 绝不该被优先读到（这正是老项目 v5.55 的真 bug）');
});

test('REMN-02 反向：只挂 window.RemBridge 时仍能走通（保留单测/mock 兼容）', async () => {
  const bare = spySync();
  const win = fakeWin({ bareBridge: bare.bridge });
  await syncRemindersToNative([{ at: new Date(Date.now() + 60000).toISOString(), text: 'x' }], 'n1', win);
  assert.equal(bare.calls.length, 1, 'Capacitor 缺席时应回退裸挂路径');
});

test('REMN-03 🔴 每次调用都重新读 window，绝不缓存成模块级 const', async () => {
  // 🔴老项目 :7000 注释专门提了这点：冷启动早期读一次可能拿到 undefined，
  //   缓存下来就**永久**是 undefined。老项目的 mock 能在脚本执行后再注入，
  //   靠的就是"每次现读"。这里用同一个 win 对象前后改内容来钉它。
  const win = {};
  assert.equal(getRemBridge(win), null, '一开始没有桥');

  const first = spySync();
  win.RemBridge = first.bridge;
  await syncRemindersToNative([], 'n1', win);
  assert.equal(first.calls.length, 1, '后注入的桥必须被看到（证明没有缓存成 undefined）');

  const second = spySync();
  win.RemBridge = second.bridge;
  await syncRemindersToNative([], 'n1', win);
  assert.equal(second.calls.length, 1, '换掉的桥必须被看到（证明每次都现读）');
  assert.equal(first.calls.length, 1, '旧桥不该被再调一次');
});

test('REMN-04 🔴🔴 桥不存在 ⇒ 返回 false 且 note=no-bridge，**绝不抛错**', async () => {
  const r = await syncRemindersToNative([{ at: new Date().toISOString(), text: 'x' }], 'n1', fakeWin({}));
  assert.equal(r.ok, false);
  assert.equal(r.note, 'no-bridge');
  // 口径来源：main.ts:863-864 nativeCopyImage「桥不存在时返回 false 而不是抛错」——
  // 抛错会把调用方后面的整条回退链断掉。
});

test('REMN-05 🔴 桥抛异常 ⇒ 收敛成 false / bridge-threw，**绝不外泄**', async () => {
  const bridge = {
    sync: () => Promise.reject(new Error('native boom')),
  };
  const r = await syncRemindersToNative([], 'n1', fakeWin({ bareBridge: bridge }));
  assert.equal(r.ok, false, '原生异常不许污染前端流程（老项目 :7020 同款）');
  assert.equal(r.note, 'bridge-threw');
});

test('REMN-06 🔴 反向：桥在但没有 sync 方法 ⇒ 一律当没桥', async () => {
  const win = { Capacitor: { Plugins: { RemBridge: { getVersion: () => Promise.resolve({}) } } } };
  assert.equal(getRemBridge(win), null, '只有 getVersion 的对象不算 RemBridge');
  const r = await syncRemindersToNative([], 'n1', win);
  assert.equal(r.note, 'no-bridge');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 二、传给 sync 的参数形状（**先读 Kotlin 再钉**）
 * ══════════════════════════════════════════════════════════════════════════ */

test('REMN-07 🔴🔴 参数形状 {list:[{at,text}], noteId} 与 Kotlin 侧逐字对齐', async () => {
  const s = spySync();
  const at = new Date(Date.now() + 3600_000).toISOString();
  await syncRemindersToNative([{ at, text: '买菜' }], 'myNote', fakeWin({ bareBridge: s.bridge }));

  assert.equal(s.calls.length, 1);
  const arg = s.calls[0];
  assert.deepEqual(Object.keys(arg).sort(), ['list', 'noteId'], 'sync 入参只有 list 与 noteId 两个键');
  assert.equal(arg.noteId, 'myNote');
  assert.equal(arg.list.length, 1);
  assert.deepEqual(Object.keys(arg.list[0]).sort(), ['at', 'text'], '每项只有 at / text 两个键');
});

test('REMN-08 🔴🔴 `at` 必须是 epoch 毫秒而不是 ISO 串（照 Kotlin optLong 钉）', async () => {
  // 🔴 这是本次移植里最容易静默坏掉的一处：
  //   Kotlin RemPlugin.kt:266 `o.optLong("at", 0)` —— Long。
  //   bj 真源里 Reminder.at 是**完整 ISO 带偏移**（shared-schema/types.ts:61铁律）。
  //   漏转换的后果：`optLong` 拿 ISO 串解析失败 ⇒ 0 ⇒ 被 :268
  //   `if (at > now - 60_000L)` 全判死 ⇒ scheduled=0 ⇒ **一条闹钟都不排，且零报错**。
  const s = spySync();
  const iso = '2027-03-01T10:00:00.000+08:00';
  await syncRemindersToNative([{ at: iso, text: '开会' }], 'n1', fakeWin({ bareBridge: s.bridge }));

  const got = s.calls[0].list[0].at;
  assert.equal(typeof got, 'number', 'at 必须是 number，不能是 ISO 串');
  assert.equal(got, Date.parse(iso), '必须是 Date.parse 出来的 epoch 毫秒');
  assert.notEqual(got, 0, '🔴 at 为 0 会被原生 60s 容差判死 —— 这是最坏的静默失效');
});

test('REMN-09 🔴 非法的 at 被剔除而不是原样送出去（NaN 会让原生判死）', () => {
  assert.deepEqual(toNativeList([{ at: 'not-a-date', text: 'x' }]), [], 'Date.parse 出来 NaN 的必须剔掉');
  const good = toNativeList([
    { at: '2027-03-01T10:00:00.000Z', text: 'ok' },
    { at: '坏时间', text: 'drop' },
  ]);
  assert.equal(good.length, 1);
  assert.equal(good[0].text, 'ok');
});

test('REMN-10 🔴 noteId 为空 ⇒ 整条跳过（老项目 :7013 skip-no-note 闸）', async () => {
  // 🔴 为什么这道闸是承重的：空串在原生侧是 "" 分区（partCipher("")）。
  //   RemPlugin.kt:274 只按 nid 清本分区闹钟 ⇒ 传空串 = 清首页分区、
  //   碰不到具名分区的闹钟 ⇒ 既没排上新的、也没取消旧的，纯污染。
  const s = spySync();
  const r = await syncRemindersToNative([{ at: new Date().toISOString(), text: 'x' }], '', fakeWin({ bareBridge: s.bridge }));
  assert.equal(r.ok, false);
  assert.equal(r.note, 'skip-no-note');
  assert.equal(s.calls.length, 0, '闸拦住时绝不该碰原生');
});

test('REMN-11 🔴 原生回报 scheduled 原样带出（scheduled=0 要能分辨出来）', async () => {
  // 老项目 :7016-7019 记这条诊断的理由：「scheduled=0 时能分辨
  // 『没同步过 / 同步了但全部过期 / 桥异常』」。bj 把它落在返回值上。
  const bridge = { sync: () => Promise.resolve({ scheduled: 0, failed: 0 }) };
  const r = await syncRemindersToNative([], 'n1', fakeWin({ bareBridge: bridge }));
  assert.equal(r.note, 'synced');
  assert.equal(r.scheduled, 0, 'scheduled=0 是有效诊断值，不能被当成 undefined 吞掉');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 三、精确闹钟权限（对齐 Kotlin requestExactAlarm）
 * ══════════════════════════════════════════════════════════════════════════ */

test('REMN-12 🔴 引导一次就够，第二次直接不再调原生（老项目 :7026 localStorage 标记）', async () => {
  // 🔴 为什么只能一次：RemPlugin.kt:356-361 的 requestExactAlarm 会
  //   `startActivity`跳系统设置页。每次进来都跳 = 用户被反复打断。
  let asked = 0;
  const bridge = {
    sync: () => Promise.resolve({}),
    requestExactAlarm: () => {
      asked += 1;
      return Promise.resolve({ canScheduleExactAlarms: true });
    },
  };
  const map = new Map();
  const ls = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, String(v)) };
  const win = fakeWin({ bareBridge: bridge, localStorage: ls });

  const a = await ensureExactAlarmPermission(win);
  const b = await ensureExactAlarmPermission(win);

  assert.equal(a, true, '首次应回报能否排精确闹钟');
  assert.equal(asked, 1, '原生只该被调一次');
  assert.equal(b, false, '第二次不再跳设置页');
  assert.ok(ls.getItem(EXACT_ALARM_ASKED_KEY) === '1', '要写引导标记');
});

test('REMN-13 🔴 桥不存在 / 抛错 ⇒ 一律 false，绝不抛', async () => {
  assert.equal(await ensureExactAlarmPermission(fakeWin({})), false);
  const boom = {
    sync: () => Promise.resolve({}),
    requestExactAlarm: () => Promise.reject(new Error('no activity')),
  };
  const ls = { getItem: () => null, setItem: () => {} };
  assert.equal(await ensureExactAlarmPermission(fakeWin({ bareBridge: boom, localStorage: ls })), false);
});

test('REMN-14 🔴 反向：localStorage 不可用（隐私模式）也不许抛', async () => {
  const bridge = { sync: () => Promise.resolve({}), requestExactAlarm: () => Promise.resolve({ canScheduleExactAlarms: true }) };
  const badLs = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  const r = await ensureExactAlarmPermission(fakeWin({ bareBridge: bridge, localStorage: badLs }));
  assert.equal(r, true, '读不到标记时当作没引导过，继续引导');
});

test('REMN-15 🔴 标记键必须是 bj 前缀，绝不复用老项目的 notesync_exact_alarm_asked', () => {
  // 🔴 与 FAV-01 同款纪律：bj 的 storage 键一律 notesync_bj_ 前缀（见 favs.ts）。
  //   复用老项目键名会让"升级过的用户"莫名被判成已引导过。
  assert.match(EXACT_ALARM_ASKED_KEY, /^notesync_bj_/);
  assert.notEqual(EXACT_ALARM_ASKED_KEY, 'notesync_exact_alarm_asked');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 四、接线：全部调用点都在（先stripComments 再数）
 * ══════════════════════════════════════════════════════════════════════════ */

test('REMN-16 🔴🔴 调用点齐备：ReminderUI.schedule / mountEditor / 改口令 / setDoc 四处', () => {
  // 老项目 8 处调用点 → bj 的对应表见交付报告。bj 的收口是
  //   `ReminderUI.schedule()`（真源变了就重排的唯一入口）+ 三处显式补挂。
  const ui = occurrences(REM_UI_SRC, 'schedule');
  const main = occurrences(MAIN_SRC, 'reminderRef?.schedule');

  // schedule() 定义 1 处+ 内部调用若干；关键是**它内部必须调 syncNative**
  const uiClean = stripComments(REM_UI_SRC);
  assert.match(
    uiClean,
    /schedule\(\)\s*:\s*void\s*\{\s*this\.rearm\(\);\s*void this\.syncNative\(\);/,
    'schedule() 必须同时排页内定时器与原生闹钟',
  );

  assert.ok(ui.count >= 1, 'ReminderUI 里要有 schedule');
  // setDoc 路径：远端合并/采纳远端/采纳本机后必须重排（老项目 5901/5939/7287）
  //   🔴 收在编辑器 update 回调的末尾（`},` 收口），所以形如
  //   `reminderRef?.schedule();` 后紧跟一层缩进的 `},`。
  const mainClean = stripComments(MAIN_SRC);
  assert.match(
    mainClean,
    /editor\?\.update\([\s\S]{0,2000}?reminderRef\?\.schedule\(\);\s*\n\s{4}\},/,
    'setDoc 回调（editor.update 之后）必须显式重排',
  );
  // 精确闹钟权限引导：mountEditor 里一次
  //   （数的是"名字出现过几次"而不是 `name(` 形态 —— import 行没有括号，
  //     用调用形态数会把 import 漏掉，得到 1 < 2 的假红。）
  assert.ok(
    occurrences(MAIN_SRC, 'ensureExactAlarmPermission', { callsOnly: false }).count >= 2,
    'main.ts 里应有 import + 调用两处 ensureExactAlarmPermission',
  );
  assert.ok(main.count >= 3, `schedule() 至少三处显式调用（mountEditor / setDoc / 改口令），实得 ${main.count}`);
  // 改口令那条：老项目 :8339
  const cpIdx = mainClean.indexOf('doChangePassphrase');
  assert.ok(cpIdx > 0 && mainClean.slice(cpIdx).includes('reminderRef?.schedule();'), '改口令成功后必须重排（老项目 :8339）');
});

test('REMN-17 🔴 反向：定时器自己醒来只能走 fireScheduled→rearm，绝不能重排原生闹钟', () => {
  // 🔴 照老项目 :7551 fireReminder 的口径：响完铃重新排程**不**带
  //   syncRemindersToNative。若写成 `setTimeout(() => this.schedule(), wait)`，
  //   每响一次铃就重排一次原生闹钟（无谓的 Keystore 加解密 + setAlarmClock）。
  //   🔴 2026-10-08 Bug7 改造后回调是 fireScheduled（fire + rearm），
  //   「不重排原生」的不变量不变，钉的结构随接线更新。
  const clean = stripComments(REM_UI_SRC);
  assert.match(clean, /setTimeout\(\(\)\s*=>\s*this\.fireScheduled\(\),\s*wait\)/, '定时器回调必须是 fireScheduled');
  // fireScheduled 本体：先 fire 为它而设的那条（pickFireableAt），再 rearm，且不碰原生
  assert.match(clean, /for \(const r of pickFireableAt\(due, target, this\.firedIds\)\) this\.fire\(r\);/, '唤醒只 fire 为它而设的那条（Bug7）');
  const fireScheduledBody = clean.match(/private fireScheduled\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(fireScheduledBody.includes('this.rearm()'), '唤醒后必须重新排程下一条');
  assert.ok(!fireScheduledBody.includes('syncNative'), '唤醒路径不得同步原生闹钟');
  assert.ok(!fireScheduledBody.includes('this.schedule()'), '唤醒路径不得走 schedule（会重复同步原生）');
});

test('REMN-18 🔴 桥探测的源码形态：Capacitor 在前、裸挂在后（顺序钉死）', () => {
  // 这一条是给"下一个人"看的：谁把 ?? 两边调个顺序，老项目 v5.55 就回来了。
  const clean = stripComments(REM_SRC);
  const m = clean.match(/viaCapacitor[\s\S]{0,120}?\?\?/);
  assert.ok(m, '必须先用 Capacitor 路径再回退');
  assert.match(clean, /w\.Capacitor\?\.Plugins\?\.RemBridge/, '必须读 window.Capacitor.Plugins.RemBridge');
  assert.match(clean, /w\.RemBridge/, '必须保留 window.RemBridge 回退');
});

test('REMN-19 🔴 反向：源码里不许出现「缓存桥」的模块级 const', () => {
  // 老项目 :7000 注释点名的反面：缓存成const 后jsdom 注入的 mock 永远读不到。
  const clean = stripComments(REM_SRC);
  assert.doesNotMatch(clean, /const\s+\w*[Bb]ridge\w*\s*=/, '不许把桥缓存成模块级 const');
});

test('REMN-20 🔴 与 Kotlin 侧对齐：三处签名逐字对得上（防止原生改了客户端没跟）', () => {
  // 直接读 Kotlin 源码做交叉验证 —— 这样原生改了签名而客户端没跟，判据会红。
  assert.match(REMK, /@CapacitorPlugin\(name = "RemBridge"\)/, '插件名必须是 RemBridge');
  assert.match(REMK, /call\.getArray\("list"\)/, 'sync 收list（决定入参必须是 {list}）');
  assert.match(REMK, /call\.getString\("noteId"\)/, 'sync 收 noteId');
  assert.match(REMK, /o\.optLong\("at", 0\)/, 'at 在原生是 Long ⇒ TS 必须送number');
  assert.match(REMK, /ret\.put\("scheduled", scheduled\)/, '返回带 scheduled');
  assert.match(REMK, /fun requestExactAlarm/, 'requestExactAlarm 存在');
  assert.match(REMK, /ret\.put\("canScheduleExactAlarms", canExact\)/, '返回带 canScheduleExactAlarms');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 五、ImgSave 存相册
 * ══════════════════════════════════════════════════════════════════════════ */

function spyImgSave(impl) {
  const calls = { url: [], b64: [] };
  const bridge = {
    saveImageUrl: (o) => {
      calls.url.push(o);
      return impl ? impl.url(o) : Promise.resolve({ ok: true, path: 'content://x' });
    },
    saveImage: (o) => {
      calls.b64.push(o);
      return impl ? impl.b64(o) : Promise.resolve({ ok: true, path: '/x.png' });
    },
  };
  return { bridge, calls };
}

test('IMGSAVE-01 🔴🔴 优先读 Capacitor.Plugins.ImgSave，不被 window.ImgSave 抢走', async () => {
  const cap = spyImgSave();
  const bare = spyImgSave();
  const win = fakeWin({ capacitorImgSave: cap.bridge, bareImgSave: bare.bridge });

  await nativeSaveImageUrl('https://x.test/a.png', win);
  assert.equal(cap.calls.url.length, 1, 'Capacitor 路径必须被调用');
  assert.equal(bare.calls.url.length, 0, 'window.ImgSave 绝不该被优先读到');
});

test('IMGSAVE-02 🔴 第①档只认 https：非https 直接跳过（原生 :74 硬约束）', async () => {
  const s = spyImgSave();
  const win = fakeWin({ capacitorImgSave: s.bridge });
  assert.equal(await nativeSaveImageUrl('data:image/png;base64,AAA', win), null);
  assert.equal(await nativeSaveImageUrl('http://x.test/a.png', win), null, 'http 也要跳过（原生只收 https://）');
  assert.equal(s.calls.url.length, 0, '不该白跑一趟原生');
});

test('IMGSAVE-03 🔴 第①档参数形状 {url}，成功回传原结果', async () => {
  const s = spyImgSave();
  const win = fakeWin({ capacitorImgSave: s.bridge });
  const r = await nativeSaveImageUrl('https://x.test/a.png', win);
  assert.deepEqual(Object.keys(s.calls.url[0]), ['url']);
  assert.equal(r.ok, true);
});

test('IMGSAVE-04 🔴 第②档参数形状 {base64,mime}，base64 不带 data: 前缀', async () => {
  // 🔴 Kotlin 侧 `Base64.decode(b64, DEFAULT)` 直接解；带 "data:image/png;base64," 前缀
  //   会解出一堆垃圾字节 → 落盘一张坏图（而 `ok:true`，用户以为成功了）。
  const s = spyImgSave();
  const win = fakeWin({ capacitorImgSave: s.bridge });
  const r = await nativeSaveImage('QUJD', 'image/png', win);
  assert.deepEqual(Object.keys(s.calls.b64[0]).sort(), ['base64', 'mime']);
  assert.equal(s.calls.b64[0].base64, 'QUJD');
  assert.equal(s.calls.b64[0].mime, 'image/png');
  assert.equal(r.ok, true);
});

test('IMGSAVE-05 🔴🔴 原生回 {ok:false}（不是抛错）必须判成失败', async () => {
  // 🔴 ImgSavePlugin 全程 `call.resolve` 从不 `call.reject`（:63/:133）——
  //   失败也是 resolve 出来的 {ok:false, error}。
  //   只判"没抛异常"会把 {ok:false} 当成功 ⇒ 用户看到「已存入相册」而相册里啥也没有，
  //   那正是本项目最防的"静默失败"。
  const s = spyImgSave({ url: () => Promise.resolve({ ok: false, error: 'download-failed' }), b64: () => Promise.resolve({ ok: false, error: 'save-failed' }) });
  const win = fakeWin({ capacitorImgSave: s.bridge });
  assert.equal(await nativeSaveImageUrl('https://x.test/a.png', win), null);
  assert.equal(await nativeSaveImage('QUJD', 'image/png', win), null);
});

test('IMGSAVE-06 🔴 桥不存在 / 抛错⇒ 一律 null，绝不抛（保住回退链）', async () => {
  //口径来源：viewer.ts 原注释「老项目栽过：抛错会把整条回退链断掉」
  //   + main.ts:863-864 nativeCopyImage 同款。
  assert.equal(await nativeSaveImageUrl('https://x.test/a.png', fakeWin({})), null);
  const boom = {
    saveImage: () => Promise.reject(new Error('boom')),
    saveImageUrl: () => Promise.reject(new Error('boom')),
  };
  const win = fakeWin({ capacitorImgSave: boom });
  assert.equal(await nativeSaveImageUrl('https://x.test/a.png', win), null);
  assert.equal(await nativeSaveImage('QUJD', 'image/png', win), null);
});

test('IMGSAVE-07 🔴 反向：只有 saveImageUrl 没有 saveImage 的对象不算桥', () => {
  // 老壳（v9.2.0 之前）根本没有 ImgSave；v9.3.0 加了 saveImageUrl。
  //   若按 saveImageUrl 判存在，新壳上判错；若按 saveImage 判，老壳上判错——
  //   所以判据是**初版接口 saveImage**（native-img-save.ts 注释里写明了这条理由）。
  assert.equal(getImgSaveBridge({ Capacitor: { Plugins: { ImgSave: { saveImageUrl: () => Promise.resolve({}) } } } }), null);
  assert.ok(getImgSaveBridge({ Capacitor: { Plugins: { ImgSave: { saveImage: () => Promise.resolve({}) } } } }));
});

test('IMGSAVE-08 🔴🔴 源码形态：原生两档必须排在分享面板**之前**（老项目 :5561 定稿）', () => {
  const clean = stripComments(VIEWER_SRC);
  const iUrl = clean.indexOf('nativeSaveImageUrl(src)');
  const iB64 = clean.indexOf('nativeSaveImage(');
  const iShare = clean.indexOf('navigator.share(');
  const iDownload = clean.indexOf("a.download");

  assert.ok(iUrl > 0, 'viewer 必须调第①档');
  assert.ok(iB64 > 0, 'viewer 必须调第②档');
  assert.ok(iShare > 0, '分享面板仍在');
  assert.ok(iDownload > 0, '<a download> 仍在');
  assert.ok(iUrl < iShare, '🔴 第①档必须排在分享面板之前');
  assert.ok(iB64 < iShare, '🔴 第②档必须排在分享面板之前');
});

test('IMGSAVE-09 🔴🔴 成功文案必须说清落在哪（老项目 :5564 逐字）', () => {
  // 🔴 只说"已保存"的话，用户第一件事是去相册里翻，找不到就判"这功能坏了"。
  //   ImgSavePlugin.kt:142 落盘目录是 Pictures/NoteSync，所以文案要带上它。
  assert.equal(COPY.imgSaveAlbumOk, '已存入相册 Pictures/NoteSync');
  assert.ok(stripComments(VIEWER_SRC).includes('imgSaveAlbumOk'), 'viewer 成功路径要用这句');
});

test('IMGSAVE-10 🔴 反向：最后一级失败必须明说，不许出现「已保存」字样', () => {
  // bj viewer.ts 自己的品质口径：「两条都拿不到结果时必须明说，
  //   不能给『已保存』然后什么都没发生」。接了原生桥也不能把这个品质引进回退链。
  // 🔴 这里**必须 keepStrings** —— 默认模式把字符串抹成 ""，
  //   `/已保存/` 永远匹配不上 ⇒ 判据恒绿 ⇒ 等于没写（正是本项目最防的假绿）。
  const clean = stripComments(VIEWER_SRC, { keepStrings: true });
  // 只切 saveImageToAlbum 那个函数：文件后面还有看图菜单的一堆 catch，
  // 全文件 lastIndexOf('catch') 会捞到无关的 catch，断言就落空了。
  const fnStart = clean.indexOf('function saveImageToAlbum');
  assert.ok(fnStart > 0, 'viewer 里有 saveImageToAlbum');
  const fnEnd = clean.indexOf('\nfunction ', fnStart + 1);
  const fn = clean.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
  const lastCatch = fn.slice(fn.lastIndexOf('catch'));
  assert.doesNotMatch(lastCatch, /已保存/, '末级失败文案里不许出现「已保存」');
  assert.match(lastCatch, /这台设备无法直接保存，请长按图片另存/, '末级必须明说');
  // 反向自检：keepStrings 真的把字符串留下了（否则上面两条都是空断言）
  assert.match(fn, /note-image\.png/, 'keepStrings 生效自检');
  // 同理，④ 那级的「已触发下载」也不能写成「已保存」
  assert.doesNotMatch(fn, /flashStatus\('已保存/, '任何一级的 flashStatus 都不许写「已保存」');
});

test('IMGSAVE-11 🔴 与 Kotlin 侧对齐：saveImage/saveImageUrl 签名逐字对得上', () => {
  assert.match(IMGK, /@CapacitorPlugin\(name = "ImgSave"\)/);
  assert.match(IMGK, /fun saveImage\(call: PluginCall\)/);
  assert.match(IMGK, /call\.getString\("base64"\)/);
  assert.match(IMGK, /call\.getString\("mime"\)/);
  assert.match(IMGK, /fun saveImageUrl\(call: PluginCall\)/);
  assert.match(IMGK, /call\.getString\("url"\)/);
  // 🔴 全程 resolve 不reject —— 判据 IMGSAVE-05 的前提
  assert.doesNotMatch(IMGK, /call\.reject\(/, 'ImgSave 全程 resolve（所以失败也是 {ok:false}）');
  assert.match(IMGK, /DIRECTORY_PICTURES \+ "\/NoteSync"/, '落盘目录要与文案里的 Pictures/NoteSync 一致');
});

test('IMGSAVE-12 🔴 反向：ImgClip 复制那条路不被重复实现', () => {
  // 用户明确要求：ImgClip（导出长图复制）已在main.ts:855-875 接好，别重复做。
  //   本次只加 ImgSave 两个方法，不得碰 copyImage。
  assert.doesNotMatch(stripComments(IMGSRC), /copyImage/, 'native-img-save 不得碰 ImgClip 的方法');
  assert.match(stripComments(IMGSRC), /saveImageUrl/, 'native-img-save 只管存相册');
});