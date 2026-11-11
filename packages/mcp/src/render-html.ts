/**
 * 长图渲染：真源 doc → 自包含 HTML。
 *
 * 🔴🔴 为什么不是"把 HTML 丢给浏览器截"（老 MCP 的做法）：
 *   老项目的真源就是 HTML 字符串，天然能截。本项目的真源是**块数组**，
 *   手上根本没有 HTML —— 这一层的存在就是为了补掉这个差。
 *
 * 🔴🔴 为什么必须自包含（内联 CSS、无外链）：
 *   截图环境是 `page.setContent()`，没有 baseURL。任何 `<link rel=stylesheet>`
 *   都会相对 about:blank 解析成 404，而**失败是静默的**：
 *   图照样出，只是全部退化成浏览器默认样式（黑体大字、无留白），
 *   用户看到的是"一张能看但很难看的图"，不会报错。
 *   同理不许有 `<script>`：截图不执行页面脚本也不需要，留着只是多一个注入面。
 *
 * 🔴🔴 折叠必须**默认展开**：
 *   长图的用途是"把整篇发给别人看"。折叠组如果不展开，
 *   用户导出后才发现后半篇是空的，而图已经发出去了。
 *
 * 渲染参数对齐老 MCP（800 宽 / 15px / 行高 1.7 / 2x），
 * 目的是让两边导出的图放在一起看不出是两个产品。
 */
import type { Block, Doc, Reminder, Span } from '@bj/shared-schema';

export interface RenderOpts {
  /** 笔记名（页头标题）。空则页头只留日期 */
  name?: string;
  /** 出图日期文案，默认取本机今天。测试可传死值避免时钟依赖 */
  date?: string;
}

/* 日期格式化不用月份名数组：那个做法对"日"是错的（见 fmtDate 注释）。 */

/**
 * 页头日期 `YYYY-MM-DD`。
 *
 * 🔴 不要用"月份名数组 + 下标"，那玩意儿对**日**是错的：
 *   `MONTH[d.getDate()]` 在 11 号印成 12 号，31 号直接印 `undefined`
 *   （数组只有 12 个元素）。两种错都不会报错，只会印错 ——
 *   判据 RENDER-10 用 1 号 / 11 号 / 31 号三个点钉死它。
 */
export function fmtDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function today(): string {
  return fmtDate(new Date());
}

/**
 * 提醒时间 → 图上要显示的墙上时间。
 *
 * 🔴 不用 `new Date(iso).getHours()`：那会把用户所在时区的墙上时间
 *   换算到**截图机器**的时区。服务器在 UTC、用户在 +08 时，
 *   上午 9 点的提醒会印成凌晨 1 点 —— 而这种错没人会去核对。
 *   `Reminder.at` 的契约是"完整 ISO 带偏移"，墙上面上的时间就是它字面写的那几个数字。
 */
export function remWallTime(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(at || ''));
  if (!m) return String(at || '');
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
}

/** HTML 转义。顺序必须是 & 先，否则 &lt; 会被二次转义成 &amp;lt;。 */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 单个 span → HTML。标记从内往外套，保证 `<b><i>x</i></b>` 这类叠加不互相吞。 */
function spanToHtml(sp: Span, remById: Map<string, Reminder>): string {
  let out = esc(sp.t);
  if (sp.s) out = '<s>' + out + '</s>';
  if (sp.u || sp.rem) {
    if (sp.rem) {
      const r = remById.get(sp.rem);
      const tip = r ? ' title="' + esc(remWallTime(r.at) + ' ' + r.text) + '"' : '';
      out = '<u class="rem" data-rem="' + esc(sp.rem) + '"' + tip + '>' + out + '</u>';
    } else {
      out = '<u>' + out + '</u>';
    }
  }
  if (sp.i) out = '<i>' + out + '</i>';
  if (sp.b) out = '<b>' + out + '</b>';
  if (sp.c) out = '<code>' + out + '</code>';
  if (sp.href) out = '<a href="' + esc(sp.href) + '">' + out + '</a>';
  return out;
}

