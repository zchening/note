/**
 * MCP 单测。
 *
 * 🔴🔴 本文件最大的存在理由是钉住一类**tsc 查不出、只有真跑进程才炸**的坑：
 *   node 的类型剥离是 strip-only 模式（只擦类型、不生成代码），
 *   于是这些"合法 TypeScript"在运行时会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX：
 *     · 构造函数的**参数属性**（`constructor(private readonly x: T)`）
 *     · `enum`
 *     · `namespace`
 *     · 类的 `declare` 字段初始化、`import =`、`export =`
 *   本项目已经栽过一次：RemoteError 用了参数属性，typecheck 全绿，
 *   而 `node packages/mcp/src/main.ts` 起不来 —— 也就是"测试全绿但服务起不来"。
 *   所以下面 MJS-00 那条判据是机械扫源码的，与运行环境无关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { homedir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const read = (f) => readFileSync(path.join(srcDir, f), 'utf8');

function code(f) {
  return stripComments(read(f));
}

/**
 * 剥掉注释，**保留字符串与正则字面量**。
 *
 * 🔴🔴 为什么不能用两个 replace（这个坑踩了两次）：
 *   1) 行内 `replace(/(^|[^:])\/\/.*$/gm)` 里的 `[^:]` 是在**启发式**地避开
 *      "前面是冒号所以是 URL"。可一旦正则字面量或字符串里有 `//`，它照样误删。
 *   2) 块注释 `replace(/\/[\s\S]*?\*\//g)` 会被 **URL 里的 `//` 与 `/*` 骗**：
 *      `https://api.cloudinary.com/...` 里的 `/*` 会跨行匹配到很远的下一个
 *      块注释结束符，把中间整段真实代码一并删掉。
 *      症状是"判据报代码不存在，而那行代码好好地在那里" —— 极难自查。
 *
 * 这里只做一件可靠的事：**逐字符扫描，只跳注释**。
 * 字符串与正则字面量一律当普通字符原样搬出 —— 正则里的 `//` 会被原样保留，
 * 于是上面第2 条的坑自动消失。代价是字符串里的内容也会被搜到，
 * 所以**判据里出现"不得包含 X"时，X 必须是代码级标识符**（如 `method: 'PUT'`），
 * 不能是可能出现在用户可见文案里的词。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      out += ' ';
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '/') {
      let eol = src.indexOf('\n', i);
      if (eol < 0) eol = n;
      i = eol;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}/* ---------------- 语法可加载性 ---------------- */

test('MJS-00🔴 源码不得含 strip-only 模式不支持的语法（tsc 不报、只有真跑才炸）', () => {
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 8, '应至少有 8 个源文件，实得 ' + files.length);
  const banned = [
    { re: /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w+\s*[!:]/, why: '构造函数的参数属性' },
    { re: /^\s*(?:export\s+)?enum\s+\w+/m, why: 'enum' },
    { re: /^\s*(?:export\s+)?namespace\s+\w+/m, why: 'namespace' },
    { re: /^\s*(?:export\s+)?declare\s+module\s/m, why: 'declare module' },
    { re: /\bimport\s+\w+\s*=\s*require\(/, why: 'import = require()' },
    { re: /^\s*(?:export\s+)?import\s+\w+\s*=\s/m, why: 'export = / import =' },
  ];
  for (const f of files) {
    const bare = code(f);
    for (const b of banned) {
      const m = bare.match(b.re);
      assert.equal(
        m,
        null,
        `${f} 用了 strip-only 不支持的${b.why}：${m ? JSON.stringify(m[0].slice(0, 80)) : ''}。` +
          'tsc 不会报错，但 node 跑起来会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。',
      );
    }
  }
});

test('MJS-01 注释里不得出现会提前闭合注释块的序列', () => {
  // 踩过：某处写了 `/** insert_*/delete: ... */`，`*/` 提前闭合，
  // 后面的 `export interface` 落到注释外 → 整个文件语法报废。
  // 症状极具迷惑性：报错指向 interface，但真正的原因在上一行注释里。
  for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.ts'))) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      const open = l.indexOf('/*');
      if (open < 0) return;
      const close = l.indexOf('*/', open + 2);
      // 单行注释里 close 必须在 open 之后，且之后不该再出现成对的 /* 与 */
      if (close < 0) return;
      const after = l.slice(close + 2);
      if (/[A-Za-z一-鿿]+\s*[*\/]/.test(after) && !after.trim().startsWith('*')) {
        // 形如 "...*/delete: ..." —— 注释在词中间被闭合了
        assert.fail(`${f}:${i + 1} 注释在词中间闭合：${JSON.stringify(l.slice(0, 90))}`);
      }
    });
  }
});

