/**
 * 长图导出判据 —— doc→HTML 渲染 + 真浏览器出图 + 降级阶梯。
 *
 * 🔴🔴 为什么这批判据必须 import 生产代码、而不是扫源码：
 *   渲染器的输出是**给用户看的图**，扫源码只能证明"某个字符串在文件里"，
 *   证明不了"折叠里的字真的画出来了"。上一轮项目里已经栽过
 *   `if (!deps.saveToAlbum)` 被 handler 里同名串骗绿的账。
 *
 * 🔴🔴 真出图那条判据必须真跑 chromium：
 *   单测绿≠真浏览器绿（v3.0.7 实栽）。PNG 头与宽高是从产物字节里读的，
 *   不是从我们自己返回的字段里读的 —— 后者只能证明"我以为我截了"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';

import { docToHtml, fmtDate } from '../src/render-html.ts';
import { toolExportImage } from '../src/tools-render.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 一个把 12 种块类型全用上的文档。 */
function fullDoc() {
  return {
    v: 1,
    blocks: [
      { t: 'h1', spans: [{ t: '一级标题' }] },
      { t: 'h2', spans: [{ t: '二级标题' }] },
      { t: 'h3', spans: [{ t: '三级标题' }] },
      { t: 'p', spans: [{ t: '普通段落' }] },
      { t: 'quote', spans: [{ t: '引用的话' }] },
      { t: 'hr' },
      { t: 'code', text: 'const a = 1;\n  console.log(a);', lang: 'js' },
      { t: 'img', src: 'https://res.cloudinary.com/demo/x.png', imgAlt: '配图' },
      {
        t: 'ul',
        children: [
          { t: 'li', spans: [{ t: '第一项' }] },
          { t: 'li', spans: [{ t: '第二项' }] },
        ],
      },
      { t: 'ol', children: [{ t: 'li', spans: [{ t: '编号一' }] }] },
      {
        t: 'fold',
        title: [{ t: '折叠组标题' }],
        children: [{ t: 'p', spans: [{ t: '折叠里的秘密文字' }] }],
      },
    ],
    reminders: [
      { id: 'r1', at: '2026-11-20T15:00:00+08:00', text: '跟客户确认方案' },
      { id: 'r2', at: '2026-11-12T09:00:00+08:00', text: '已经办完的事', done: true },
    ],
  };
}

/* ---------------- RENDER：doc→HTML 结构 ---------------- */

test('RENDER-01 十二种块类型都渲染成对应标签', () => {
  const html = docToHtml(fullDoc(), { name: '周会纪要' });
  assert.match(html, /<h1>一级标题<\/h1>/);
  assert.match(html, /<h2>二级标题<\/h2>/);
  assert.match(html, /<h3>三级标题<\/h3>/);
  assert.match(html, /<p>普通段落<\/p>/);
  assert.match(html, /<blockquote>引用的话<\/blockquote>/);
  assert.match(html, /<hr/);
  assert.match(html, /<pre[^>]*><code[^>]*>const a = 1;/);
  assert.match(html, /<img[^>]+src="https:\/\/res\.cloudinary\.com\/demo\/x\.png"/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>第一项<\/li>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<li>编号一<\/li>/);
});

test('RENDER-02 图片的 alt 落到 alt 属性，不是正文里的裸文字', () => {
  const html = docToHtml(fullDoc(), { name: 'x' });
  assert.match(html, /<img[^>]+alt="配图"/);
});

test('RENDER-03 折叠默认展开：子块文字必须真的出现在产物里，标题带展开标记', () => {
  const html = docToHtml(fullDoc(), { name: 'x' });
  // 这是本功能的用户可见核心：长图里看不到折叠内容＝白导出
  assert.ok(html.includes('折叠里的秘密文字'), '折叠的子块没渲染出来');
  // ▼ = 已展开；用 ▸ 会在静态图上骗人（看着像还能点开）
  assert.ok(html.includes('▼'), '折叠标题缺少展开标记');
  assert.ok(html.includes('折叠组标题'));
});

