/**
 * 每版更新要点（releases/<tag>.md）—— 解析与校验的**唯一权威**。
 *
 * 🔴🔴 为什么要有这份真源：
 *   App 的「检查更新」弹窗内容不是客户端算出来的，是**服务端磁盘上**那份
 *   deploy/latest_app.json 里的 summary（客户端 ota.ts `extractNotes` 优先读它）。
 *   而那份 json 由 tools/push_bj_apk.py 生成。此前脚本里硬编码了一句占位正文、
 *   summary 恒为空数组 ⇒ 用户点「检查更新」看到的永远是同一句占位话，
 *   等于没有更新说明。
 *   ⇒ 现在要点必须手写在 releases/<tag>.md 里，随代码进仓库、可评审、可追溯。
 *
 * 🔴 一条真源喂两条链路（同一份文件，不许各写各的）：
 *   - 前若干条 `- ` 行 → push_bj_apk.py → latest_app.json 的 summary → App 弹窗
 *   - 整份文件         → push_bj_apk.py → 同上 body（客户端回退路径）
 *   - 整份文件         → CI GitHub Release 的 body_path → Release 页
 *
 * 🔴🔴 上限为什么是 4 条 / 24 字（与老项目同口径，别随手放宽）：
 *   弹窗里这几条是「要不要现在升」的判断依据，不该需要滚动。老项目
 *   index.html:8098 就是 `slice(0, 4)`；24 字在 360px 宽的手机上基本一行内。
 *
 * 🔴 只认 `- ` 项目符号：客户端读到的 summary 是**纯文本**，它不会剥 Markdown 前缀
 *   （ota.ts 的 summary 路径不过滤、不剥前缀）。用 `*` / `+` 写要点，弹窗一条都取不到。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 要点文件所在目录（仓库根下）。 */
export const NOTES_DIR = 'releases';
/** 弹窗最多显示几条。 */
export const MAX_ITEMS = 4;
/** 每条最多几个字符（按码点计，中文算 1 个）。 */
export const MAX_CHARS = 24;

/** 某版要点的文件路径。tag 形如 `v3.0.3`。 */
export function notesPath(root, tag) {
  return path.join(root, NOTES_DIR, tag + '.md');
}

/**
 * tag 归一化：一律带 `v` 前缀。
 *
 * 🔴 两处调用方口径必须一致：CI 的 test 作业在 tag 推送时拿到的是 `v3.0.3`，
 *   手动触发时是分支名，得退回 package.json；push_bj_apk.py 拿到裸 `3.0.3` 会自己补 v。
 *   文件名是 `releases/v3.0.3.md` —— 一处带 v 一处不带就会「明明写了文件却报缺文件」。
 */
export function resolveTag(raw, fallbackVersion) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'v' + String(fallbackVersion).trim().replace(/^v/i, '');
  return s.startsWith('v') ? s : 'v' + s;
}

/**
 * 从要点文件的**全文**里抽出弹窗要点并校验。
 *
 * 全文（含标题、正文）不是废话：它就是 GitHub Release 页的正文，
 * 只有 `- ` 行会被 App 弹窗取用。所以这里返回 `{ summary, errors }`，
 * 正文由调用方原样带走。
 */
export function parseNotes(text) {
  const src = String(text == null ? '' : text);
  const summary = [];
  const errors = [];

  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (m) summary.push(m[1].trim());
  }

  if (!summary.length) {
    errors.push("没有一条 '- ' 开头的要点 —— 项目符号必须是 '-'（用 '*' / '+' 弹窗取不到任何内容）");
  }
  if (summary.length > MAX_ITEMS) {
    errors.push(
      `要点 ${summary.length} 条 > 上限 ${MAX_ITEMS} 条 —— 第 ${MAX_ITEMS + 1} 条起在手机上要滚动才看得到`,
    );
  }
  summary.forEach((s, i) => {
    const n = [...s].length;
    if (!s) {
      errors.push(`第 ${i + 1} 条是空的`);
      return;
    }
    if (n > MAX_CHARS) {
      errors.push(`第 ${i + 1} 条 ${n} 字 > 上限 ${MAX_CHARS} 字：${s}`);
    }
    // 🔴 含链接的行一律拒：GitHub Release 自动生成的 `**完整变更日志**: .../compare/...`
    //   就是这类行，给开发者看的，出现在老人手机上一行小字里就是事故。
    if (/https?:\/\//i.test(s) || /compare\//i.test(s) || /\[[^\]]*\]\([^)]*\)/.test(s)) {
      errors.push(`第 ${i + 1} 条含链接或 compare 行（这类行只给开发者看）：${s}`);
    }
  });

  return { summary, errors };
}

/**
 * 读并校验某版要点文件。
 *
 * 缺文件**不是**「没有要点」而是发版必填项没写 —— 所以它是一条 error，调用方据此红。
 */
export function readNotes(root, tag) {
  const file = notesPath(root, tag);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {
      file,
      exists: false,
      body: '',
      summary: [],
      errors: [`找不到 ${file} —— 本版更新要点是发版的必填项`],
    };
  }
  const body = text.replace(/^\uFEFF/, '').trim();
  if (!body) {
    return { file, exists: true, body: '', summary: [], errors: [`${file} 是空文件`] };
  }
  const { summary, errors } = parseNotes(body);
  return { file, exists: true, body, summary, errors };
}