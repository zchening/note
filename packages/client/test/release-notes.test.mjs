/**
 * 发版更新要点（releases/<tag>.md）—— 解析/校验闸的单测。
 *
 * 🔴 钉的是这条链路上"不报错但用户什么都看不到"的缺陷：
 *   要点文件是 App「检查更新」弹窗内容的**唯一来源**（经 latest_app.json 的 summary）。
 *   它缺失/格式不对时，客户端不会报错 —— 只会静默退回 body、再退回兜底句，
 *   用户看到的是空弹窗或一句"详见发布页"。所以闸必须在发版前就红。
 *
 * 🔴 判据不许手写第二份实现：条数/字数/链接规则一律从 tools/release-notes.mjs 导入，
 *   闸本身也是导入 check-release-notes.mjs 的 run()，不 spawn 子进程
 *   （本机 node → node 嵌套 spawn 会整段 EBUSY，见 tools/check-live-e2e.mjs 文件头）。
 *
 * 🔴 每条"应该有"都配一条"不应该有"（4 条 vs 5 条、24 字 vs 25 字、有链接 vs 无链接）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_CHARS, MAX_ITEMS, parseNotes, readNotes, resolveTag } from '../../../tools/release-notes.mjs';
import { run } from '../../../tools/check-release-notes.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 造一个只含 releases/ 与 package.json 的临时仓库，跑完自动删。 */
function withRepo(notes, fn, pkgVersion = '3.0.3') {
  const root = mkdtempSync(path.join(tmpdir(), 'bj-notes-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: pkgVersion }));
    mkdirSync(path.join(root, 'releases'));
    for (const [name, text] of Object.entries(notes)) {
      writeFileSync(path.join(root, 'releases', name), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const GOOD = ['### 更新内容', '', '- 修复提醒偶发不响', '- 同步底栏不再抖动', '', '更长的说明写在这里。'].join('\n');

/* ══════════ 解析 ══════════ */

test('RN-01 只取 "- " 行作要点，正文原样保留（正文是 Release 页用的）', () => {
  const { summary, errors } = parseNotes(GOOD);
  assert.deepEqual(errors, []);
  assert.deepEqual(summary, ['修复提醒偶发不响', '同步底栏不再抖动'], 'Markdown 的 "- " 前缀必须剥掉');
});

test('RN-02 用 * / + 当项目符号一条都取不到 —— 必须报错而不是静默给空弹窗', () => {
  const { summary, errors } = parseNotes(['* 修复提醒偶发不响', '+ 同步底栏不再抖动'].join('\n'));
  assert.deepEqual(summary, [], '客户端拿到的 summary 是纯文本，不剥 Markdown 前缀，故只认 "-"');
  assert.ok(errors.length > 0, '一条要点都没有时必须报错');
});

/* ══════════ 闸：文件级 ══════════ */

test('RN-03 缺文件必须红（这是发版必填项没写，不是"没有要点"）', () => {
  withRepo({}, (root) => {
    const r = run(['v3.0.3'], root);
    assert.equal(r.code, 1);
    assert.match(r.lines.join('\n'), /找不到/);
  });
});

test('RN-04 空文件必须红', () => {
  withRepo({ 'v3.0.3.md': '\n\n' }, (root) => {
    assert.equal(run(['v3.0.3'], root).code, 1);
  });
});

test('RN-05 合规文件必须绿，且打印逐条要点', () => {
  withRepo({ 'v3.0.3.md': GOOD }, (root) => {
    const r = run(['v3.0.3'], root);
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /修复提醒偶发不响/);
  });
});

/* ══════════ 闸：条数边界 ══════════ */

test(`RN-06 恰好 ${MAX_ITEMS} 条绿、第 ${MAX_ITEMS + 1} 条红（第 5 条起手机上要滚动才看得到）`, () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `- 第${i + 1}条要点`).join('\n');
  withRepo({ 'v3.0.3.md': mk(MAX_ITEMS) }, (root) => {
    assert.equal(run(['v3.0.3'], root).code, 0);
  });
  withRepo({ 'v3.0.3.md': mk(MAX_ITEMS + 1) }, (root) => {
    const r = run(['v3.0.3'], root);
    assert.equal(r.code, 1);
    assert.match(r.lines.join('\n'), /上限/);
  });
});

/* ══════════ 闸：字数边界 ══════════ */

test(`RN-07 恰好 ${MAX_CHARS} 字绿、第 ${MAX_CHARS + 1} 字红`, () => {
  withRepo({ 'v3.0.3.md': '- ' + '一'.repeat(MAX_CHARS) }, (root) => {
    assert.equal(run(['v3.0.3'], root).code, 0);
  });
  withRepo({ 'v3.0.3.md': '- ' + '一'.repeat(MAX_CHARS + 1) }, (root) => {
    const r = run(['v3.0.3'], root);
    assert.equal(r.code, 1);
    assert.match(r.lines.join('\n'), /上限/);
  });
});

/* ══════════ 闸：噪声行 ══════════ */

test('RN-08 要点里出现链接 / compare 行必须红（那是给开发者看的行）', () => {
  const bad = [
    '- 修复了提醒不响 https://github.com/x/y',
    '- 完整变更日志 compare/v3.0.2...v3.0.3',
    '- [某条带链接的](https://example.test)',
  ];
  for (const line of bad) {
    withRepo({ 'v3.0.3.md': line }, (root) => {
      const r = run(['v3.0.3'], root);
      assert.equal(r.code, 1, `应拦下：${line}`);
      assert.match(r.lines.join('\n'), /链接|compare/);
    });
  }
  // 反向：同样长度但不含链接的要点必须绿，证明上面红的是"链接"而不是"长度"
  withRepo({ 'v3.0.3.md': '- 修复了提醒不响，同步更快了' }, (root) => {
    assert.equal(run(['v3.0.3'], root).code, 0);
  });
});

/* ══════════ 版本号口径 ══════════ */

test('RN-09 tag 一律归一化带 v；不给参数时退回 package.json 的 version', () => {
  assert.equal(resolveTag('3.0.3', '9.9.9'), 'v3.0.3');
  assert.equal(resolveTag('v3.0.3', '9.9.9'), 'v3.0.3');
  assert.equal(resolveTag(undefined, '3.0.4'), 'v3.0.4');
  assert.equal(resolveTag('', 'v3.0.4'), 'v3.0.4');

  // 🔴 两处口径必须一致：CI 手动触发时传的是从 package.json 拼出来的 vX.Y.Z，
  //   若一处带 v 一处不带，就会"明明写了文件却报缺文件"。
  withRepo({ 'v3.0.3.md': GOOD }, (root) => {
    assert.equal(run([], root).code, 0, '不给参数应退回 package.json 的 3.0.3');
    assert.equal(run(['3.0.3'], root).code, 0, '裸版本号也要命中 releases/v3.0.3.md');
  });
});

/* ══════════ 接线回归（源码级） ══════════ */

/** 去掉整行注释 —— 🔴 断言"某段代码不存在"时必须在去注释后的代码上做，否则注释里
 *  复述那句占位文案会让 doesNotMatch 命中警告本身（本项目踩过这个坑）。 */
function stripLineComments(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

test('RN-10 push_bj_apk.py 不再硬编码占位正文、summary 不再是空数组、要点来自 releases/', () => {
  const code = stripLineComments(readFileSync(path.join(REPO_ROOT, 'tools/push_bj_apk.py'), 'utf8'));
  assert.doesNotMatch(code, /bj release/, '占位正文必须彻底消失，否则弹窗又会显示它');
  assert.doesNotMatch(code, /"summary"\s*:\s*\[\]/, 'summary 恒为空数组正是"弹窗没内容"的根因');
  assert.match(code, /"summary":\s*summary/, 'summary 必须由要点文件喂进来');
  assert.match(code, /["']releases["']/, '要点目录必须是仓库里的 releases/');
  assert.match(code, /def load_notes/, '缺文件时的硬失败要在这里');
});

test('RN-11 CI 接线：test 作业挂闸，Release 正文改用 body_path（不再自动生成）', () => {
  const wf = stripLineComments(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/build-apk.yml'), 'utf8'),
  );
  assert.match(wf, /tools\/check-release-notes\.mjs/, 'test 作业必须挂上要点闸');
  assert.match(wf, /body_path:\s*releases\//, 'Release 正文必须来自 releases/<tag>.md');
  assert.doesNotMatch(wf, /generate_release_notes/, '自动生成的变更日志会给用户看 compare 链接行');
});