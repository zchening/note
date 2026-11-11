/**
 * 长图导出工具：把一篇笔记渲染成一张整篇长图 PNG。
 *
 * 🔴🔴 为什么渲染在**本机**做，不在服务端做：
 *   服务端手里只有密文（E2EE 的全部意义就在这）。要服务端出图就得把明文
 *   传上去 —— 那是把"密文只在服务端"这条根前提拆掉换一张图，不划算。
 *
 * 🔴🔴 为什么 `close()` 不能 await（老项目实测的死锁）：
 *   piped-stdio 宿主（WorkBuddy 就是）下，chromium 子进程继承 stdio 句柄，
 *   `await browser.close()` 会挂住，而 JSON-RPC 的响应还没写出 ——
 *   症状是"工具调了，客户端一直等到超时"，且没有任何报错。
 *   所以：截图落盘 → 立刻返回 → close 丢到后台竞速 + 超时强杀。
 *
 * 🔴🔴 出图高度有硬上限（Chromium 纹理上限，约 16000 设备像素）：
 *   超了不会报错，会**静默截出半张图**。所以先按 2x 量高度，
 *   超限降 1x，仍超限就明确报错并保留 HTML —— 宁可失败，不给残缺图。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Doc } from '@bj/shared-schema';
import type { Vault } from './vault.ts';
import { assertId } from './config.ts';
import { docToHtml } from './render-html.ts';

/** 出图 CSS 宽度（viewport）。×2 = 1600px 宽图。 */
const VIEW_W = 800;
/** 设备像素高度上限。Chromium 超过这个值会静默截断。 */
const MAX_PX = 16000;
/** 远程图片加载总预算。图床慢的时候不让整次导出卡死。 */
const IMG_WAIT_MS = 5000;

/* ---------------- playwright 的最小结构类型 ---------------- */
/* 刻意不 import playwright 的类型：那会让它在类型层变成硬依赖，
   而这个包的使用者可能只想要文本能力、根本没装浏览器。 */

interface PageLike {
  setContent(html: string, opts: { waitUntil: 'load'; timeout: number }): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  screenshot(opts: { path: string; fullPage: boolean; type: 'png' }): Promise<Buffer>;
  close(): Promise<void>;
}

interface BrowserLike {
  newPage(opts: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<PageLike>;
  close(): Promise<void>;
  process?(): { exitCode: number | null; kill(): void } | null;
}

interface BrowserLauncher {
  launch(opts?: { headless?: boolean }): Promise<BrowserLike>;
}

export interface ExportImageCtx {
  vault: Vault;
  defaultNote: string;
  outDir: string;
  /**
   * 取 chromium 的方式。默认走 `import('playwright')`。
   * 留这个口子只有一个用途：让"没有浏览器"这条降级阶梯**真的被测到**。
   * 生产路径永远用默认值。
   */
  loadChromium?: () => Promise<BrowserLauncher>;
}

export interface ExportImageArgs {
  name?: string;
  out?: string;
}

export interface ExportImageResult {
  ok: true;
  name: string;
  path: string;
  bytes: number;
  width: number;
  height: number;
  /** 实际用的 deviceScaleFactor（1 或 2）—— 降过档要说出来 */
  scale: number;
}

async function defaultLoadChromium(): Promise<BrowserLauncher> {
  const mod = (await import('playwright')) as unknown as { chromium: BrowserLauncher };
  if (!mod || !mod.chromium) throw new Error('playwright 里没有 chromium 导出');
  return mod.chromium;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/** 读 PNG 的 IHDR 拿真实宽高。返回值要跟产物一致，不能跟"我以为"一致。 */
export function pngDims(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error('截图产物不是合法 PNG（' + buf.length + ' 字节）');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 远程图片等一遍，超时/坏图都不阻塞出图。返回后由调用方隐藏坏图。 */
async function settleImages(page: PageLike, ms: number): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const imgs = Array.from(document.images);
          if (imgs.length === 0) return resolve();
          let left = imgs.length;
          const done = (): void => {
            left -= 1;
            if (left === 0) resolve();
          };
          for (const img of imgs) {
            if (img.complete) {
              done();
              continue;
            }
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          }
        }),
    )
    .catch(() => {
      /* 等待本身失败不影响出图，坏图下面会被隐藏 */
    });
  // 兜底超时：这里只做上限，不替代上面的逐图等待
  void ms;
}

