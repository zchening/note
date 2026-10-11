/**
 * 远端删除路径的「标记补铺」判据（STRAY-01~04）
 *
 * 🔴🔴 本文件的存在理由（残留缺口，审计阶段1 未修的那一条）：
 *   `main.ts` 的 `setDoc` 承载「远端/合并结果」写回，是三条回灌路径里最危险的一条。
 *   它在 IME 门控下是**裸 return**：回灌被推迟本身没错（下一轮 poll/SSE 会再送，
 *   且 base 不推进 —— P0-3 已经把 base 与回灌钉成同进同退），**错在补铺没排**。
 *
 *   症状（零报错）：另一台设备删掉一条提醒 ⇒ 合并结果到达 ⇒ 用户正好在打字
 *   ⇒ 整篇重建被拦下 ⇒ **那条下划线一直挂在屏幕上**，用户看到的就是
 *   「另一台删了，这台还显示着提醒」。补铺若只认 `latestDoc.reminders`，
 *   而 latestDoc 此刻还是**旧真源**（含该提醒）⇒ 判定"还活着" ⇒ 一个都不摘
 *   ⇒ 补铺空跑。**这就是本缺口的本体。**
 *
 * 🔴🔴 修法的边界（不许越界，越界就是数据分叉）：
 *   可以拿"待回灌真源"先做**摘标记**（unwrap 不改任何文本）；
 *   **绝不可以**顺手把 `latestDoc` 也改成待回灌的 `d` —— 树还是旧内容（含被远端
 *   删掉的正文），latestDoc 先落账而下一次按键会从**树**导出 ⇒ 已删内容复活。
 *   本文件 STRAY-04 就是把这条边界钉死（防止后来者"顺手一起改了"）。
 *
 * 🔴 判据形态说明：这四条是**源码级结构判据**（去注释后匹配），不是行为判据。
 *   理由：setDoc 是 mountEditor 闭包内的回调，Node 单测无法从外部驱动它，
 *   真机 e2e 又需要构造"远端删除 + 组字中"的同时态（成本高、易偶发）。
 *   结构判据在**变异验证**（删实现 ⇒ 转红）下同样具备抓回归的能力，
 *   见文件末尾每一条都标注了对应的变异实验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

/**
 * 剥注释（🔴 纪律：断言"某段代码存在/不存在"，输入必须去注释 ——
 * 否则注释里写着"绝不在这里写 x"会让匹配命中警告自身）。
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** 从 `openIdx` 起按大括号配对取出一个块（含两端）。 */
const balancedBlock = (s, openIdx) => {
  const start = s.indexOf('{', openIdx);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(openIdx, i + 1);
    }
  }
  return '';
};

/** 取 startSyncFor 里的那个 setDoc（文件里有两个 setDoc，取**最后**一个）。 */
const setDocIdx = SRC.lastIndexOf('setDoc: (d) => {');
assert.ok(setDocIdx > 0, '必须能在 main.ts 里定位到 setDoc: (d) => {（否则本文件所有判据都在空转）');
const SET_DOC = stripComments(balancedBlock(SRC, setDocIdx));

/** 取 scheduleStrayMarkFlush 的函数体（补铺实现本体）。 */
const flushIdx = SRC.indexOf('const scheduleStrayMarkFlush =');
assert.ok(flushIdx > 0, '必须能定位到 scheduleStrayMarkFlush');
const FLUSH = stripComments(balancedBlock(SRC, flushIdx));

/* ============ 1. setDoc 门控分支必须排补铺，且判死集合来自待回灌真源 ============ */

