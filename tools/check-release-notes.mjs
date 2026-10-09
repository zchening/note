#!/usr/bin/env node
/**
 * 发版闸：本版更新要点（releases/<tag>.md）必须存在且合规。
 *
 * 用法：
 *     node tools/check-release-notes.mjs v3.0.3   # 指定 tag
 *     node tools/check-release-notes.mjs          # 不指定则取 package.json 的 version
 * 退出码：0 合规；1 缺文件 / 空文件 / 条数超限 / 单条超字数 / 含链接。
 *
 * 🔴🔴 为什么这闸要放在 CI 的 **test 作业**（而不是等 deploy 里 push_bj_apk.py 才发现）：
 *   test 作业 1 分钟就红，deploy 要等 Android 构建（5 分钟起）+ APK 签名。
 *   发版前忘写要点这种事，越早红越不浪费；而且 test 红 ⇒ build 不执行 ⇒ 不出包，
 *   不会出现「APK 已经出好了、腾讯云却因为要点缺失没更新」的半截状态。
 *   push_bj_apk.py 里仍有一道硬失败 —— 它可能被单独手动调用，不能只靠 CI。
 *
 * 🔴 版本号口径必须与 build 作业（build-apk.yml「解析版本号」那步）逐字一致：
 *   tag 推送取 tag 名，手动触发（workflow_dispatch）没有 tag，退回 package.json。
 *   直接用 GITHUB_REF_NAME 的话，手动触发时它是分支名 "main"，闸会去找
 *   releases/vmain.md —— 手动发版永远红。
 *
 * 🔴 判据不许手写第二份实现：规则（条数/字数/链接）全在 tools/release-notes.mjs，
 *   本文件只负责「取版本号 → 调规则 → 打印 → 定退出码」。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_CHARS, MAX_ITEMS, NOTES_DIR, readNotes, resolveTag } from './release-notes.mjs';

/** 仓库根（本文件在 tools/ 下）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 跑一次闸。**返回值而不是直接 process.exit** —— 顶层 exit 会让本文件无法被单测导入
 * （一 import 就把测试进程干掉，症状是"判据全绿但其实一条没跑"）。
 *
 * @param {string[]} argv 命令行参数（不含 node 与脚本名）
 * @param {string} root 仓库根
 * @returns {{ code: number, lines: string[], tag: string }}
 */
export function run(argv, root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tag = resolveTag(argv.find((a) => a && !a.startsWith('-')), pkg.version);
  const r = readNotes(root, tag);

  if (r.errors.length) {
    return {
      code: 1,
      tag,
      lines: [
        `🔴 ${tag} 的更新要点不合规（上限 ${MAX_ITEMS} 条 / 每条 ${MAX_CHARS} 字）：`,
        ...r.errors.map((e) => '   - ' + e),
        `   写法见 ${NOTES_DIR}/README.md`,
      ],
    };
  }

  const longest = Math.max(...r.summary.map((s) => [...s].length));
  return {
    code: 0,
    tag,
    lines: [
      `✅ ${tag} 更新要点 ${r.summary.length}/${MAX_ITEMS} 条，最长 ${longest} 字（上限 ${MAX_CHARS}）`,
      ...r.summary.map((s) => '   · ' + s),
    ],
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { code, lines } = run(process.argv.slice(2), REPO_ROOT);
  for (const l of lines) console.log(l);
  process.exit(code);
}