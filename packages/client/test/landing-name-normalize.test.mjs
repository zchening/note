/**
 * NAME-LOWER 笔记名归一小写（用户报障 2026-10-14）
 *
 * 报障路径：落地页输入大写英文名 → 点「打开」→ 输口令 → 报「连不上服务器，请检查网络」。
 *
 * 根因（三层放行大写，服务端只认小写，谁都不归一）：
 *   ① sanitizeNoteName 保留大小写（landing-logic.ts 旧注释自己写着"保留大小写"）
 *   ② noteNameFromPath 只 decode 不归一 → noteId = 'MyNote'
 *   ③ 收藏打开 / 换机恢复跳转原样拼 URL
 *   ⇒ GET /api/note/MyNote 撞上服务端 ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/ → 400 bad id
 *   ⇒ fetchRemote 把一切非 2xx 当 offline ⇒ 用户看到"连不上服务器"（报错撒谎：不是网络，是名字）。
 *
 * 修法（老项目 v10.1.1 同规则，用户拍板方案 2）：客户端全链归一小写——
 *   ① sanitizeNoteName 输入即小写（落地页输入/预览/onOpen/route 判定共用这一点）
 *   ② noteNameFromPath 解析点兜底小写（手输大写 URL / 扫码 / 通知冷启等旁路）
 *   ③ 跳转源头（收藏打开 / 换机恢复跳第一篇）小写（localStorage/备份 payload 里可能有历史大写值）
 *
 * 🔴🔴 为什么不是「禁止输入大写」（用户方案 1）：落地页只是入口之一，
 *   拦不住手输 URL / 扫码 / 通知点击 / 上次笔记自动恢复——只堵一个入口＝只改一半。
 *   大小写变体本就是同一篇笔记（服务端权威口径小写），归一是无损操作、用户零学习成本。
 * 🔴 彩蛋门牌 id 全部小写（snake/dragon/…，egg/games.ts 已核）——归一不破坏门牌；
 *   反而顺手修好"手输 /SNAKE 进不了贪吃蛇"的边角（门牌匹配原是大小写敏感的）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeNoteName } from '../src/ui/landing-logic.ts';

test('NAME-L1 🔴 输入即归一小写：大写字母进净化器变小写', () => {
  assert.equal(sanitizeNoteName('MyNote'), 'mynote');
});

test('NAME-L2 🔴 混合合法字符全归一：大小写/数字/下划线/短横线', () => {
  assert.equal(sanitizeNoteName('AB-cd_90'), 'ab-cd_90');
});

test('NAME-L3 🔴 非法字符仍剔（不因归一放水）', () => {
  assert.equal(sanitizeNoteName('我的 笔记!'), '');
  assert.equal(sanitizeNoteName('a@b.c'), 'abc');
});

test('NAME-L4 🔴 解析点兜底：noteNameFromPath 两个返回分支都小写（源码钉，双锚各唯一）', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // 正常分支：decode 后必须 toLowerCase
  const okBranch = '    return decodeURIComponent(first).toLowerCase();';
  assert.equal(
    src.split(okBranch).length - 1,
    1,
    'noteNameFromPath 正常分支必须 decode 后 toLowerCase（手输 /MyNote 旁路的唯一兜底）',
  );
  // catch 兜底分支（非法百分号编码回退原始片段）同样必须小写
  const fallback = '    return first.toLowerCase();';
  assert.equal(
    src.split(fallback).length - 1,
    1,
    'noteNameFromPath catch 回退分支同样必须小写（%zz 场景不可绕过归一）',
  );
});

test('NAME-L5 🔴 跳转源头小写：收藏打开 / 换机恢复跳第一篇（源码钉，双锚各唯一）', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const favJump = "location.href = '/' + encodeURIComponent(n.toLowerCase());";
  assert.equal(
    src.split(favJump).length - 1,
    1,
    'onOpenFav 跳转必须小写（localStorage 收藏名可能有历史大写值）',
  );
  const bakJump = "location.href = '/' + encodeURIComponent((r.first as string).toLowerCase());";
  assert.equal(
    src.split(bakJump).length - 1,
    1,
    '换机恢复跳第一篇必须小写（备份 payload 的 NOTE_ID_RE 允许大写）',
  );
});