function spansToHtml(spans: readonly Span[] | undefined, remById: Map<string, Reminder>): string {
  if (!spans) return '';
  let out = '';
  for (const sp of spans) out += spanToHtml(sp, remById);
  return out;
}

function blockToHtml(b: Block, remById: Map<string, Reminder>): string {
  switch (b.t) {
    case 'hr':
      return '<hr>';
    case 'img': {
      const alt = esc(b.imgAlt ?? '');
      const src = esc(b.src ?? '');
      return '<figure class="img"><img src="' + src + '" alt="' + alt + '"></figure>';
    }
    case 'code': {
      const lang = b.lang ? ' data-lang="' + esc(b.lang) + '"' : '';
      return '<pre class="code"' + lang + '><code>' + esc(b.text ?? '') + '</code></pre>';
    }
    case 'fold': {
      const title = spansToHtml(b.title, remById);
      const kids = (b.children ?? []).map((c) => blockToHtml(c, remById)).join('');
      return (
        '<div class="fold"><div class="fold-title">▼ ' +
        title +
        '</div><div class="fold-body">' +
        kids +
        '</div></div>'
      );
    }
    case 'ul':
    case 'ol': {
      const tag = b.t;
      const kids = (b.children ?? []).map((c) => blockToHtml(c, remById)).join('');
      return '<' + tag + '>' + kids + '</' + tag + '>';
    }
    case 'li': {
      const own = spansToHtml(b.spans, remById);
      const kids = (b.children ?? []).map((c) => blockToHtml(c, remById)).join('');
      // 子块要包一层列表，否则段落会裸在 li 里、缩进全丢
      const nested = kids === '' ? '' : '<ul>' + kids + '</ul>';
      return '<li>' + own + nested + '</li>';
    }
    case 'quote':
      return '<blockquote>' + spansToHtml(b.spans, remById) + '</blockquote>';
    case 'h1':
    case 'h2':
    case 'h3':
      return '<' + b.t + '>' + spansToHtml(b.spans, remById) + '</' + b.t + '>';
    case 'p':
    default:
      return '<p>' + spansToHtml(b.spans, remById) + '</p>';
  }
}

function remindersToHtml(list: readonly Reminder[] | undefined): string {
  if (!list || list.length === 0) return '';
  // 未完成的排前面：用户看图是要看"还要做什么"，已完成只是留痕
  const sorted = [...list].sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)));
  const items = sorted
    .map((r) => {
      const cls = r.done ? 'rem done' : 'rem';
      const mark = r.done ? '✓ ' : '';
      return (
        '<li class="' +
        cls +
        '"><span class="at">' +
        esc(remWallTime(r.at)) +
        '</span><span class="tx">' +
        mark +
        esc(r.text) +
        '</span></li>'
      );
    })
    .join('');
  return (
    '<section class="rems"><div class="rems-h">提醒</div><ul>' + items + '</ul></section>'
  );
}

const CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0}',
  'body{background:#F5F3EE;color:#1A1C23;',
  'font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
  '-webkit-font-smoothing:antialiased}',
  '.sheet{width:800px;margin:0 auto;background:#fff;border:1px solid #E6E1D6;padding:36px 44px 28px}',
  '.head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}',
  '.date{font-size:12px;color:#6B6F76;letter-spacing:.04em}',
  '.rule{height:2px;width:44px;background:#8C6A2F;margin-top:10px}',
  '.stamp{font:11px/1.4 ui-monospace,Consolas,monospace;color:#9A9EA6;letter-spacing:.16em;' +
    'text-transform:uppercase;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  'h1,h2,h3{margin:22px 0 10px;line-height:1.45;font-weight:700}',
  'h1{font-size:21px}h2{font-size:18px}h3{font-size:16px}',
  'p{margin:0 0 12px;word-break:break-word}',
  'blockquote{margin:14px 0;padding:8px 14px;border-left:3px solid #E6E1D6;color:#3A3D44;background:#FAF9F6}',
  'pre.code{margin:14px 0;padding:12px 14px;background:#F7F6F2;border:1px solid #EAE6DC;border-radius:6px;',
  'white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,Consolas,monospace;color:#2C2F36}',
  'code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:#F2F1EC;padding:1px 4px;border-radius:3px}',
  'pre.code code{background:none;padding:0;font-size:13px}',
  'ul,ol{margin:0 0 12px;padding-left:22px}',
  'li{margin:2px 0;word-break:break-word}',
  'li>ul,li>ol{margin:2px 0 2px}',
  'hr{border:0;border-top:1px solid #E6E1D6;margin:20px 0}',
  'figure.img{margin:16px 0}',
  'figure.img img{max-width:100%;height:auto;display:block;border-radius:4px}',
  '.fold{margin:14px 0;border:1px solid #EAE6DC;border-radius:6px;overflow:hidden}',
  '.fold-title{padding:8px 12px;background:#FAF9F6;font-weight:600;color:#3A3D44}',
  '.fold-body{padding:10px 14px 2px}',
  '.fold-body>*:last-child{margin-bottom:8px}',
  'u.rem{text-decoration:underline;text-decoration-color:#C8A24A;text-underline-offset:3px;text-decoration-thickness:2px}',
  'a{color:#2456C8;text-decoration:none;border-bottom:1px solid rgba(36,86,200,.32)}',
  '.rems{margin-top:26px;padding-top:14px;border-top:1px solid #E6E1D6}',
  '.rems-h{font-size:12px;font-weight:700;color:#6B6F76;letter-spacing:.14em;margin-bottom:8px}',
  '.rems ul{list-style:none;padding:0;margin:0}',
  '.rems li.rem{display:flex;gap:10px;font-size:13px;color:#3A3D44;margin:3px 0}',
  '.rems li.rem .at{color:#6B6F76;white-space:nowrap;font-variant-numeric:tabular-nums}',
  '.rems li.rem.done .tx{text-decoration:line-through;color:#9A9EA6}',
  '.foot{margin-top:24px;padding-top:12px;border-top:1px solid #F0EDE5;',
  'font-size:11px;color:#9A9EA6;letter-spacing:.14em}',
].join('');

/**
 * 真源 → 完整 HTML 文档。
 *
 * 产物是**给无头浏览器**吃的，不是给人直接打开的：宽度写死 800，
 * 由 `deviceScaleFactor:2` 出 1600 宽的图。
 */
export function docToHtml(doc: Doc, opts: RenderOpts = {}): string {
  const remList = doc.reminders ?? [];
  const remById = new Map<string, Reminder>();
  for (const r of remList) remById.set(r.id, r);

  const body = (doc.blocks ?? []).map((b) => blockToHtml(b, remById)).join('');
  const name = opts.name ?? '';
  const date = opts.date ?? today();

  // 页头对齐 App 内导出卡：左侧金题线 + 日期，右角笔记名刻印（不做大标题，
  // 大标题若需要由正文自己的 h1 承担 —— 否则一篇里会出现两个标题层级）。
  const head =
    '<header class="head">' +
    '<div class="hd-l"><div class="date">' +
    esc(date) +
    '</div><div class="rule"></div></div>' +
    (name === '' ? '' : '<div class="stamp">' + esc(name) + '</div>') +
    '</header>';

  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>' +
    esc(name) +
    '</title>' +
    '<style>' +
    CSS +
    '</style></head><body><div class="sheet">' +
    head +
    '<main class="body">' +
    body +
    '</main>' +
    remindersToHtml(remList) +
    '<footer class="foot">NOTESYNC</footer>' +
    '</div></body></html>'
  );
}
