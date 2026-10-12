/**
 * 离线草稿接线判据（WIRE-01~06）—— v3.1.1 把 sync/draft.ts 接进主流程
 *
 * 🔴🔴 纪律（同 STRAY/HOT 系）：
 *   · 源码级结构判据：剥注释后按"窗口"截取相关函数体再断言，
 *     不抄实现、不猜行号；
 *   · 每条"应该有"配一条"不应该有"；
 *   · 变异验证（文件尾注释）：把 onPushed 里的 clearDraft 与 update 监听器里的
 *     saveDraftForNote 同时删掉 ⇒ WIRE-01/02 必须红。
 *
 * 🔴 本文件钉的红线（draft.ts 文件头）：草稿只在「内容真变」时记、只在「推送成功」
 *   后清、挂起（pending）期间任何路径都不许清。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

/* ---------------- 剥注释（保字符串字面量） ---------------- */

/** 逐字符扫描：去掉 // 与 块注释，保留字符串/模板/正则字面量里的内容。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
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
    // tpl
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') mode = 'code';
    out += c; i++; continue;
  }
  return out;
}

/** 从 anchor 首次出现处截一段（到平衡花括号或 maxChars 上限），供函数体级断言。 */
function windowOf(code, anchor, maxChars = 3000) {
  const i = code.indexOf(anchor);
  if (i < 0) return '';
  let depth = 0;
  let started = false;
  for (let j = i; j < Math.min(code.length, i + maxChars); j++) {
    const c = code[j];
    if (c === '{') { depth++; started = true; }
    if (c === '}') { depth--; if (started && depth === 0) return code.slice(i, j + 1); }
  }
  return code.slice(i, i + maxChars);
}

const main = stripComments(read('packages/client/src/main.ts'));

/* ================= WIRE-01 用户内容真变 ⇒ 记草稿 ================= */

test('WIRE-01 update 监听器在 noteEdit 同一条件分支里调 saveDraftForNote(name, latestDoc)', () => {
  const win = windowOf(main, 'canonicalize(latestDoc) !== canonicalize(before)');
  assert.ok(win, '找不到「内容真变」判定（update 监听器被重命名/挪走了？）');
  assert.ok(win.includes('syncRef?.noteEdit()'), '条件分支里应触发推送记账');
  assert.ok(
    win.includes('saveDraftForNote(name, latestDoc)'),
    '同一分支里应把最新真源记进离线草稿',
  );
});

/* ================= WIRE-02 推送成功 ⇒ 清草稿（唯一清点） ================= */