test('RENDER-03b 笔记名印在页头右上角刻印位（多篇长图要分得清谁是谁）', () => {
  const html = docToHtml(fullDoc(), { name: '周会纪要' });
  assert.match(html, /<div class="stamp">周会纪要<\/div>/);
});

test('RENDER-04 span 的六种标记各自映射，且叠加不互相吞', () => {
  const doc = {
    v: 1,
    blocks: [
      {
        t: 'p',
        spans: [
          { t: '粗', b: true },
          { t: '斜', i: true },
          { t: '下', u: true },
          { t: '删', s: true },
          { t: '码', c: true },
          { t: '链', href: 'https://x.cn/a b' },
          { t: '提醒', rem: 'r1' },
        ],
      },
    ],
  };
  const html = docToHtml(doc, { name: 'x' });
  assert.match(html, /<b>粗<\/b>/);
  assert.match(html, /<i>斜<\/i>/);
  assert.match(html, /<u>下<\/u>/);
  assert.match(html, /<s>删<\/s>/);
  assert.match(html, /<code>码<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.cn\/a b">链<\/a>/);
  assert.match(html, /<u class="rem" data-rem="r1">提醒<\/u>/);
});

test('RENDER-05 正文里的 HTML 必须转义，不能当标签执行', () => {
  const doc = {
    v: 1,
    blocks: [{ t: 'p', spans: [{ t: '<script>alert(1)</script> & "引号"' }] }],
  };
  const html = docToHtml(doc, { name: 'x' });
  assert.ok(!html.includes('<script'), '正文里的标签没转义，真的会被当标签执行');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&quot;引号&quot;'));
});

test('RENDER-06 提醒清单：时间可读、事项在、已完成的要标出来', () => {
  const html = docToHtml(fullDoc(), { name: 'x' });
  assert.ok(html.includes('提醒'), '缺少提醒小节');
  assert.ok(html.includes('跟客户确认方案'));
  assert.ok(html.includes('已经办完的事'));
  assert.match(html, /2026-11-20 15:00/);
  // 已完成的条目必须有可见痕迹，否则用户在图上分不清办没办
  assert.match(html, /class="rem done"[^>]*>|class="done"/);
});

test('RENDER-07 没有提醒时不留空小节', () => {
  const html = docToHtml({ v: 1, blocks: [{ t: 'p', spans: [{ t: '只有正文' }] }] }, { name: 'x' });
  assert.ok(html.includes('只有正文'));
  assert.ok(!html.includes('class="rems"'), '没有提醒却渲染了提醒小节');
});

test('RENDER-08 空文档不崩、不吐 undefined/NaN', () => {
  const html = docToHtml({ v: 1 }, { name: '空笔记' });
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 100);
  assert.ok(!html.includes('undefined'), '产物里出现了 undefined');
  assert.ok(!html.includes('NaN'));
});

test('RENDER-09 产出的 HTML 自包含：内联样式，无外链样式表、无脚本', () => {
  const html = docToHtml(fullDoc(), { name: 'x' });
  assert.match(html, /<style>/);
  assert.ok(!/<link[^>]+stylesheet/i.test(html), '不能引外部样式表（截图时会 404 丢样式）');
  assert.ok(!/<script/i.test(html), '不能带脚本（截图环境不需要，也堵注入面）');
  assert.ok(html.includes('charset="utf-8"'), '缺 charset 会把中文渲染成乱码');
});

/**
 * 页头日期。这条判据是补的：先前"避免时钟依赖"跳过了日期断言，
 * 结果真图出来时 11 号印成了 12 号（MONTH[d.getDate()] 少减 1），
 * 全套判据全绿 —— 典型的"没钉到就等于没有"。
 */