/* ---------------- 配置 ---------------- */

test('MJS-02 配置默认值指向新项目，且拒绝复用老项目缓存目录', async () => {
  const { loadConfig, assertId } = await import('../src/config.ts');
  const c = loadConfig({});
  assert.equal(c.base, 'https://bj.xuyinji.com.cn');
  assert.ok(!c.cacheDir.includes('.notesync-mcp'), '不得默认用老项目的缓存根：' + c.cacheDir);
  assert.throws(
    () => loadConfig({ BJ_CACHE_DIR: homedir() + '/.notesync-mcp' }),
    /老项目/,
    '指到老项目缓存目录必须报错而不是照用',
  );
  assert.equal(assertId('  Note '), 'note', '必须归一化成小写');
  assert.throws(() => assertId('中文名'), /只允许/);
  assert.throws(() => assertId(''), /只允许/);
  assert.throws(() => assertId('a'.repeat(65)), /只允许/);
});

/* ---------------- 真源层复用（不许手写第二份） ---------------- */

test('MJS-03 MCP 必须复用真源层的加解密与 canonical，绝不自己实现', () => {
  const vault = read('vault.ts');
  assert.ok(vault.includes("from '@bj/shared-schema'"), '必须从真源层 import');
  const vc = code('vault.ts');
  // 自己写 PBKDF2 / 自己拼 base64 密文布局 = 两处实现 = 迟早不一致
  assert.ok(
    !/createHmac|PBKDF2|pbkdf2|createCipher|createDecipher/i.test(vc),
    '不得自己派生写入凭据或另写一套加解密（新服务端无写入凭据机制）',
  );
  assert.ok(vc.includes('deriveKey'), '必须调真源层的 deriveKey');
  assert.ok(vc.includes('encryptString') && vc.includes('decryptString'), '必须调真源层加解密');
  const doc = code('tools-doc.ts');
  assert.ok(!/crypto|createCipher|aes/i.test(doc), '文档工具不该碰加密');
});