test('WIRE-02 onPushed 里 clearDraft(name)；onArchive 不碰草稿；全 main.ts clearDraft( 调用唯一', () => {
  // 🔴 必须挂 onPushed 不能挂 onArchive：onArchive 带「prev 非空 && prev≠doc」双闸，
  //   首推不调 ⇒ 首推后草稿永远残留（DRAFT-E1 e2e 实锤过这个接法）。
  const pushed = windowOf(main, 'onPushed:');
  assert.ok(pushed.includes('clearDraft(name)'), '云端确认收到这一版（onPushed）后必须清掉镜像草稿');
  const archive = windowOf(main, 'onArchive:');
  assert.ok(!archive.includes('clearDraft'), 'onArchive 只管快照存档，不许碰草稿（首推不调它）');
  // 不应该有：clearDraft 是"推送成功"专属。多一处调用就多一条误清草稿的路径
  //（挂起期的保护由 draft.ts 的形状兜底，但调用面收紧到 1 处才可审计）。
  const n = (main.match(/clearDraft\(/g) ?? []).length;
  assert.equal(n, 1, `clearDraft( 调用点必须唯一（onPushed），实际 ${n} 处`);
  assert.ok(!pushed.includes('discardDraft'), 'onPushed 不许动 discardDraft（那是用户裁决入口）');
});

/* ================= WIRE-03 开篇裁决 ================= */

test('WIRE-03 startSyncFor 里 resetDraftSession → restoreDraftIfNeeded(mountDocSnapshot) → 冲突弹条', () => {
  const win = windowOf(main, 'async function startSyncFor');
  assert.ok(win.includes('resetDraftSession()'), '开新会话先清内存态（盘上记录不动）');
  assert.ok(win.includes('restoreDraftIfNeeded('), '开篇必须做草稿裁决');
  // 🔴 不能对 restoreDraftIfNeeded( 再开括号平衡窗：第一个 { 是 DraftCtx 对象字面量，
  //   窗口会提前闭合。直接断言比较对象的表达式原样在窗外层窗口里。
  assert.ok(
    win.includes('mountDocSnapshot ?? emptyDoc()'),
    '比对的云端版必须是解锁时解出来的那一份（无快照兜空文档）',
  );
  assert.ok(win.includes("kind === 'conflict'"), '冲突分支要接 UI');
  assert.ok(win.includes('showDraftBar(name)'), '冲突 ⇒ 弹「保留本机/使用云端」条');
});

/* ================= WIRE-04 离开兜底 ================= */

test('WIRE-04 pagehide 与 visibilitychange 都调 flushDraftNow（活真源落草稿）', () => {
  const pagehide = windowOf(main, 'pagehideHandler = () =>');
  assert.ok(pagehide.includes('flushDraftNow(name)'), '关页前必须把活真源落一次草稿');
  assert.ok(pagehide.includes('flushPending()'), '既有推送兜底不许被挤掉');
  const n = (main.match(/flushDraftNow\(/g) ?? []).length;
  assert.ok(n >= 3, `flushDraftNow 定义+pagehide+visibilitychange 至少 3 处，实际 ${n}`);
});

/* ================= WIRE-05 保留/丢弃两条裁决路径 ================= */

test('WIRE-05 保留本机 = applyDraft+docToLexical（不许 clearDraft）；使用云端 = discardDraft', () => {
  const keep = windowOf(main, "getElementById('draftRestore')");
  assert.ok(keep.includes('applyDraft('), '保留本机必须走 applyDraft 拿草稿内容');
  assert.ok(keep.includes('docToLexical('), '草稿内容要回灌进编辑器');
  assert.ok(!keep.includes('clearDraft('), '此刻内容还没推上去，绝不清草稿（数据丢失红线）');
  const drop = windowOf(main, "getElementById('draftDiscard')");
  assert.ok(drop.includes('discardDraft('), '使用云端必须 discardDraft 丢掉草稿');
});

/* ================= WIRE-06 UI 契约（文案/标记/样式） ================= */

test('WIRE-06 copy.ts 有草稿条文案；build.mjs 有 draftBar 标记；styles 无色彩字面量', () => {
  const copy = read('packages/client/src/ui/copy.ts');
  assert.ok(copy.includes("draftBarTitle: '检测到同步冲突'"), '标题逐字对齐老项目');
  assert.ok(
    copy.includes("draftBarMsg: '发现本机有一份离线草稿，与当前内容不一致'"),
    '正文逐字取老项目 baseV 相同分支（bj 无 rev 语义，此句恒真）',
  );
  const html = read('tools/build.mjs');
  assert.ok(html.includes('id="draftBar"'), '产物壳里要有草稿条容器');
  assert.ok(html.includes('id="draftRestore"') && html.includes('id="draftDiscard"'), '两个裁决按钮要有');
  const css = read('packages/client/src/ui/styles.css');
  // 🔴 不用括号平衡窗：.conflictbar 家族是一组**并列单行规则**，取锚点起 1400 字切片。
  const i0 = css.indexOf('.conflictbar');
  const block = css.slice(i0, i0 + 1400);
  assert.ok(block.length > 0, 'styles.css 要有 .conflictbar 家族');
  assert.ok(block.includes('.confcard'), 'confcard 卡体要在这段家族里');
  assert.ok(block.includes('var(--accent)'), '强调条用主题令牌');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '新块里不许出现 hex 色彩字面量（红线：色彩只进 theme.ts）');
  assert.ok(!/rgba?\(/.test(block), '新块里不许出现 rgba 字面量');
});

/* ================= 变异验证说明 =================
 * （1）删掉 update 监听器条件分支里的 saveDraftForNote(name, latestDoc) ⇒ WIRE-01 红；
 * （2）删掉 onPushed 里的 clearDraft(name) ⇒ WIRE-02 红；
 * （3）把 startSyncFor 的 restoreDraftIfNeeded 块整体删掉 ⇒ WIRE-03 红。
 * 全部恢复后本文件 6/6 绿（v3.1.1 实测）。
 */
