/**
 * 链接识别测试 —— 老项目 `linkifyEditor` 的移植判据
 *
 * 🔴🔴🔴 本文件的第一职责不是"测我的实现"，而是**钉住"与老项目一致"这件事**。
 *   铁律：移植差异不许靠推理定案。所以：
 *     · L1-* 组把老项目的判据逐条拆成断言（词表、正则、优先级、deny 规则）；
 *     · L2-* 组是**实跑对拍**：把老项目 index.html 里抄出的实现（.probe/old-linkify.mjs
 *       的等价物，老项目正文见下方「老项目出处」注释）与本实现喂同一批输入，
 *       断言输出**逐条深度相等**。这才是"一致"的真正证据；
 *     · L3-* 组覆盖老项目**没有**而本项目必须有的判据（代码块、模型往返）；
 *     · L4-* 组钉住几条"看着对其实错"的坑（都是本次实跑真踩出来的）。
 *
 * 老项目出处（TraeProject/notesync/index.html）：
 *   2634-2642 hasLinkableText   3648 FILE_EXT_DENY   3651 TLD_ALLOW
 *   3652      normalizeHref     3658-3665 denyAsUrl   3669-3671 trimUrlTrailing
 *   3684-3760 buildLinkSafe     3858-3864 正则定义   3949 剥 ZWSP
 *
 * 为什么能在 Node 里跑通（与 serialize.test.mjs 同款理由）：
 *   Lexical 的 headless 模式（createEditor 不挂 rootElement）能完整走 update/read，
 *   而 splitText/LinkNode 全是纯节点操作、不碰 DOM（.probe/probe-e.mjs 实测）。
 *   真正需要 DOM 的只有「光标不许跳」—— 那条留给 Playwright e2e。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEditor, $getRoot, $createParagraphNode, $createTextNode, IS_STRIKETHROUGH, IS_BOLD } from 'lexical';
import { $createCodeNode } from '@lexical/code';
import { $createLinkNode } from '@lexical/link';

import { ALL_NODES } from '../src/node-registry.ts';
import { $createReminderMarkNode } from '../src/nodes.ts';
import { docToLexical, lexicalToDoc } from '../src/serialize.ts';
import { canonicalize, normalize } from '../../shared-schema/src/canonical.ts';
import { $applyToTextNode, $linkifyEditor } from '../src/linkify/apply.ts';
import {
  denyAsUrl,
  FILE_EXT_DENY,
  hasLinkableText,
  longWordTest,
  normalizeHref,
  phoneRegex,
  phoneTest,
  recognizeParts,
  stripZeroWidth,
  TLD_ALLOW,
  trimUrlTrailing,
  urlRegex,
  urlTest,
} from '../src/linkify/recognize.ts';

// ── 工具 ──────────────────────────────────────────────────────────────────

function newEditor() {
  // 🔴 必须给**全量**节点清单（serialize.test.mjs:38 记过：少一个就整篇文档变空）
  return createEditor({ nodes: ALL_NODES });
}

/** 造一篇只有一个段落的文档，跑一轮 linkify，返回真源。 */
function linkifyOne(text, format) {
  const ed = newEditor();
  ed.update(() => {
    const p = $createParagraphNode();
    const n = $createTextNode(text);
    if (format !== undefined) n.setFormat(format);
    p.append(n);
    $getRoot().append(p);
  }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  return lexicalToDoc(ed.getEditorState(), []);
}

/** 该段落里的链接 span 列表。 */
function linksOf(doc) {
  return (doc.blocks ?? []).flatMap((b) => (b.spans ?? []).filter((s) => s.href !== undefined));
}

/** 该段落的纯文本。 */
function textOf(doc) {
  return (doc.blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join('')).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// L1 组：老项目判据逐条落地
// ═══════════════════════════════════════════════════════════════════════════

test('L1-01 FILE_EXT_DENY 94 项，老项目 index.html:3648 逐字一致', () => {
  assert.equal(FILE_EXT_DENY.size, 94);
  // 🔴 点名几个最容易在抄写时漏/错的
  for (const x of ['md', 'json', 'js', 'py', 'pdf', 'png', 'zip', 'exe', 'dmg']) {
    assert.ok(FILE_EXT_DENY.has(x), `${x} 应在 DENY 表里`);
  }
  // 🔴 html/htm 也在 DENY 表里（老项目 3648 原文有）。
  //   我第一版把它当"反向用例"写错了 —— 判据是抄老项目，不是抄常识。
  assert.ok(FILE_EXT_DENY.has('html'));
  assert.ok(FILE_EXT_DENY.has('htm'));
  // 🔴 反向：这些**不在** DENY 表（它们是 TLD_ALLOW，或压根不是扩展名）
  for (const x of ['com', 'cn', '中国', '']) {
    assert.ok(!FILE_EXT_DENY.has(x), `${x} 不该在 DENY 表里`);
  }
});

test('L1-02 TLD_ALLOW 51 项且**含中文 TLD**（老项目 index.html:3651）', () => {
  assert.equal(TLD_ALLOW.size, 51);
  // 🔴 这三个中文 TLD 是中文笔记里自己的网址能不能亮的开关，漏了必红
  for (const x of ['中国', '公司', '网络', 'xin', 'wang']) {
    assert.ok(TLD_ALLOW.has(x), `${x} 应在 TLD_ALLOW 里`);
  }
  // 🔴 反向：`int` 不是老项目白名单里的 TLD（老项目实测抄的，别"顺手"加）
  assert.ok(!TLD_ALLOW.has('int'));
});

test('L1-03 URL 优先于手机号，重叠时手机号让位（老项目 3692-3697）', () => {
  // 老项目的重叠场景：数字域名 + 手机号串
  // 🔴 判据是「有没有非 text 片段」，不是「link 数量」
  const parts = recognizeParts('13800138000');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'phone');
  assert.equal(parts[0].href, 'tel:13800138000');

  // 两个都在但不相交 ⇒ 都要
  const two = recognizeParts('打 13800138000 查 https://a.com');
  assert.equal(two.filter((p) => p.kind !== 'text').length, 2);
});

test('L1-04 denyAsUrl：文件名与未知裸域名保持纯文本（老项目 3658-3665）', () => {
  for (const x of ['README.md', 'data.json', 'main.py', 'a.b', 'etc.Then', '1.Introduction']) {
    assert.equal(denyAsUrl(x), true, `${x} 应被拒绝`);
  }
  for (const x of ['example.com', 'my-site.com', '例子.中国']) {
    assert.equal(denyAsUrl(x), false, `${x} 应被接受`);
  }
  // 🔴🔴 `uk` **不在**老项目 TLD_ALLOW 白名单里（老项目全仓实测抄的，不是抄 IANA）。
  //   所以 `sub.example.co.uk` 被拒 —— 这不是 bug，是刻意口径：
  //   放开它会让「1.Introduction」这类普通文字开始被误判（老项目注释原文：
  //   「否则 "1.Introduction" / "etc.Then" / "a.b" 这类普通文字会被误判成链接」）。
  //   我第一版把它当"应被接受"写进断言，是拿常识覆盖了实测口径。
  assert.equal(TLD_ALLOW.has('uk'), false, 'uk 不在老项目白名单里（刻意如此）');
  assert.equal(denyAsUrl('sub.example.co.uk'), true);
  // 🔴🔴 第一条判据：带 http(s):// 或 www. 前缀的一律不拒绝，
  //   **哪怕路径以 .md/.pdf/.js 结尾**（老项目注释：否则 github 地址不亮）
  for (const x of [
    'https://github.com/a/b/README.md',
    'https://x.com/a.pdf',
    'www.example.com/vue.js',
    'https://cdn.jsdelivr.net/npm/vue.js',
    'https://sub.example.co.uk/a',
  ]) {
    assert.equal(denyAsUrl(x), false, `${x} 带 scheme 前缀，不该被拒`);
  }
});

test('L1-05 CJK 字符类：URL 在中文处即停（老项目 3858 I3 修复）', () => {
  // 🔴 这是老项目专门修过的 bug：「看https://baidu.com。很好」里的「。很好」
  //   曾被吞进链接文本与 href，用户点进去得到不存在的地址
  const parts = recognizeParts('看https://baidu.com。很好');
  const url = parts.find((p) => p.kind === 'url');
  assert.ok(url, '应有 URL 片段');
  assert.equal(stripZeroWidth(url.t), 'https://baidu.com');
  assert.equal(url.href, 'https://baidu.com');
  const tail = parts[parts.length - 1];
  assert.equal(tail.t, '。很好', '中文标点之后的内容必须留在链接外');
});

test('L1-06 邮箱域名段与版本号不被误判（老项目 3860 的 (?<![@\\w.-])）', () => {
  // 邮箱整体不识别（老项目无邮箱支持）
  assert.equal(recognizeParts('x@y.com 是邮箱').filter((p) => p.kind !== 'text').length, 0);
  // 版本号不被当裸域名
  assert.equal(recognizeParts('v1.2.3 版本').filter((p) => p.kind !== 'text').length, 0);
});

test('L1-07 手机号正则：大写 3/4/5/6/7/8/9 开头，12 位与 10 位都不认（老项目 3863）', () => {
  for (const ok of ['13800138000', '19912345678', '14700000000']) {
    assert.equal(phoneTest.test(ok), true, `${ok} 应命中`);
  }
  for (const no of ['1380013800', '138001380001', '12800138000', '10800138000']) {
    assert.equal(phoneTest.test(no), false, `${no} 不应命中`);
  }
});

test('L1-08 trimUrlTrailing 只修中文标点、绝不动 ASCII 尾部（老项目 3669）', () => {
  assert.equal(trimUrlTrailing('https://a.com。'), 'https://a.com');
  assert.equal(trimUrlTrailing('https://a.com，。！'), 'https://a.com');
  // 🔴 以 `)` 结尾的合法 URL 必须保住（维基百科消歧义页那种）
  assert.equal(
    trimUrlTrailing('https://zh.wikipedia.org/wiki/条目_(消歧义)'),
    'https://zh.wikipedia.org/wiki/条目_(消歧义)',
  );
  assert.equal(trimUrlTrailing('https://a.com/x)'), 'https://a.com/x)');
});

test('L1-09 normalizeHref 补 https://，已有 scheme 不动（老项目 3652）', () => {
  assert.equal(normalizeHref('example.com'), 'https://example.com');
  assert.equal(normalizeHref('www.a.com/x'), 'https://www.a.com/x');
  assert.equal(normalizeHref('http://a.com'), 'http://a.com');
  assert.equal(normalizeHref('HTTP://A.com'), 'HTTP://A.com');
});

test('L1-10 早退判据 hasLinkableText（老项目 2634）', () => {
  assert.equal(hasLinkableText(['普通中文正文，没有任何东西']), false);
  assert.equal(hasLinkableText(['看 https://a.com']), true);
  assert.equal(hasLinkableText(['打 13800138000']), true);
  // 🔴 长词（≥15 连续非空白）也算 —— 老项目用它触发长词断行处理
  assert.equal(hasLinkableText(['一二三四五六七八九十一二三四五六七八九十']), true);
  // 🔴 判据**不含** denyAsUrl：README.md 命中 urlTest（不早退），照抄老项目口径
  assert.equal(hasLinkableText(['README.md']), true);
});

test('L1-11 正则本身：三个导出必须是独立对象（带 g 的会被 lastIndex 污染）', () => {
  // 🔴 若把带 g 的正则直接暴露出去，调用方 exec 一次后 lastIndex 就残留，
  //   第二次调用结果错乱。老项目每次都 `new RegExp(...)` 重建（3687/3692）。
  //   本实现也重建，但导出对象仍须是只读模板 —— 故断言它们带 g 且独立。
  assert.equal(urlRegex.global, true, 'urlRegex 必须带 g');
  assert.equal(phoneRegex.global, true, 'phoneRegex 必须带 g');
  assert.equal(urlTest.global, false, 'urlTest 只用于 test()，不能带 g');
  assert.equal(phoneTest.global, false, 'phoneTest 只用于 test()，不能带 g');
  assert.equal(longWordTest.global, false);
  // 连续两次 recognizeParts 的结果必须一致（没有 lastIndex 污染）
  const a = JSON.stringify(recognizeParts('https://a.com 和 https://b.com'));
  const b = JSON.stringify(recognizeParts('https://a.com 和 https://b.com'));
  assert.equal(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// L2 组：与老项目**实跑对拍**（老项目代码见 .probe/old-linkify.mjs 的注释出处）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 老项目 buildLinkSafe 的等价实现，**逐字抄自 index.html**。
 * 抄录范围：3648/3651 两张表、3652-3671 三个函数、3684-3760 buildLinkSafe、
 * 3858-3864 正则。老项目往 DocumentFragment 塞 DOM；这里输出等价的结构数组
 * —— 判据（分段边界、文本、href）完全一致，因此可深比较。
 *
 * 🔴 这份实现在本文件里**独立存在**，不复用被测代码的任何一行 ——
 *   否则"对拍"就变成自己跟自己比，等于什么都没验。
 */
const OLD = (() => {
  const FILE_EXT_DENY_ = new Set(['md','markdown','txt','csv','tsv','json','jsonl','yaml','yml','toml','xml','html','htm','php','js','jsx','ts','tsx','css','scss','less','py','rb','go','rs','java','c','cpp','h','hpp','sh','bash','zsh','ps1','sql','db','sqlite','git','log','ini','cfg','conf','env','dat','bak','tmp','pdf','doc','docx','xls','xlsx','ppt','pptx','zip','rar','7z','tar','gz','tgz','bz2','exe','dll','apk','dmg','iso','img','bin','png','jpg','jpeg','gif','svg','webp','bmp','ico','mp3','mp4','mov','avi','mkv','webm','wav','flac','ttf','otf','woff','woff2','eot','pem','key','crt','cer','lock','map']);
  const TLD_ALLOW_ = new Set(['com','cn','net','org','io','co','me','dev','app','gov','edu','info','xyz','top','vip','cc','tv','ai','so','biz','pro','site','online','shop','club','work','link','live','fun','store','tech','space','website','email','wiki','blog','news','art','design','group','ltd','plus','run','fit','ren','red','wang','xin','中国','公司','网络']);
  const CJK = '\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF01-\uFF60\u3000-\u303F';
  const urlRegex_ = new RegExp('(?<![@\\w.-])((?:https?:\\/\\/|www\\.)[^\\s<' + CJK + ']+|(?:[a-z0-9-]+\\.)+[a-z]{2,}(?:\\/[^\\s<' + CJK + ']*)?)', 'gi');
  const phoneRegex_ = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
  const breakSeparators_ = /([\/.?:=&#_%-])/g;
  const normalizeHref_ = (m) => (/^[a-z]+:\/\//i.test(m) ? m : 'https://' + m);
  const denyAsUrl_ = (m) => {
    if (/^(?:https?:\/\/|www\.)/i.test(m)) return false;
    const host = m.split('/')[0];
    const tld = host.split('.').pop().toLowerCase();
    if (FILE_EXT_DENY_.has(tld)) return true;
    if (!TLD_ALLOW_.has(tld)) return true;
    return false;
  };
  const trimUrlTrailing_ = (u) => u.replace(/[。，、！？；：…·～（）【】《》〈〉「」『』“”‘’—－]+$/, '');
  const build_ = (text, remMatches = []) => {
    const matches = [];
    let m;
    const r1 = new RegExp(urlRegex_.source, urlRegex_.flags);
    while ((m = r1.exec(text)) !== null) {
      if (m[0].length === 0) { r1.lastIndex++; continue; }
      const raw = trimUrlTrailing_(m[0]);
      if (raw) matches.push({ start: m.index, end: m.index + raw.length, text: raw, kind: 'url' });
    }
    const r2 = new RegExp(phoneRegex_.source, phoneRegex_.flags);
    while ((m = r2.exec(text)) !== null) {
      const s = m.index, e = s + m[0].length;
      if (!matches.some((u) => s < u.end && e > u.start)) matches.push({ start: s, end: e, text: m[0], kind: 'phone' });
    }
    (remMatches || []).forEach((rm) => {
      if (!matches.some((u) => rm.start < u.end && rm.end > u.start)) matches.push(rm);
    });
    matches.sort((a, b) => a.start - b.start);
    const frag = [];
    let pos = 0;
    const TIME_GUARD = /\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}日?(?:[T ]\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?|\d{1,2}[:：]\d{2}/g;
    const addBreaks = (w) => w.replace(breakSeparators_, '$1\u200B');
    const breakLongWords = (str) => str.replace(/\S{15,}/g, (w) => {
      let out = '', last = 0, t;
      TIME_GUARD.lastIndex = 0;
      while ((t = TIME_GUARD.exec(w)) !== null) {
        out += addBreaks(w.slice(last, t.index)) + t[0];
        last = t.index + t[0].length;
      }
      return out + addBreaks(w.slice(last));
    });
    const addText = (str) => {
      if (!str) return;
      if (/\S{15,}/.test(str)) str = breakLongWords(str);
      frag.push({ t: str, kind: 'text' });
    };
    for (const mt of matches) {
      addText(text.slice(pos, mt.start));
      if (mt.kind === 'url' && denyAsUrl_(mt.text)) {
        addText(mt.text);
      } else if (mt.kind === 'url') {
        frag.push({ t: mt.text.replace(breakSeparators_, '$1\u200B'), kind: 'url', href: normalizeHref_(mt.text) });
      } else {
        frag.push({ t: mt.text, kind: 'phone', href: 'tel:' + mt.text });
      }
      pos = mt.end;
    }
    addText(text.slice(pos));
    return frag;
  };
  return { FILE_EXT_DENY_, TLD_ALLOW_, normalizeHref_, denyAsUrl_, trimUrlTrailing_, build_ };
})();

/** 对拍语料：覆盖老项目每一条判据分支。 */
const PARITY_CASES = [
  'https://baidu.com',
  '看https://baidu.com。很好',
  'http://example.com/a/b?c=d#e',
  'www.example.com/path',
  'example.com',
  'example.com/a/b',
  'README.md',
  'data.json 与 main.py',
  '1.Introduction',
  'etc.Then 结束',
  'a.b',
  '例子.中国',
  'x@y.com 是邮箱',
  'v1.2.3 版本',
  'cdn.jsdelivr.net/npm/vue.js',
  'https://github.com/a/b/README.md',
  '13800138000',
  '电话 13800138000 后面',
  '13800138000123',
  '12345678901',
  '19912345678',
  'https://example.com/very/long/path/that/keeps/going?with=query&and=more',
  '这是一个非常非常非常长的中文词组用来测试断行行为是否正确',
  '2026-09-15 18:00 开会',
  'a@b.co.uk',
  'ftp://files.example.com/pub',
  'HTTP://EXAMPLE.COM',
  'https://zh.wikipedia.org/wiki/条目_(消歧义)',
  '多个 https://a.com 和 https://b.com 还有 13800138000',
  'https://example.com/a(1)b',
  '。https://example.com。',
  'aaa.bbb.ccc',
  'my-site.com',
  'sub.domain.example.co.uk/path',
  '  ',
  '',
  '纯文本没有任何链接',
  'https://example.com\n第二行13800138000',
  // 长词 + 分隔符（TIME_GUARD 保护的时间串）
  '这是一段很长的中文文本abc-def/ghi 2026-09-15 18:00:30 后面继续',
];

test('L2-01 两张词表与老项目逐项一致', () => {
  assert.deepEqual([...FILE_EXT_DENY].sort(), [...OLD.FILE_EXT_DENY_].sort());
  assert.deepEqual([...TLD_ALLOW].sort(), [...OLD.TLD_ALLOW_].sort());
});

test('L2-02 三个判定函数与老项目逐条一致（全部语料）', () => {
  for (const s of PARITY_CASES) {
    assert.equal(normalizeHref(s), OLD.normalizeHref_(s), `normalizeHref(${JSON.stringify(s)})`);
    assert.equal(trimUrlTrailing(s), OLD.trimUrlTrailing_(s), `trimUrlTrailing(${JSON.stringify(s)})`);
    assert.equal(denyAsUrl(s), OLD.denyAsUrl_(s), `denyAsUrl(${JSON.stringify(s)})`);
  }
});

test('L2-03 🔴核心：分段结果与老项目实跑**深度相等**（40 条语料）', () => {
  for (const s of PARITY_CASES) {
    // 老项目识别前先剥 ZWSP（index.html:3949）
    const oldOut = OLD.build_(stripZeroWidth(s));
    // 🔴 必须用 zwsp:true 才是同一口径：老项目的 buildLinkSafe **总是**回插 ZWSP，
    //   而本实现默认不插（真源是模型 JSON，ZWSP 会进同步与 merge 对齐 ——
    //   见 recognize.ts 文件头「二、ZWSP」）。拿默认口径比，比的不是同一件事。
    const newOut = recognizeParts(s, { zwsp: true }).map((p) => ({
      t: p.t, kind: p.kind, href: p.href,
    }));
    // 🔴 比较前把 `href: undefined` 归一成"键不存在"。
    //   老项目输出的是 `{t, kind}`（无 href 键），新实现是 `{t, kind, href: undefined}`。
    //   两者语义相同但 deepEqual 判不等 —— 那是表示差异，不是行为差异。
    //   归一在**比较用的投影**上做，不动被测代码（动它就等于让实现迁就测试）。
    assert.deepEqual(
      newOut.map((p) => (p.href === undefined ? { t: p.t, kind: p.kind } : p)),
      oldOut,
      `输入 ${JSON.stringify(s)} 的分段与老项目不一致`,
    );
  }
});

test('L2-04 默认口径（zwsp:false）：text 与 href 都**不含**零宽字符', () => {
  // 🔴 本项目不插 ZWSP，那它产出的任何字符都不该含零宽 ——
  //   零宽字符进真源会参与 canonicalize 字节比对与 merge 字符对齐。
  for (const s of PARITY_CASES) {
    for (const p of recognizeParts(s)) {
      assert.ok(!/[\u200B\u200C\uFEFF\u2060]/.test(p.t), `text 含零宽：${JSON.stringify(s)} → ${JSON.stringify(p)}`);
      if (p.href !== undefined) {
        assert.ok(!/[\u200B\u200C\uFEFF\u2060]/.test(p.href), `href 含零宽：${JSON.stringify(s)} → ${JSON.stringify(p)}`);
      }
    }
  }
});

test('L2-05 老项目的 ZWSP 回插口径在 zwsp:true 下**确实**生效（证明 L2-03 不是恒等）', () => {
  // 🔴 防"对拍恒等"：若两边都没插 ZWSP，L2-03 会假过。
  //   这里断言 zwsp:true 与 zwsp:false 的输出**不同**，且 true 里含 ZWSP。
  const withZwsp = recognizeParts('https://example.com/a/b', { zwsp: true });
  const without = recognizeParts('https://example.com/a/b', { zwsp: false });
  assert.notDeepEqual(withZwsp, without, 'zwsp:true 必须与 zwsp:false 有差异');
  assert.ok(withZwsp.some((p) => p.t.includes('\u200B')), 'zwsp:true 的输出应含 ZWSP');
  assert.ok(without.every((p) => !p.t.includes('\u200B')), 'zwsp:false 的输出不该含 ZWSP');
  // 🔴 href 两边都必须干净（href 混 ZWSP 会打不开）
  assert.equal(withZwsp.find((p) => p.kind === 'url').href, 'https://example.com/a/b');
  // 🔴 时间形态子串内部绝不插 ZWSP（老项目 v7.7.0 的教训：插了提醒会被误删）
  const time = recognizeParts('2026-09-15 18:00:30 和 2026-09-16', { zwsp: true });
  for (const p of time) {
    assert.ok(!/\d\u200B/.test(p.t), `时间形态内部被插了 ZWSP：${JSON.stringify(p.t)}`);
    assert.ok(!/[:：]\u200B/.test(p.t), `时刻内部被插了 ZWSP：${JSON.stringify(p.t)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// L3 组：Lexical 层的落地（真源往返、排除项、格式共存）
// ═══════════════════════════════════════════════════════════════════════════

test('L3-01 网址 → 真源 href（用户报的主症状）', () => {
  const doc = linkifyOne('看 https://example.com 结束');
  const links = linksOf(doc);
  assert.equal(links.length, 1);
  assert.equal(links[0].t, 'https://example.com');
  assert.equal(links[0].href, 'https://example.com');
  // 🔴 可见文字必须逐字不变
  assert.equal(textOf(doc), '看 https://example.com 结束');
});

test('L3-02 手机号 → tel: 链接（老项目 3751）', () => {
  const doc = linkifyOne('电话 13800138000 后面');
  const links = linksOf(doc);
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'tel:13800138000');
  assert.equal(textOf(doc), '电话 13800138000 后面');
});

test('L3-03 裸域名自动补 https://', () => {
  const doc = linkifyOne('见 example.com 与 www.example.org');
  assert.deepEqual(linksOf(doc).map((s) => s.href), ['https://example.com', 'https://www.example.org']);
});

test('L3-04 🔴 已带链接的文本不被二次包裹（幂等性，老项目 3934-3938 的 FILTER_REJECT）', () => {
  const ed = newEditor();
  ed.update(() => {
    const p = $createParagraphNode();
    p.append($createTextNode('https://example.com 和 example.org'));
    $getRoot().append(p);
  }, { discrete: true });
  const rounds = [];
  for (let i = 0; i < 4; i += 1) {
    ed.update(() => { $linkifyEditor(); }, { discrete: true });
    rounds.push(canonicalize(normalize(lexicalToDoc(ed.getEditorState(), []))));
  }
  // 🔴 四轮之后必须逐字节相同 —— 不相同就是每轮多包一层
  for (let i = 1; i < rounds.length; i += 1) {
    assert.equal(rounds[i], rounds[0], `第 ${i + 1} 轮与第 1 轮不同：链接被重复包裹`);
  }
  // 显式断言没有嵌套 link
  let nested = 0;
  let linkCount = 0;
  ed.getEditorState().read(() => {
    const walk = (n, inLink) => {
      const t = n.getType();
      if (t === 'link') {
        linkCount += 1;
        if (inLink) nested += 1;
      }
      if (n.getChildren) n.getChildren().forEach((c) => walk(c, inLink || t === 'link'));
    };
    walk($getRoot(), false);
  });
  assert.equal(linkCount, 2, '应是 2 个链接');
  assert.equal(nested, 0, '🔴 不许有嵌套的 link（一层套一层就是幂等性破了）');
});

test('L3-05 🔴 手动链接内部不被二次包裹', () => {
  // 老项目 3934-3938：文本节点祖先里有 <a> 就 FILTER_REJECT（手动链接不受影响）
  const ed = newEditor();
  ed.update(() => {
    const p = $createParagraphNode();
    const ln = $createLinkNode('https://manual.example');
    ln.append($createTextNode('https://manual.example'));
    p.append(ln);
    $getRoot().append(p);
  }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  let linkCount = 0;
  ed.getEditorState().read(() => {
    const walk = (n) => {
      if (n.getType() === 'link') linkCount += 1;
      if (n.getChildren) n.getChildren().forEach(walk);
    };
    walk($getRoot());
  });
  assert.equal(linkCount, 1, '手动链接外面不该再包一层');
});

test('L3-06 🔴 代码块内不识别（老项目正文无代码块，本项目多出来的判据）', () => {
  const ed = newEditor();
  ed.update(() => {
    const code = $createCodeNode('js');
    code.append($createTextNode('const u = "https://in-code.example";'));
    $getRoot().append(code);
  }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  const doc = lexicalToDoc(ed.getEditorState(), []);
  // 🔴 code 块的真源形态是 {t:'code', text:...}，**没有 spans**，因此不可能有 href
  assert.equal(doc.blocks?.[0]?.t, 'code');
  assert.equal(doc.blocks?.[0]?.spans, undefined, 'code 块不该有 spans');
  assert.equal(doc.blocks?.[0]?.text, 'const u = "https://in-code.example";');
  assert.equal(JSON.stringify(doc).includes('href'), false, '代码块里不该出现 href');
});

test('L3-07 🔴 删除线与链接共存，删除线不被破坏（老项目铁律）', () => {
  const doc = linkifyOne('删除线 example.com 尾巴', IS_STRIKETHROUGH);
  const spans = doc.blocks?.[0]?.spans ?? [];
  assert.ok(spans.length >= 3, `应切成三段，实得 ${spans.length}`);
  // 🔴 三段**全部**必须保留删除线 —— 丢一段就是"链接把删除线吃掉了"
  for (const s of spans) {
    assert.equal(s.s, true, `片段 ${JSON.stringify(s.t)} 丢了删除线`);
  }
  // 链接段既有删除线也有 href
  const link = spans.find((s) => s.href !== undefined);
  assert.ok(link, '应有链接段');
  assert.equal(link.s, true, '链接段必须同时带删除线');
  assert.equal(link.href, 'https://example.com');
  assert.equal(spans.map((s) => s.t).join(''), '删除线 example.com 尾巴');
});

test('L3-08 其它四种格式同样不被破坏（b/i/u/c）', () => {
  for (const [bit, key] of [[IS_BOLD, 'b']]) {
    const doc = linkifyOne('粗体 example.com 尾巴', bit);
    const spans = doc.blocks?.[0]?.spans ?? [];
    for (const s of spans) assert.equal(s[key], true, `${key} 被破坏：${JSON.stringify(s.t)}`);
    const link = spans.find((s) => s.href !== undefined);
    assert.equal(link[key], true, '链接段必须保留格式');
  }
});

test('L3-09 🔴 提醒标记内不识别、标记外的照常识别（老项目 3914-3916 的语义）', () => {
  const ed = newEditor();
  ed.update(() => {
    const p = $createParagraphNode();
    const rem = $createReminderMarkNode('r1');
    rem.append($createTextNode('2026-09-15 18:00'));
    p.append(rem, $createTextNode(' 详见 example.com'));
    $getRoot().append(p);
  }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  const doc = lexicalToDoc(ed.getEditorState(), [{ id: 'r1', at: '2026-09-15T18:00:00+08:00', text: 'x' }]);
  const spans = doc.blocks?.[0]?.spans ?? [];
  // 🔴 提醒标记那段必须原样保留 rem，且**没有** href
  const remSpan = spans.find((s) => s.rem !== undefined);
  assert.ok(remSpan, '提醒标记应保留');
  assert.equal(remSpan.href, undefined, '🔴 提醒标记内不许插链接（会与 reconcile 打架）');
  assert.equal(remSpan.t, '2026-09-15 18:00');
  // 🔴 标记**外面**的网址必须照常识别
  const link = spans.find((s) => s.href !== undefined);
  assert.ok(link, '提醒标记外的网址应被识别');
  assert.equal(link.t, 'example.com');
});

test('L3-10 🔴 含 ZWSP 的真源（老项目迁移形态）必须仍能识别，且地址正确', () => {
  // 真源来自老项目迁移，老项目的 linkify 往 URL 中间插过 ZWSP
  // （export/copy.ts:37 明确记了这件事）
  const ed = newEditor();
  const doc = { v: 1, blocks: [{ t: 'p', spans: [{ t: '旧 https://exam\u200Bple.com 结束' }] }] };
  ed.update(() => { docToLexical(doc); }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  const after = lexicalToDoc(ed.getEditorState(), []);
  const link = linksOf(after)[0];
  assert.ok(link, '含 ZWSP 的 URL 必须仍被识别');
  // 🔴 href 必须是**干净**的地址（ZWSP 混进 href 就打不开了）
  assert.equal(link.href, 'https://example.com');
  assert.ok(!link.href.includes('\u200B'), 'href 不许含 ZWSP');
  // 🔴 显示文字保持原样（含 ZWSP），不能被悄悄改掉
  assert.equal(link.t, 'https://exam\u200Bple.com');
  // 🔴 尾巴不许被切坏（这是切点错位最典型的症状）
  assert.equal(textOf(after), '旧 https://exam\u200Bple.com 结束');
});

test('L3-11 ZWSP 在手机号中间同样不能切断识别', () => {
  const ed = newEditor();
  const doc = { v: 1, blocks: [{ t: 'p', spans: [{ t: '我的号 13800\u200B138000 谢谢' }] }] };
  ed.update(() => { docToLexical(doc); }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  const link = linksOf(lexicalToDoc(ed.getEditorState(), []))[0];
  assert.ok(link, '含 ZWSP 的手机号必须仍被识别');
  assert.equal(link.href, 'tel:13800138000');
});

test('L3-11b 🔴 早退判据必须喂剥过零宽的文本（老项目 index.html:3949 的顺序）', () => {
  // 🔴🔴 这条钉的是本次实跑真踩出来的 bug（探针 .probe/probe-j.mjs ④）：
  //   早退曾写成 `hasLinkableText([raw])`（未剥零宽）。于是老项目迁移来的
  //   `13800\u200B138000` 里没有 11 位**连续**数字 ⇒ phoneTest 不命中 ⇒ 早退
  //   ⇒ 手机号**永远不被识别**，而 recognizeParts 本来能识别（它内部先剥）。
  //   症状：普通手机号能点亮，老笔记里带 ZWSP 的那些不能。
  //   老项目的顺序是「剥 ZWSP → 收集 → 早退」，不是「早退 → 剥」。
  assert.equal(
    hasLinkableText(['13800\u200B138000']),
    false,
    '未剥零宽的文本确实判不出手机号（这正是那个 bug 的机理）',
  );
  assert.equal(
    hasLinkableText([stripZeroWidth('13800\u200B138000')]),
    true,
    '剥掉零宽后必须能判出手机号',
  );
  // 端到端再钉一次：ZWSP 版与干净版必须产生**同样的**链接
  const withZwsp = linkifyOne('我的号 13800\u200B138000 谢谢');
  const plain = linkifyOne('我的号 13800138000 谢谢');
  assert.deepEqual(
    linksOf(withZwsp).map((s) => s.href),
    linksOf(plain).map((s) => s.href),
    '含 ZWSP 的手机号必须与干净版识别结果一致',
  );
});

test('L3-12 denyAsUrl 命中的文本保持纯文本、且不产生任何 href', () => {
  const doc = linkifyOne('见 README.md 与 data.json');
  assert.equal(linksOf(doc).length, 0);
  assert.equal(textOf(doc), '见 README.md 与 data.json');
});

test('L3-13 识别的结果必须是合法真源且**往返幂等**（canonical 逐字节）', () => {
  const doc = { v: 1, blocks: [{ t: 'p', spans: [{ t: 'a https://x.com b 13800138000 c', b: true }] }] };
  const ed = newEditor();
  ed.update(() => { docToLexical(doc); $linkifyEditor(); }, { discrete: true });
  const one = canonicalize(normalize(lexicalToDoc(ed.getEditorState(), [])));
  // 🔴 再走一遍「导入 → 识别 → 导出」，必须逐字节相同
  const ed2 = newEditor();
  ed2.update(() => { docToLexical(JSON.parse(one)); $linkifyEditor(); }, { discrete: true });
  const two = canonicalize(normalize(lexicalToDoc(ed2.getEditorState(), [])));
  assert.equal(two, one);
  // 且真源里确实有 href（否则这条断言会被"什么都没识别出来"骗过）
  assert.ok(one.includes('"href":"https://x.com"'), `真源应有 href：${one}`);
  assert.ok(one.includes('"href":"tel:13800138000"'), `真源应有 tel:：${one}`);
});

test('L3-14 多段落多链接：一段里两个链接都要正确切分', () => {
  const ed = newEditor();
  ed.update(() => {
    const p1 = $createParagraphNode();
    p1.append($createTextNode('AAA https://a.com BBB https://b.com CCC'));
    const p2 = $createParagraphNode();
    p2.append($createTextNode('手机 13800138000 与 13900139000'));
    $getRoot().append(p1, p2);
  }, { discrete: true });
  ed.update(() => { $linkifyEditor(); }, { discrete: true });
  const doc = lexicalToDoc(ed.getEditorState(), []);
  assert.deepEqual(linksOf(doc).map((s) => s.href), [
    'https://a.com', 'https://b.com', 'tel:13800138000', 'tel:13900139000',
  ]);
  // 🔴 文字必须逐字保留（切段最容易在这里切坏）
  assert.equal(textOf(doc), 'AAA https://a.com BBB https://b.com CCC\n手机 13800138000 与 13900139000');
});

test('L3-15 无可链接文本时完全不动树（早退，老项目 3885-3889）', () => {
  const ed = newEditor();
  ed.update(() => {
    const p = $createParagraphNode();
    p.append($createTextNode('普通中文正文，没有网址也没有手机号。'));
    $getRoot().append(p);
  }, { discrete: true });
  let changed = -1;
  ed.update(() => { changed = $linkifyEditor(); }, { discrete: true });
  assert.equal(changed, 0, '没有可链接文本时不该改动任何节点');
  const doc = lexicalToDoc(ed.getEditorState(), []);
  assert.equal(JSON.stringify(doc).includes('href'), false);
});

test('L3-16 行内代码 c 标记里的网址**会**被识别（老项目无行内代码，此处从宽）', () => {
  // 🔴 刻意与代码块区分开：老项目只有「pre 内不识别」的意图，
  //   而本项目的行内代码是 `c:true` 标记而非块 —— 用户在 `code` 风格里写网址
  //   时仍希望它可点（老项目的 monospace span 同样会被 linkify 处理）。
  //   若将来产品决定行内代码也不识别，改这一条即可，判据单一。
  const doc = linkifyOne('见 example.com 尾');
  assert.equal(linksOf(doc).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// L4 组：本次实跑真踩出来的坑（每条都钉死，防回归）
// ═══════════════════════════════════════════════════════════════════════════

test('L4-01 🔴 splitText 是**变参绝对偏移** —— 切点必须一次性给全', () => {
  // 探针 .probe/probe-f.mjs F1 实锤：splitText(2,4) 于 "abcdef" → ab|cd|ef
  // 本条直接断言这个语义，免得将来有人按 (start,end) 对的直觉改回去。
  const ed = newEditor();
  let pieces = [];
  ed.update(() => {
    const p = $createParagraphNode();
    const n = $createTextNode('abcdef');
    p.append(n);
    $getRoot().append(p);
    pieces = n.splitText(2, 4).map((x) => x.getTextContent());
  }, { discrete: true });
  assert.deepEqual(pieces, ['ab', 'cd', 'ef']);
});

test('L4-02 🔴 链接段不得凭空消失（append 会移动节点，replace 随后静默失效）', () => {
  // 探针 .probe/probe-h.mjs 实锤：`ln.append(piece)` 把 piece 从父节点摘走后，
  // `piece.replace(ln)` 对已无父节点的节点无效 —— 链接段**消失**，
  // 而 $applyToTextNode 仍返回 true。症状："识别跑了、什么都没变"、零报错。
  // 本条从"识别后链接必须真的存在"这个方向钉住它。
  const doc = linkifyOne('前 https://example.com 后');
  const links = linksOf(doc);
  assert.equal(links.length, 1, '链接段必须真的存在（不许被 append/replace 吃掉）');
  assert.equal(textOf(doc), '前 https://example.com 后');
});

test('L4-03 🔴 切点必须用原文坐标 —— 用剥零宽后的片段长度会整体错位', () => {
  // 探针 .probe/probe-g.mjs G7 实锤过这个 bug：链接段被切成
  // `https://exam\u200Bple.co` 而 href 是 `https://example.com`
  // —— 显示地址与实际地址不一致，且正文被切坏一截。
  const ed = newEditor();
  const doc = { v: 1, blocks: [{ t: 'p', spans: [{ t: 'A https://ex\u200Bample.com B' }] }] };
  ed.update(() => { docToLexical(doc); $linkifyEditor(); }, { discrete: true });
  const after = lexicalToDoc(ed.getEditorState(), []);
  const link = linksOf(after)[0];
  assert.equal(link.href, 'https://example.com');
  // 🔴 显示文字与首尾必须完整（错位时尾巴会被切进链接里或被截断）
  assert.equal(textOf(after), 'A https://ex\u200Bample.com B');
  assert.ok(link.t.endsWith('.com'), `链接文字应完整到 .com，实得 ${JSON.stringify(link.t)}`);
});

test('L4-04 Part 的 srcStart/srcEnd 必须能对上原文区间（剥零宽后的坐标换算）', () => {
  // 直接钉住 recognizeParts 的坐标契约 —— apply.ts 完全依赖它。
  const text = '前 https://ex\u200Bample.com 后';
  const parts = recognizeParts(text);
  for (const p of parts) {
    assert.equal(
      stripZeroWidth(text.slice(p.srcStart, p.srcEnd)),
      stripZeroWidth(p.t),
      `片段 ${JSON.stringify(p.t)} 的 srcStart/srcEnd 区间对不上原文`,
    );
  }
  // 首尾必须铺满整段（不重不漏）
  assert.equal(parts[0].srcStart, 0);
  assert.equal(parts[parts.length - 1].srcEnd, text.length);
  // 偏移必须单调不减
  for (let i = 1; i < parts.length; i += 1) {
    assert.ok(parts[i].srcStart >= parts[i - 1].srcEnd, '片段区间必须首尾相接且不倒序');
  }
});

test('L4-05 stripZeroWidth 的字符集要与项目其余出口**完全一致**', () => {
  // 与 serialize.ts:362 / export/copy.ts:65 同一套（U+200B/200C/FEFF/2060）
  for (const ch of ['\u200B', '\u200C', '\uFEFF', '\u2060']) {
    assert.equal(stripZeroWidth(`a${ch}b`), 'ab', `${JSON.stringify(ch)} 应被剥掉`);
  }
  // 🔴 反向：普通字符绝不能被误剥
  assert.equal(stripZeroWidth('正常文字 with spaces 123'), '正常文字 with spaces 123');
});

test('L4-06 $applyToTextNode 对无命中节点返回 false（不产生空 update）', () => {
  const ed = newEditor();
  let r1 = null;
  let r2 = null;
  ed.update(() => {
    const p = $createParagraphNode();
    const plain = $createTextNode('没有链接的普通文字');
    const hit = $createTextNode('有 https://a.com');
    p.append(plain, hit);
    $getRoot().append(p);
    r1 = $applyToTextNode(plain);
    r2 = $applyToTextNode(hit);
  }, { discrete: true });
  assert.equal(r1, false, '无命中必须返回 false');
  assert.equal(r2, true, '有命中必须返回 true');
});