test('MJS-04 提醒时间解析与提醒 id 必须复用网页端那份实现', () => {
  const rem = read('tools-remind.ts');
  assert.ok(
    rem.includes('time-parse.ts'),
    '必须 import 网页端的 time-parse.ts（中文时间规则必须与网页端一致）',
  );
  assert.ok(rem.includes('makeRemId'), '必须复用 makeRemId，否则同一条提醒会重复弹出');
  // 不得自己写一份相对时间文法。判据不能是"出现中文时间词"——
  //   错误提示里**应该**给用户可读的示例（"可写「明天下午三点」…"），
  //   那是这条工具最有用的部分之一。
  //   真正能区分"复用"与"重写"的是：有没有自己写匹配用的正则文法。
  const rc = code('tools-remind.ts');
  assert.ok(rc.includes('collectRelTimeMatches'), '必须调网页端那份解析器');
  assert.ok(
    !/(?:REL_RE|REL_GATE_RE|REL_FULLCN_RE|cnNum)\s*=/.test(rc),
    '不得自己定义中文时间文法常量——那说明重写了解析器',
  );
  // 中文时间词只允许出现在"给用户看的文案"里，不该出现在条件判断里
  const condLines = rc.split('\n').filter((l) => /明天|后天|大后天/.test(l) && /if\s*\(/.test(l));
  assert.equal(condLines.length, 0, '不得用中文时间词做条件判断：' + condLines.join(' | '));
});

test('MJS-04b 🔴 提醒覆盖判据必须是"同一时刻"而不是"同一时刻同一事项"（e2e 抓到的真缺陷）', () => {
  const rc = code('tools-remind.ts');
  const i = rc.indexOf("case 'add'");
  const seg = rc.slice(i, i + 1800);
  // 必须按时刻找已有提醒
  assert.ok(
    /atOf\(r\.at\) === at/.test(seg),
    '必须用"时刻相等"找同刻提醒；只按 id 匹配的话，"改一下提醒内容"会新增一条并重复弹',
  );
  assert.ok(seg.includes('overwrote: true'), '覆盖路径必须报 overwrote');
  // 🔴🔴 canonical 规则 2 是"省略默认值"：写 done: undefined 不等于省略，
  //   会一路被 validator 判 E_REMINDER_SHAPE 拒掉。
  //   症状是"改一下提醒内容"报"结构不合法"，而那行代码看起来完全正常。
  assert.ok(
    !/done:\s*undefined/.test(seg),
    '不得写 done: undefined 来"清除"完成态——那会被 validator 判结构不合法',
  );
  // 必须**重建**对象而不是展开原对象：{...r} 会把 done 一起带过来
  assert.ok(
    /const cleared: Reminder = \{ id: r\.id, at: r\.at, text \}/.test(seg),
    '必须显式重建提醒对象（{...r} 会把 done 带回来，清不掉）',
  );
  assert.ok(!/\.\.\.r,\s*text/.test(seg), '不得用 {...r, text} 改文案（done 会被带着走）');
  // 同时仍要复用 makeRemId 建新提醒
  assert.ok(seg.includes('makeRemId(at, text)'), '新建时必须走 makeRemId（与网页端同规则）');
});

test('MJS-05 工具描述必须写清"这是模型 JSON 不是 HTML"', () => {
  const main = read('main.ts');
  const i = main.indexOf("name: 'note_read'");
  assert.ok(i > 0, '应有 note_read 声明');
  const seg = main.slice(i, i + 1200);
  assert.ok(seg.includes('HTML'), 'note_read 的 description 必须点明"不要传 HTML"');
  const j = main.indexOf("name: 'note_edit'");
  const seg2 = main.slice(j, j + 1200);
  assert.ok(seg2.includes('偏移') || seg2.includes('行'), 'note_edit 必须说清按行还是按偏移');
});

/* ---------------- 搜索 ---------------- */

test('MJS-06 二元组只是粗筛，命中判据必须是原样子串', async () => {
  const { queryHit, tokenize } = await import('../src/tools-doc.ts');
  // 粗筛会误命中："会议"的二元组会撞上"商会"里的"商会"… 反之更典型：
  // 搜"会议"必须不能命中"协商"这类只有单字重合的文本
  assert.equal(queryHit('今天开协商会', '会议'), false, '"会议"不该命中"协商"');
  assert.equal(queryHit('今天开商会', '会议'), false);
  assert.equal(queryHit('今天开会议记录', '会议'), true);
  assert.equal(queryHit('abc def', 'ABC'), true, '拉丁词应大小写不敏感');
  assert.equal(queryHit('会议 2026', '2026'), true, '多词任一命中即可');
  assert.equal(queryHit('会议 2026', '2027'), false);
  assert.ok(tokenize('会议 2026').includes('2026'));
});

/* ---------------- zip ---------------- */

test('MJS-07 zip 往返（含中文名与大文件）', async () => {
  const { buildZip, readZip, crc32 } = await import('../src/zip.ts');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC32 必须与标准向量一致');
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}', 'utf8') },
    { name: '中文笔记名.md', data: Buffer.from('第一行\n第二行\n第二行是重复的重复的重复的\n', 'utf8') },
    { name: 'big.bin', data: Buffer.alloc(50000, 7) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = readZip(buildZip(entries));
  assert.equal(back.length, entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(back[i].name, entries[i].name, '第' + i + '项名字（中文名不能变问号）');
    assert.deepEqual(back[i].data, entries[i].data, '第' + i + '项内容');
  }
});

test('MJS-08 zip 必须拒路径穿越条目名（zip slip）', async () => {
  const { buildZip, readZip } = await import('../src/zip.ts');
  const zip = buildZip([{ name: '../evil.txt', data: Buffer.from('x') }]);
  assert.throws(() => readZip(zip), /路径穿越|非法/, '含 .. 的条目名必须拒');
  const abs = buildZip([{ name: '/etc/passwd', data: Buffer.from('x') }]);
  assert.throws(() => readZip(abs), /路径穿越|非法/, '绝对路径必须拒');
});

/* ---------------- 出码几何（老项目血泪的移植） ---------------- */

test('MJS-09 导出只允许 .zip 后缀（否则一次"导出"就能覆盖任意文件）', () => {
  const s = code('tools-backup.ts');
  assert.ok(s.includes('必须以 .zip 结尾'), 'out 必须校验后缀');
});

/* ---------------- 协议层 ---------------- */

test('MJS-10 工具错误必须是 isError + 纯文本（不是 JSON）', async () => {
  const { callTool } = await import('../src/rpc.ts');
  const ok = await callTool({ x: async () => ({ v: 1 }) }, 'x', {});
  assert.equal(ok.content[0].type, 'text');
  assert.equal(ok.isError, undefined);
  const bad = await callTool(
    {
      x: async () => {
        throw new Error('炸了');
      },
    },
    'x',
    {},
  );
  assert.equal(bad.isError, true);
  assert.ok(bad.content[0].text.startsWith('ERROR: '), '错误文本须以 ERROR: 开头');
  const none = await callTool({}, 'nope', {});
  assert.equal(none.isError, true, '未知工具也应是 isError 而不是抛协议错');
});

test('MJS-11 未知通知方法静默但留痕；有 id 的未知方法回 -32601', async () => {
  const main = read('main.ts');
  assert.ok(main.includes('-32601'), '有 id 的未知方法要回 method not found');
  assert.ok(main.includes("req.method.startsWith('notifications/')"), '通知类不该回响应但要留痕');
  // 🔴 判"不回响应"不能靠"没有 rpcResult"—— 那里有别的分支。
  //   钉住 default 分支里 return null 的事实。
  const i = main.indexOf('default:');
  const seg = main.slice(i, i + 700);
  assert.ok(seg.includes('return null'), '未知通知方法应 return null');
});

/* ---------------- 服务端契约对齐 ---------------- */

test('MJS-12 🔴 写入必须用 POST（服务端没有 PUT），且不得带 x-note-key/baseV', () => {
  const rc = code('remote.ts');
  assert.ok(rc.includes("method: 'POST'"), '写笔记必须是 POST');
  assert.ok(!/method:\s*'PUT'/.test(rc), '新服务端没有 PUT');
  // 🔴 用 code() 而不是 read()：这三个词在文件头的说明里必须留着
  //   （"新服务端没有 x-note-key"这句话本身就是文档），剥了注释才查得动。
  assert.ok(!rc.includes('x-note-key'), '新服务端无写入凭据机制，实现里不得出现该头');
  assert.ok(!rc.includes('baseV'), '新服务端 last-write-wins，实现里不得带 baseV');
  const vc = code('vault.ts');
  assert.ok(!vc.includes('x-note-key'), 'vault 也不得凭空造写入凭据');
});

test('MJS-13 🔴 读笔记返回 null 表示"不存在"（服务端对空笔记回 200+空体）', async () => {
  const rc = code('remote.ts');
  assert.ok(rc.includes("if (text.trim() === '') return null"), '空体必须映射成 null');
  // 上层必须真的区分 null 与"解不开"：null 是"没有"，抛错是"有但打不开"，
  // 两者混起来会让"新建第一篇笔记"这条路走不通。
  const vc = code('vault.ts');
  assert.ok(vc.includes('if (r === null) return null'), 'vault 必须把 null 透传上去');
  const ic = code('tools-doc.ts');
  assert.ok(ic.includes('note === null'), '工具层也必须按 null 分流');
});

test('MJS-14 🔴 429 必须单独分流（限流与其它错不同，重试才有意义）', () => {
  const rc = code('remote.ts');
  const n = (rc.match(/429/g) ?? []).length;
  assert.ok(n >= 3, 'get/put/upsign 都应处理 429，实得 ' + n + ' 处');
});

test('MJS-15 🔴 每个出网请求都必须有超时（老项目这里完全没超时）', () => {
  const rc = code('remote.ts');
  const fetches = (rc.match(/await this\.f\(/g) ?? []).length;
  const timeouts = (rc.match(/AbortSignal\.timeout\(/g) ?? []).length;
  assert.ok(fetches >= 4, '应有 4 个出网请求（get/put/del/upsign），实得 ' + fetches);
  assert.ok(
    timeouts >= fetches,
    `每个请求都要带超时：${fetches} 个请求只有 ${timeouts} 个 timeout`,
  );
});

test('MJS-16 🔴 换口令必须清密钥缓存（含 salt 的键）', () => {
  const v = code('vault.ts');
  const i = v.indexOf('setPassphrase');
  const seg = v.slice(i, i + 300);
  assert.ok(seg.includes('clear()'), 'setPassphrase 必须清缓存');
  assert.ok(v.includes('`${id}|${saltB64}`'), '缓存键必须含 salt');
});

test('MJS-17 🔴 口令错与数据坏必须报同一句（不给暴力破解 oracle）', () => {
  const v = code('vault.ts');
  const a = (v.match(/解密失败：口令不对或密文损坏/g) ?? []).length;
  assert.ok(a >= 2, '这句文案应在多处复用（不得各处措辞不同），实得 ' + a);
});

test('MJS-18 🔴 写入前必须过 validate（结构不合法不许上云）', () => {
  const v = code('vault.ts');
  const i = v.indexOf('async save(');
  const seg = v.slice(i, i + 900);
  assert.ok(seg.includes('validateDoc'), 'save 必须先 validate');
  assert.ok(seg.includes('canonicalize'), 'save 必须写 canonical 形态');
  assert.ok(seg.includes('幂等'), 'save 必须有 canonical 幂等自检');
});

test('MJS-19 🔴 clear 只清过期的，不动未来提醒', async () => {
  const s = code('tools-remind.ts');
  const i = s.indexOf("case 'clear'");
  const seg = s.slice(i, i + 500);
  assert.ok(seg.includes('atOf(r.at) >= now'), 'clear 必须保留未来提醒');
  assert.ok(seg.includes('cleared === 0'), '无可清时不得写远端');
});

test('MJS-20 🔴 cancel 只删提醒不动正文（新架构下正文与提醒本就解耦）', () => {
  const s = code('tools-remind.ts');
  const i = s.indexOf("case 'cancel'");
  const seg = s.slice(i, i + 500);
  assert.ok(seg.includes('reminders: list.filter'), '只应改 reminders');
  assert.ok(!seg.includes('blocks:'), '不该碰 blocks');
});

test('MJS-21 🔴 edit 锚点命中多处必须报歧义（绝不猜第一个）', () => {
  const s = code('tools-doc.ts');
  const i = s.indexOf('const hits: number[]');
  const seg = s.slice(i, i + 600);
  assert.ok(seg.includes('hits.length > 1'), '必须判歧义');
  assert.ok(seg.includes('无法确定'), '错误信息要说清为什么不能改');
});

test('MJS-22 🔴 图床地址必须校验域（不受控地址不能写进正文）', () => {
  const ic = code('tools-image.ts');
  // 🔴 判据要匹配的是**正则字面量**里的形态：源里写的是 /res\.cloudinary\.com\//，
  //   点被反斜杠转义过，所以不能判`'res.cloudinary.com'`（那种判据永远不成立）。
  //   这就是"判据说没有、代码明明有"的另一种形态 —— 判据自己写错了，不是代码错。
  assert.ok(
    /res\\?\.cloudinary\\?\./.test(ic),
    '必须校验图床域（找的是 /res\\.cloudinary\\./ 这个正则）',
  );
  assert.ok(ic.includes('已拒绝写入正文'), '拒绝时要说明原因');
  const i = read('tools-image.ts').indexOf('图片已上传成功');
  assert.ok(i > 0, '上传成功但写正文失败时必须报出 URL（否则用户重复上传）');
});

test('MJS-23 🔴 导入默认 preview，且内容不同默认不覆盖', () => {
  const s = code('tools-backup.ts');
  assert.ok(s.includes("mode !== 'preview' && mode !== 'apply'"), 'mode 只支持两值');
  assert.ok(s.includes('!args.force'), '非 force 必须跳过');
  assert.ok(s.includes("app !== 'notesync-bj'"), '必须校验包来源');
});

test('MJS-24 🔴 注册表坏掉不许挡正文读写', () => {
  const v = code('vault.ts');
  const i = v.indexOf('class Registry');
  const seg = v.slice(i, i + 1800);
  assert.ok(seg.includes('catch'), '注册表读/写都必须容错');
});
