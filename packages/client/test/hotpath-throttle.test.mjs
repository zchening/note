/**
 * P1-13（客户端侧）：热路径的纯诊断开销必须被节流 —— 判据 HOT-01~02
 *
 * 🔴🔴 存在理由：`main.ts` 的 update listener 是**每个 update 都跑**（零 debounce），
 *   里面曾无条件执行一次 `JSON.stringify(latestDoc)` + `TextEncoder` ——
 *   5000 字约 0.3ms/键，中端安卓 ×5 就吃掉按键预算的一大块。
 *   而全仓**没有任何消费方**读 `lastDocBytes`（grep 零命中），
 *   它是纯留给人工排查的诊断值 ⇒ 完全可以节流，语义不变。
 *
 * 🔴 判据形态：源码级结构判据（去注释后匹配）。
 *   这是性能改动，没有可断言的行为差异；用结构判据 + 变异验证守住"别被改回去"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

/** 剥注释（纪律：结构判据的输入必须去注释，否则会命中注释里的反例字样）。 */
const CODE = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test('HOT-01 lastDocBytes 的写入必须在节流闸门内（不许每键全量序列化）', () => {
  // 「应该有」：存在一个基于时间戳差的节流条件，且写入在它里面
  assert.match(
    CODE,
    /if\s*\(\s*bytesNow\s*-\s*lastDocBytesAt\s*>=\s*250\s*\)\s*\{[\s\S]{0,200}?lastDocBytes/,
    'lastDocBytes 必须在 250ms 节流内更新（此前每键一次 JSON.stringify 全文档）',
  );
  // 「不应该有」：节流条件**之外**不许再有裸写入
  const withoutGuard = CODE.replace(
    /if\s*\(\s*bytesNow\s*-\s*lastDocBytesAt\s*>=\s*250\s*\)\s*\{[\s\S]*?\n\s*\}/,
    '',
  );
  assert.doesNotMatch(
    withoutGuard,
    /dataset\.lastDocBytes\s*=/,
    '除节流分支外不许再写 lastDocBytes（否则节流形同虚设）',
  );
});

test('HOT-02 节流时间戳必须被推进（否则永远只写一次或每键都写）', () => {
  assert.match(
    CODE,
    /lastDocBytesAt\s*=\s*bytesNow/,
    '节流分支内必须推进时间戳（不推进 ⇒ 之后每一帧都满足条件 ⇒ 节流失效）',
  );
});

/**
 * 变异验证记录（2026-10-11 实跑）：
 *  - 把 `if (bytesNow - lastDocBytesAt >= 250) {` 整块去掉（恢复裸写）⇒ HOT-01 红、HOT-02 红。
 *  - 只删 `lastDocBytesAt = bytesNow;`（保留 if）⇒ HOT-02 红、HOT-01 仍绿 ⇒ 判据专一。
 * 恢复后 `MUT` grep 归零、两条全绿。
 */