test('STRAY-01 setDoc 被 IME 门控拦下时必须排补铺，且以 d.reminders 为判死集合', () => {
  // 「应该有」①：门控分支里真的排了补铺（走模块级 strayFlushRef）
  assert.match(
    SET_DOC,
    /if\s*\(imeGateRef\s*&&\s*!imeGateRef\.canEditTree\(\)\)\s*\{[\s\S]{0,400}?strayFlushRef\?\.\(/,
    'setDoc 的 IME 门控分支必须排补铺（此前是裸 return ⇒ 远端删除的下划线残留）',
  );
  // 「应该有」②：判死集合来自**待回灌真源** d.reminders，不是 latestDoc.reminders
  assert.match(
    SET_DOC,
    /strayFlushRef\?\.\([^)]*?d\.reminders/,
    '补铺的判死集合必须来自待回灌真源 d.reminders（用 latestDoc 会把该提醒判成"还活着" ⇒ 补铺空跑）',
  );
  // 「不应该有」：不许退化成只传延迟（那样等于没传判死集合）
  assert.doesNotMatch(
    SET_DOC,
    /strayFlushRef\?\.\(\s*TYPE_ACTIVE_MS\s*\+\s*150\s*\)/,
    '补铺调用必须带第二参（待回灌真源的存活 id 集合）',
  );
  // 「不应该有」②：不许留着旧的`裸 return`（补铺排上后仍 return 是对的，
  //   但门控分支里不能**只有** return 而没有补铺）——由上一条「应该有①」覆盖。
});

test('STRAY-02 补铺本体必须认"待回灌真源"，且落地后取完即清', () => {
  // 「应该有」①：存在一个"待回灌"通道，且优先级高于 latestDoc
  assert.match(
    FLUSH,
    /strayPendingLive/,
    '补铺必须有 strayPendingLive 这条通路（只认 latestDoc 是本缺口的根因）',
  );
  // 「应该有」②：优先取 pending，回落才是 latestDoc
  assert.match(
    FLUSH,
    /const\s+live\s*=\s*pending\s*\?\?\s*new Set\(\(latestDoc\.reminders/,
    '存活集合必须优先取待回灌真源，回落到 latestDoc（既有 update 分支语义不变）',
  );
  // 「应该有」③：取完即清，防止污染后续轮次
  assert.match(
    FLUSH,
    /strayPendingLive\s*=\s*undefined/,
    '待回灌真源取用后必须清空（否则会拿陈旧事实去摘刚被加回来的提醒）',
  );
});

/* ============ 2. 重试路径必须把待回灌真源带下去 ============ */

test('STRAY-03 补铺顺延重试时必须回传 pending（否则重试轮退回旧真源）', () => {
  assert.match(
    FLUSH,
    /scheduleStrayMarkFlush\(\s*STRAY_FLUSH_RETRY_MS\s*,\s*pending\s*\)/,
    '重试必须回传 pending：不回传的话重试轮会退回 latestDoc（旧真源）⇒ 一个都摘不掉',
  );
});

/* ============ 3. 边界：门控分支里绝不许改写 latestDoc（防已删内容复活） ============ */

test('STRAY-04 setDoc 门控分支里不得给 latestDoc 赋值（文本回灌必须整轮推迟）', () => {
  // 只取门控分支那一段（到 return 为止），避免误伤分支外的正常赋值。
  const gate = SET_DOC.slice(
    SET_DOC.indexOf('if (imeGateRef && !imeGateRef.canEditTree())'),
    SET_DOC.indexOf('return;', SET_DOC.indexOf('if (imeGateRef && !imeGateRef.canEditTree())')),
  );
  assert.ok(gate.length > 0, '必须取到门控分支片段');
  assert.doesNotMatch(
    gate,
    /latestDoc\s*=/,
    '门控分支里不得给 latestDoc 落账 —— 树还是旧正文，先落账会让下次按键从树导出 ⇒ 已删内容复活（数据分叉）',
  );
});

/**
 * 变异验证记录（2026-10-11 实跑）：
 *  - 删掉 setDoc 门控分支里的 scheduleStrayMarkFlush(...) 那一行 ⇒ STRAY-01 红（STRAY-02/03/04 仍绿 ⇒ 判据专一）。
 *  - 把第二参改成不传（只留延迟）⇒ STRAY-01 的「不应该有」分支红。
 *  - 把 `const live = pending ?? ...` 改成只用 latestDoc ⇒ STRAY-02 红。
 *  - 把重试改成 `scheduleStrayMarkFlush(STRAY_FLUSH_RETRY_MS)`（不回传 pending）⇒ STRAY-03 红。
 *  - 在门控分支里加一行 `latestDoc = d;` ⇒ STRAY-04 红。
 * 恢复后 `MUT` 标记 grep 归零、四条全绿。
 */
