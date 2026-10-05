/**
 * 真域名 e2e 的**机械自查闸** —— 专治"报全绿但没真跑"。
 *
 * 🔴 为什么要单独一个脚本，而不是看输出：
 *   本项目在这套文件上栽过三次「汇总全绿但结论不可信」，而且**三次的输出都很好读**：
 *     ① 顶层裸 process.exit  ⇒ # tests 1 / # pass 1 / 462ms，六条用例一条没跑；
 *     ② 清理写成独立顶层用例 ⇒ 从未执行，生产目录每次留一篇密文笔记；
 *     ③ 收进父测试后仍 exit ⇒ 5 条全跑完，汇总被掐成「4 条全绿」。
 *   三次都只能靠"数条目 + 看时长"发现。而人眼在长输出里数条目是不可靠的 ——
 *   正是这个不可靠让同一个坑踩了三次。
 *   ⇒ 判据必须机器化：条目数、时长、退出码三项缺一即红。
 *
 * 用法：bash -lc 'node --test --test-concurrency=1 <FILE> | node tools/check-live-e2e.mjs'
 *      （**必须管道给本脚本读 stdin**，见下方 EBUSY 说明）
 * 退出码：0 真的跑了且全绿；1 不可信（假绿 / 漏跑 / 挂死）
 *
 * 🔴🔴 为什么是读 stdin 而不是 spawnSync 子进程：
 *   本机（WorkBuddy 会话内）node → node 嵌套 spawnSync 会整段 EBUSY，
 *   报 `spawnSync <node.exe> EBUSY`、status=null、输出全空 ——
 *   症状是"脚本说结果不可信"，而真去查会发现测试根本没启动。
 *   这不是被测代码的问题，是本机沙箱的进程限制（已多次实测）。
 *   ⇒ 自查闸改成从 stdin 读 runner 的输出，调用方用管道接。
 */
import { readFileSync } from 'node:fs';

/** 文件里一共几步。改文件就改这里，改忘了会红——这是故意的。 */
const EXPECT_STEPS = 5;
/** 全绿时的时长下限（毫秒）。低于它几乎必然是"没真跑"（真跑约 25-30s）。 */
const MIN_MS = 10000;

let out = '';
try {
  out = readFileSync(0, 'utf8');
} catch (e) {
  console.error('🔴 读不到 stdin（请用管道把 runner 输出接进来）：' + e.message);
  process.exit(1);
}
if (!out.trim()) {
  console.error('🔴 stdin 为空 —— runner 没有产生任何输出，不能判为全绿。');
  process.exit(1);
}

const okSteps = (out.match(/^\s*ok \d+ - LIVE-\d+/gm) || []).length;
const notOk = (out.match(/^\s*not ok \d+ - /gm) || []).length;
const durMatch = out.match(/# duration_ms ([\d.]+)/);
const dur = durMatch ? Number(durMatch[1]) : -1;
const testsMatch = out.match(/# tests (\d+)/);
const tests = testsMatch ? Number(testsMatch[1]) : -1;
const passMatch = out.match(/# pass (\d+)/);
const pass = passMatch ? Number(passMatch[1]) : -1;

const fails = [];
if (notOk > 0) fails.push('有 ' + notOk + ' 条 not ok');
if (okSteps !== EXPECT_STEPS) {
  fails.push('LIVE 步骤数 ' + okSteps + ' ≠ 期望 ' + EXPECT_STEPS + '（漏跑，或多写了）');
}
if (dur < MIN_MS) {
  fails.push('耗时 ' + dur + 'ms < ' + MIN_MS + 'ms（几乎必然是没真跑）');
}
// 父测试 + 五步子测试 = 6。# tests 少一个就说明有条被吃掉。
if (tests !== EXPECT_STEPS + 1) {
  fails.push('# tests ' + tests + ' ≠ 期望 ' + (EXPECT_STEPS + 1) + '（有条用例没进汇总）');
}
if (pass !== EXPECT_STEPS + 1) {
  fails.push('# pass ' + pass + ' ≠ 期望 ' + (EXPECT_STEPS + 1));
}

if (fails.length) {
  console.error('\n🔴 真域名验收结果**不可信**，不接受：');
  for (const f of fails) console.error('   - ' + f);
  console.error('\n---- 原始输出尾部 ----\n' + out.split('\n').slice(-40).join('\n'));
  process.exit(1);
}

console.log('✅ 真域名验收可信且全绿');
console.log('   LIVE 步骤 ' + okSteps + '/' + EXPECT_STEPS);
console.log('   # tests ' + tests + ' / # pass ' + pass + ' / # fail 0');
console.log('   耗时 ' + dur + 'ms（下限 ' + MIN_MS + 'ms）');
