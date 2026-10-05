/**
 * App 在线升级 —— 版本判定（纯逻辑层，零 DOM，可单测）
 *
 * 🔴🔴 为什么单独一个模块：
 *   升级链路上有四种「版本比较」语义，任何一处搞混都表现为
 *   「明明有新版却提示已是最新」或「反复提示要升到同一个版本」——
 *   而这两种都不会报错，只会静默失灵。所以口径必须集中在这里并被单测钉死。
 *
 * 四种语义：
 *   1. compareVersions(a, b)   —— 三段式数值比较，返回 -1/0/1
 *   2. isNewer(remote, local)  —— 有新版吗（OTA 的唯一判据）
 *   3. parseLatest(json)       —— 解 /api/latest 的响应，容错到"当成没新版"
 *   4. pickApk(assets)         —— 从 assets 里挑 .apk
 *
 * 🔴 为什么打同源 /api/latest 而不是直接打 api.github.com：
 *   老项目 v9.3.1 实锤「检查更新」在真机上失败——手机直连 api.github.com
 *   在国内容器基本必挂。改由服务器代拉（10 分钟缓存），字段协议与 GitHub 一致。
 *   本项目的 /api/latest 由服务端读 deploy/latest_app.json（server.js），
 *   同样不经过客户端直连 GitHub。
 *
 * 🔴 三段式而非 SemVer 全语义：本项目版本号是 X.Y.Z（package.json），
 *   不带 prerelease/build。带 '-beta' 的解析结果是 null → 一律判"没新版"，
 *   宁可漏提示也不给用户一个装不上的包。
 */

/** /api/latest 响应的最小形状（只取用得到的字段，其余忽略） */
export interface LatestRelease {
  /** 形如 "v1.2.0" 或 "1.2.0" */
  tag: string;
  /** 去掉 v 后的纯数字版本，如 "1.2.0" */
  version: string;
  /** 更新要点（每条一句）。取不到时给 ["详见发布页"]。 */
  notes: string[];
  /** APK 下载地址 */
  url: string;
  /** APK 字节数；0 = 未知（弹窗里就不显示大小） */
  size: number;
  /** 有新版吗（已经归一化过比较结果） */
  hasUpdate: boolean;
}

/** 解析失败时的统一返回：**不是 null，而是一个明确的"没新版"对象**。
 *  🔴 为什么不返回 null：调用方要判「服务端没发版」和「解析失败」两种情况，
 *     返回 null 会让两处 `if (!x)` 混成一处，最后用户看到的是
 *     「已是最新版本」—— 而真相可能是"服务器挂了"。文案必须能区分。 */
const NO_UPDATE: LatestRelease = {
  tag: '',
  version: '',
  notes: ['详见发布页'],
  url: '',
  size: 0,
  hasUpdate: false,
};

/** 复用一个常量对象会被调用方改脏，返回拷贝。 */
export function noUpdate(): LatestRelease {
  return { ...NO_UPDATE, notes: [...NO_UPDATE.notes] };
}

/**
 * 三段式版本比较。a 比 b 新返回 1，相同 0，旧 -1。
 *
 * 🔴 缺段按 0 补齐（"1.0" vs "1.0.0" → 0），
 *   而非按段数不等判"无法比较"。理由：包名里存的是 versionName（"1.0"），
 *   而 tag 里是完整三段（"1.0.0"），**同一个版本的两种写法必然不同长**。
 *   早先按段数判不同会把 "1.0" 的 APK 判成比 "1.0.0" 旧，提示升级后装到的还是同版。
 *
 * 🔴 不可解析时返回 null，**不返回 0**。
 *   返回 0 等于说"两边一样新"，会让一台装着脏版本号的设备永远看不到更新。
 *   返回 null 让调用方走"当成没新版"这条安全侧路径。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    // 🔴 显式取默认值而不是靠 `pa[i]!`：
    //   tsconfig 开了 noUncheckedIndexedAccess，索引访问类型是 `number | undefined`。
    //   parseVersion 保证长度恒为 3，但判据不该依赖"我知道它不会被 undefined" ——
    //   哪天有人把数组改成变长，这里立刻变成运行期 `undefined > 1` 恒 false，
    //   表现为「永远提示已是最新」，且不报任何错。
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 解析 "1.2.3" → [1,2,3]。任一段非纯数字/段数 >3 → null。 */
function parseVersion(v: string | null | undefined): number[] | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/i, '');
  if (!s) return null;
  const parts = s.split('.');
  if (parts.length > 3) return null;
  const out = [0, 0, 0];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // 🔴 段长上限 6：防 "999999999..." 撑爆 Number 精度后变成 0（0 < 任何版本）
    if (!p || p.length > 6 || !/^\d+$/.test(p)) return null;
    out[i] = Number(p);
  }
  return out;
}