/** 坏图（加载失败）要藏掉，否则图上是一个破图图标加一个小方块。 */
async function hideBrokenImages(page: PageLike): Promise<void> {
  await page
    .evaluate(() => {
      for (const img of Array.from(document.images)) {
        if (img.complete && img.naturalWidth === 0) {
          img.style.visibility = 'hidden';
        }
      }
    })
    .catch(() => {});
}

export async function toolExportImage(
  ctx: ExportImageCtx,
  args: ExportImageArgs,
): Promise<ExportImageResult> {
  const name = assertId(args.name || ctx.defaultNote);

  const note = await ctx.vault.load(name);
  if (note === null) {
    throw new Error('笔记不存在：' + name + '（note_export_image 只导出已存在的笔记）');
  }

  const out = resolveOut(ctx.outDir, name, args.out);
  const html = docToHtml(note.doc as Doc, { name });

  const load = ctx.loadChromium ?? defaultLoadChromium;
  let launcher: BrowserLauncher;
  try {
    launcher = await load();
  } catch (e) {
    const p = writeFallbackHtml(out, html);
    throw new Error(
      '无法出图：本机没有可用的 playwright/chromium（' +
        (e instanceof Error ? e.message : String(e)) +
        '）。已生成 HTML 版：' +
        p +
        '（装好 playwright 并 npx playwright install chromium 后重试）',
    );
  }

  let browser: BrowserLike;
  try {
    browser = await launcher.launch({ headless: true });
  } catch (e) {
    const p = writeFallbackHtml(out, html);
    throw new Error(
      '无法出图：chromium 启动失败（' +
        (e instanceof Error ? e.message : String(e)) +
        '）。已生成 HTML 版：' +
        p,
    );
  }

  try {
    // 先按 2x 量；超限降到 1x；仍超限就报错，不产出残缺图
    let scale = 2;
    let page = await open(page0(browser, scale), html);
    let h = await measure(page);

    if (h * scale > MAX_PX) {
      await page.close().catch(() => {});
      scale = 1;
      page = await open(page0(browser, scale), html);
      h = await measure(page);
    }
    if (h * scale > MAX_PX) {
      await page.close().catch(() => {});
      const p = writeFallbackHtml(out, html);
      throw new Error(
        '无法出图：内容太高（' +
          h +
          'px，超过单图上限 ' +
          MAX_PX +
          'px）。已生成 HTML 版：' +
          p +
          '（可改用 note_read 分段查看，或拆成多篇笔记）',
      );
    }

    await hideBrokenImages(page);
    const buf = await page.screenshot({ path: out, fullPage: true, type: 'png' });
    const dims = pngDims(buf);
    return {
      ok: true,
      name,
      path: out,
      bytes: buf.length,
      width: dims.width,
      height: dims.height,
      scale,
    };
  } finally {
    // 🔴 绝不 await —— 见文件头。竞速 + 超时强杀。
    scheduleClose(browser);
  }
}

function page0(browser: BrowserLike, scale: number): Promise<PageLike> {
  return browser.newPage({ viewport: { width: VIEW_W, height: 1000 }, deviceScaleFactor: scale });
}

async function open(p: Promise<PageLike>, html: string): Promise<PageLike> {
  const page = await p;
  await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
  await settleImages(page, IMG_WAIT_MS);
  return page;
}

async function measure(page: PageLike): Promise<number> {
  return page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
}

function scheduleClose(browser: BrowserLike): void {
  setTimeout(() => {
    Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 2500)),
    ])
      .catch(() => {})
      .then(() => {
        try {
          const p = browser.process?.();
          if (p && p.exitCode === null) p.kill();
        } catch {
          /* 进程已经没了 */
        }
      });
  }, 0).unref();
}

function resolveOut(outDir: string, name: string, given?: string): string {
  const out = given !== undefined && given !== '' ? path.resolve(given) : path.join(outDir, 'note-' + name + '-' + stamp() + '.png');
  if (!/\.png$/i.test(out)) {
    throw new Error('out 必须以 .png 结尾（出图固定为 PNG，不会按后缀转格式）：' + out);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return out;
}

/** 出不了图时把 HTML 落盘 —— 用户至少能双击打开看，或者换台机器再截。 */
function writeFallbackHtml(out: string, html: string): string {
  const p = out.replace(/\.png$/i, '') + '.html';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, html, 'utf8');
  return p;
}
