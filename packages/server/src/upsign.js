/**
 * Cloudinary 上传签名 —— 一次一签（/api/upsign）
 *
 * 🔴🔴 签名算法：`SHA1(待签串 + api_secret)`，**不是 HMAC**。
 *
 *   这条是拿真云端**实测**换来的，不是从文档推断的（2026-10-06 报障「上传图片 401」）：
 *
 *     实测 1：老项目（同机 8080，同 cloud/key/preset/folder）签的票直传 Cloudinary ⇒ **200**
 *     实测 2：本项目签的票直传同一地址 ⇒ **401**，云端原话
 *             Invalid Signature 2fa1…c3be.
 *             String to sign - 'folder=notesync&timestamp=…&upload_preset=notesync-signed'
 *     实测 3：在服务端用**同一份 secret**（27 字符）分别复算，与两边各自产出的签名比对：
 *             SHA1(串 + secret)      === 老项目产出 → true
 *             HMAC-SHA1(secret, 串)  === 老项目产出 → false
 *             SHA1(串 + secret)      === 本项目产出 → false
 *             HMAC-SHA1(secret, 串)  === 本项目产出 → true
 *
 *   ⇒ 串一样、secret 一样、cloud/key/preset 一样，唯一的差别就是**算法**：
 *     Cloudinary 是「待签串 + secret 拼起来再 SHA-1」，我们写成了 HMAC-SHA1。
 *
 * 🔴 所以文件头那句「顺序是协议的一部分」只对了一半：
 *    **顺序错**与**算法错**是两个独立的 bug，修了顺序并不代表签得对。
 *    当年只改了顺序就去改注释说"根因是顺序"，是**没验到底**——
 *    那个 401 从没被真正复现过一次成功上传，所以没人发现算法还错着。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 待签串的构造（同样有实测依据，见上「String to sign」）
 *
 *   1. 只放**实际参与签名**的那几个字段：folder / timestamp / upload_preset。
 *      多带一个未签参数（public_id、transformation…）云端就判不符。
 *      ⇒ 客户端 FormData 必须与这份清单**逐字同步**（image/upload.ts 有对称注释）。
 *   2. 顺序按**参数名字典序**（folder < timestamp < upload_preset）——
 *      云端报回来的 "String to sign" 就是这个顺序。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么单独成文件
 *
 *   判据必须 `import` 生产代码（抄进测试的判据恒绿）。server.js 是会自己 listen
 *   的入口，import 它会顺带起一个服务 ⇒ 只能把纯函数拆出来。
 *   ⚠ 部署脚本必须同步把本文件一起上传（与 server.js / failmap.js 同级）。
 */

import crypto from 'node:crypto';

/**
 * 待签串。
 * @param {{timestamp: number|string, folder?: string, uploadPreset: string}} p
 * @returns {string}
 */
export function upsignSignedString({ timestamp, folder, uploadPreset }) {
  // 用对象 + 排序而不是手写下标：加参数时排序自动就位。
  const params = { timestamp, upload_preset: uploadPreset };
  if (folder) params.folder = folder;
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/**
 * Cloudinary 上传签名。
 *
 * 🔴 是 `SHA1(串 + secret)`，不是 HMAC。理由见文件头实测 1~3。
 *
 * @param {{secret: string, timestamp: number|string, folder?: string, uploadPreset: string}} p
 * @returns {string} 40 位 hex
 */
export function upsignSign({ secret, timestamp, folder, uploadPreset }) {
  const str = upsignSignedString({ timestamp, folder, uploadPreset });
  return crypto.createHash('sha1').update(str + secret).digest('hex');
}
