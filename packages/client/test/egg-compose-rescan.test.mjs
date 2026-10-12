/**
 * 数字梗组字补扫接线判据（RESCAN-01/02）—— v3.1.1 治「IME 组字提交后数字梗不放动画」
 *
 * 🔴🔴 纪律（同 WIRE 系）：
 *   · 源码级结构判据：剥注释后按窗口截取再断言，不抄实现、不猜行号；
 *   · 每条"应该有"配一条"不应该有"；
 *   · 变异验证（文件尾注释）：把 editorHost 的 compositionend 监听块整体删掉
 *     ⇒ RESCAN-01 必须红（e2e EGG-E16 同拍红：提交后 waitBurst 超时）。
 *
 * 🔴 行为判据（真浏览器）在 e2e 08-egg EGG-E16；本文件只钉「补扫别被回填掉」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

/** 逐字符扫描剥注释（保字符串字面量）—— 与 draft-wiring.test.mjs 同款实现。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += c; i++; continue; }
      if (c === '"') { mode = 'dq'; out += c; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; } else { i++; } continue; }
    if (mode === 'sq') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === "'") mode = 'code';
      out += c; i++; continue;
    }
    if (mode === 'dq') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '"') mode = 'code';
      out += c; i++; continue;
    }
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') mode = 'code';
    out += c; i++; continue;
  }
  return out;
}

const main = stripComments(read('packages/client/src/main.ts'));

/* ============ RESCAN-01 组字提交后的补扫监听在位 ============ */

/**
 * editorHost 上不止一个 compositionend 监听（flight 取证 :2078、compose 守卫 :2080、
 * 补扫 :2190 附近）—— 🔴 不能用 indexOf 锚第一个：那会钉到别人的监听块。
 * 遍历全部匹配位置，**任一窗口**同时含三特征即判补扫在位。
 */
function findRescanBlock(code) {
  const NEEDLE = "editorHost.addEventListener('compositionend'";
  let i = code.indexOf(NEEDLE);
  while (i >= 0) {
    const block = code.slice(i, i + 1200);
    if (
      block.includes('setTimeout') &&
      block.includes('ed.isComposing()') &&
      block.includes('scanEggTriggers(eggLayer)')
    ) {
      return block;
    }
    i = code.indexOf(NEEDLE, i + 1);
  }
  return null;
}

test('RESCAN-01 editorHost 有 compositionend 补扫：setTimeout(0) → isComposing 闸 → scanEggTriggers', () => {
  const block = findRescanBlock(main);
  assert.ok(
    block,
    'editorHost 上没有任何一个 compositionend 监听同时带 setTimeout+isComposing 闸+scanEggTriggers（补扫被回填掉了？组字路径的数字梗会整体哑火）',
  );
});

/* ============ RESCAN-02 补扫不许带「文本真变」闸 ============ */

test('RESCAN-02 补扫块里不许出现 eggTextChanged 判定（lastEggText 已被挡掉的那帧更新过）', () => {
  const block = findRescanBlock(main);
  assert.ok(block, '补扫块缺失（RESCAN-01 会先红）');
  // 🔴 不应该有：被挡的提交帧已把 lastEggText 推进到最新值，
  //   补扫若再判 eggTextChanged 恒 false —— 等于给补扫也上了一个永关的闸。
  //   去重的正确位置是 gagFire 的闩锁，不是文本比对。
  assert.ok(
    !block.includes('eggTextChanged'),
    '补扫不许判 eggTextChanged —— lastEggText 已被挡掉的那帧更新，判定恒 false 等于永关的闸',
  );
});

/* ================= 变异验证说明 =================
 * 把 main.ts 里 `editorHost.addEventListener('compositionend', ...)` 整块删掉
 * ⇒ RESCAN-01 红；同时 e2e EGG-E16 红（提交后 waitBurst 超时）。
 * 全部恢复后本文件 2/2 绿（v3.1.1 实测）。
 */
