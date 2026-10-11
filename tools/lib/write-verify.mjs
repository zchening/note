/**
 * 落盘校验：写完立刻回头读一遍，逐字节比对。
 *
 * 🔴🔴 为什么必须"写完再读回来"：
 *   `copyFileSync` / `writeFileSync` 返回成功**只代表调用没抛异常**，
 *   不代表目标盘上的内容与我们要写的东西一致。本项目踩过的实锤：
 *   android/app/src/main/assets/public/app.js（v1.0.0，547975 字节）
 *   与 www/app.js（v3.0.20，777252 字节）**是两份完全不同的东西**，
 *   而中间那次 `cap sync`/拷贝全程零报错 —— 因为从来没有人回头比对过。
 *   症状是"APK 能装能开，但里面是上一版的页面"，而构建日志一片绿。
 *
 *   ⇒ 纪律：**凡是"搬文件"的脚本，落盘后必须逐文件 sha256 比对，不等就 exit 1。**
 *
 * 🔴 为什么抽成独立模块而不是写在调用处：
 *   调用处（tools/port-android.mjs）是**一次性移植脚本**，带重跑闸，
 *   一旦文件被手工改过就会拒绝执行 —— 也就是说"真跑一遍它"这个动作
 *   在移植完成后**永远不可再现**。校验逻辑若埋在里面，就永远无法被单独验证，
 *   只能靠人读。抽出来之后它可以被独立 import 并做双向验证
 *   （一致 ⇒ 通过；不一致 ⇒ 抛错），这是它存在的第二个理由。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** @param {string|Buffer} content */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 校验落盘内容与预期一致。
 *
 * @param {string} dstPath 落盘后的绝对路径（报错信息里要给全路径，便于人去核）
 * @param {string} dstRel  相对路径（日志里用，短）
 * @param {string|Buffer} expected 我们**打算**写进去的内容
 * @returns {{sha: string, size: number}} 通过则返回实际 sha 与大小，供调用方汇总打印
 * @throws {Error} 缺文件 / 内容不一致
 */
export function assertWrittenEqual(dstPath, dstRel, expected) {
  const expectedBuf = typeof expected === 'string' ? Buffer.from(expected, 'utf8') : expected;
  let actual;
  try {
    actual = readFileSync(dstPath);
  } catch (e) {
    throw new Error(
      `❌ 落盘校验失败：${dstRel} 读不回来（${dstPath}）\n` +
      `       预期 ${expectedBuf.length} 字节，sha256=${sha256(expectedBuf)}\n` +
      `       原因：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const he = sha256(expectedBuf);
  const ha = sha256(actual);
  if (he !== ha) {
    // 🔴 差异必须把**两边**的大小与 sha 都打出来：只说"不一致"等于让人自己再去查一遍，
    //   而"哪个是旧的、哪个是新的"恰恰是看这两个数字看出来的。
    throw new Error(
      `❌ 落盘校验失败：${dstRel} 与预期内容不一致（写完再读回来比对）\n` +
      `       预期 ${expectedBuf.length} 字节，sha256=${he}\n` +
      `       实际 ${actual.length} 字节，sha256=${ha}\n` +
      `       路径：${dstPath}`,
    );
  }
  return { sha: he, size: actual.length };
}