/** 有新版吗？**任一版本不可解析一律 false**（安全侧：宁可漏提示不可乱提示）。 */
export function isNewer(remote: string, local: string): boolean {
  const c = compareVersions(remote, local);
  return c === 1;
}

/** 从 assets 数组里挑第一个 .apk（扩展名大小写不敏感）。 */
export function pickApk(assets: unknown): { name: string; url: string; size: number } | null {
  if (!Array.isArray(assets)) return null;
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : '';
    const url = typeof o.browser_download_url === 'string' ? o.browser_download_url : '';
    if (!/\.apk$/i.test(name) || !url) continue;
    const size = typeof o.size === 'number' && o.size > 0 ? o.size : 0;
    return { name, url, size };
  }
  return null;
}

/**
 * 从 /api/latest 的 JSON 文本解出升级信息。
 *
 * @param text 响应体文本
 * @param localVersion 本机安装包版本（来自原生桥 getVersion；网页版传 APP_VERSION）
 * @param kind 解析失败时给出的原因，用于文案
 */
export function parseLatest(
  text: string,
  localVersion: string,
): { ok: true; rel: LatestRelease } | { ok: false; reason: 'no-apk' | 'bad-json' | 'no-tag' | 'not-newer' } {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  if (!o || typeof o !== 'object') return { ok: false, reason: 'bad-json' };
  const obj = o as Record<string, unknown>;

  const rawTag = typeof obj.tag_name === 'string' ? obj.tag_name : '';
  const version = rawTag.replace(/^v/i, '').trim();
  if (!version) return { ok: false, reason: 'no-tag' };

  const apk = pickApk(obj.assets);
  if (!apk) return { ok: false, reason: 'no-apk' };

  // 🔴 比较放在最后：即使「已是最新」也要先把 apk 解析完，
  //   这样 "no-apk" 与 "not-newer" 是两种可区分的失败——
  //   前者说明服务端发了版但没挂 APK（要查），后者是正常状态。
  if (!isNewer(version, localVersion)) {
    return { ok: false, reason: 'not-newer' };
  }

  return {
    ok: true,
    rel: {
      tag: rawTag,
      version,
      notes: extractNotes(obj),
      url: apk.url,
      size: apk.size,
      hasUpdate: true,
    },
  };
}

/**
 * 提取更新要点。
 *
 * 🔴 优先用 `summary`（每条一句、整段 ≤40 字，人工浓缩），
 *   退回 `body` 的前几条。body 里要滤掉 GitHub 自动生成的那几行
 *   （"Full Changelog"、"更新日志"、"compare/..."、裸 URL、Markdown 链接），
 *   否则弹窗里会出现 "• compare/main...v1.0.0 (1 commit)" 这种给开发者看的行。
 *
 * 🔴 最多 4 条：弹窗高度有限，第 5 条起在手机上要滚动才看得到，
 *   而这几条是"要不要现在升"的判断依据，不该需要滚动。
 */
export function extractNotes(obj: Record<string, unknown>): string[] {
  let lines: string[] = [];
  const sum = obj.summary;
  if (Array.isArray(sum)) {
    lines = sum.map((s) => String(s));
  } else if (typeof sum === 'string' && sum.trim()) {
    lines = sum.split(/\r?\n/);
  }
  if (!lines.length && typeof obj.body === 'string') {
    lines = obj.body.split(/\r?\n/);
  }
  const cleaned = lines
    .map((s) => s.replace(/^\s*(?:[-*>#\s]+|\d+\.\s*)/, '').trim())
    .filter(Boolean)
    .filter((s) => !isNoiseLine(s))
    .slice(0, 4);
  return cleaned.length ? cleaned : ['详见发布页'];
}

/**
 * body 回退路径时要滤掉的行。
 *
 * 🔴🔴 判据难写在这里：GitHub Release 正文里"人不关心"的行有多种形态，
 *   而**剥 Markdown 前后缀发生在前面一步**，所以本函数看到的已经是剥过的文本。
 *   早先只写了 `完整更新详情`，结果 `**完整变更日志**: https://...` 剥掉前导 `**`
 *   变成 `完整变更日志**: https://...`，一条没滤掉，用户在弹窗里看到
 *   「· 完整变更日志**: https://github.com/.../compare/...」——
 *   给开发者看的行出现在老人手机上一行小字里。
 *   ⇒ 规则改成"**出现 compare/ 链接就整条丢**"，不再逐句枚举措辞。
 *     措辞会变（中文站/英文站/自己写的），链接形态不会。
 */
function isNoiseLine(s: string): boolean {
  return /compare\/|compare\/[a-z]+\.\.\./i.test(s)
    || /\[.*\]\(.*\)/.test(s)
    || /^https?:/i.test(s)
    || /^(?:v\d|更新日志|变更日志|完整更新详情|完整变更日志|full changelog)/i.test(s);
}