test('RENDER-10 页头日期格式：月日都补零，且不从数组越界取', () => {
  assert.equal(fmtDate(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(fmtDate(new Date(2026, 10, 11)), '2026-11-11');
  assert.equal(fmtDate(new Date(2026, 11, 31)), '2026-12-31');
  // 默认日期必须走同一个格式化器，不能另写一套
  const html = docToHtml({ v: 1 }, { name: 'x' });
  assert.ok(html.includes('>' + fmtDate(new Date()) + '</div>'), '默认日期没走 fmtDate');
});

/* ---------------- IMG：真浏览器出图 ---------------- */
/** 读 PNG 的 IHDR：宽高直接从产物字节读，不信任工具自己的返回值。 */
function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '不是 PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const fakeVault = (doc) => ({
  load: async () => ({ doc, env: {}, bytes: 123 }),
});

test('IMG-01 真跑 chromium 出图：PNG 头对、宽度=1600（800×2）、高度足够、文件有内容', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'ns-render-'));
  const doc = {
    v: 1,
    blocks: [
      { t: 'h2', spans: [{ t: '出图验收' }] },
      ...Array.from({ length: 12 }, (_, i) => ({ t: 'p', spans: [{ t: '第 ' + (i + 1) + ' 段正文，用来把高度撑起来。' }] })),
      { t: 'fold', title: [{ t: '折叠' }], children: [{ t: 'p', spans: [{ t: '折叠里的字' }] }] },
    ],
  };
  try {
    const r = await toolExportImage(
      { vault: fakeVault(doc), defaultNote: 'e2e', outDir },
      { name: 'e2e' },
    );
    assert.equal(r.ok, true);
    assert.ok(existsSync(r.path), '返回了路径但文件不存在');
    const buf = readFileSync(r.path);
    assert.ok(buf.length > 5000, 'PNG 太小，多半是白图：' + buf.length + ' 字节');
    const { width, height } = pngSize(buf);
    assert.equal(width, 1600, '出图宽度不是 1600（viewport 800 × dsf 2）');
    assert.ok(height > 500, '高度太小，内容没画进去：' + height);
    assert.equal(r.width, width, '返回的宽与产物实际宽不一致');
    assert.equal(r.height, height, '返回的高与产物实际高不一致');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('IMG-02 没有 playwright 时：落一张 HTML 并报错带路径，绝不假成功', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'ns-render-fb-'));
  try {
    let err = null;
    try {
      await toolExportImage(
        {
          vault: fakeVault({ v: 1, blocks: [{ t: 'p', spans: [{ t: '正文' }] }] }),
          defaultNote: 'fb',
          outDir,
          loadChromium: async () => {
            throw new Error('模拟：本机没有 playwright');
          },
        },
        { name: 'fb' },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, '没有浏览器却成功了——这是谎报');
    const m = String(err.message || '');
    assert.ok(m.includes('HTML'), '错误信息没说明已落 HTML 兜底：' + m);
    const hit = m.match(/([A-Za-z]:[\\/][^\s"'）)]+\.html|\/[^\s"'）)]+\.html)/);
    assert.ok(hit, '错误信息里没有 HTML 路径：' + m);
    assert.ok(existsSync(hit[1].replace(/\\/g, path.sep)), '错误里给的 HTML 路径不存在：' + hit[1]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('IMG-03 out 参数：不是 .png 结尾直接拒，不静默改后缀', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'ns-render-out-'));
  try {
    await assert.rejects(
      () =>
        toolExportImage(
          { vault: fakeVault({ v: 1 }), defaultNote: 'x', outDir },
          { name: 'x', out: path.join(outDir, 'note.jpg') },
        ),
      /\.png/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('IMG-04 笔记不存在时说清楚，不是抛底层解密码错误', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'ns-render-miss-'));
  try {
    await assert.rejects(
      () =>
        toolExportImage(
          { vault: { load: async () => null }, defaultNote: 'nope', outDir },
          { name: 'nope' },
        ),
      /不存在/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
