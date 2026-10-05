/**
 * 图片工具：上传到图床并作为 img 块插入正文。
 *
 * 🔴 签发走服务端 `/api/upsign`（与网页端同一条路），**绝不本地直传免签**。
 *   免签直投看着"少一个依赖"，实际是把图床暴露成任何人可写。
 *
 * 🔴 上传与写入**分成两步且上传在前**，中间任何失败都报出已上传的 URL ——
 *   症状最坏是"云端多了一张没人引用的图"，而不是"图在本地、正文没有图"
 *   （后者会让用户重传，而云端其实已经有那张图了）。
 */
import * as fs from 'node:fs';
import { emptyDoc } from '@bj/shared-schema';
import type { Block, Doc } from '@bj/shared-schema';
import type { Vault } from './vault.ts';
import type { Remote, UpsignResult } from './remote.ts';
import { assertId } from './config.ts';
import { blockText } from '@bj/shared-schema';

const IMG_MAX_BYTES = 8 * 1024 * 1024;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const CLOUD_FALLBACK = 'dntsgx6t3';

export interface ImageArgs {
  name?: string;
  op?: 'add' | 'remove';
  path?: string;
  /** add: 锚点纯文本子串；remove: 图片 URL 或其子串 */
  match?: string;
  where?: 'before' | 'after';
}

export interface ImageCtx {
  vault: Vault;
  remote: Remote;
  defaultNote: string;
}

export async function toolImage(ctx: ImageCtx, args: ImageArgs): Promise<unknown> {
  const op = args.op ?? 'add';
  if (op === 'remove') return removeImage(ctx, args);
  if (op !== 'add') throw new Error('op 只支持 add | remove');
  return addImage(ctx, args);
}

async function addImage(ctx: ImageCtx, args: ImageArgs): Promise<unknown> {
  const name = assertId(args.name || ctx.defaultNote);
  const p = String(args.path ?? '');
  if (p === '') throw new Error('必须给 path（本机图片绝对路径）');
  if (!IMG_EXT_RE.test(p)) throw new Error('只支持 png/jpg/jpeg/gif/webp：' + p);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    throw new Error(`读取图片失败：${p}（${(e as { code?: string })?.code ?? String(e)}）`);
  }
  if (buf.length > IMG_MAX_BYTES) {
    throw new Error(
      `图片超过 8MB（实际 ${(buf.length / 1048576).toFixed(1)}MB）；本工具直传不压缩，请先缩小`,
    );
  }

  // ① 先上传。失败就到此为止，正文一个字都没动。
  const sign = await ctx.remote.upsign(name);
  const url = await cloudUpload(buf, p, sign);

  // ② 再写正文。这里失败要把已上传的 URL 说出来。
  try {
    const note = await ctx.vault.load(name);
    const doc: Doc = note === null ? emptyDoc() : note.doc;
    const blocks = [...(doc.blocks ?? [])];
    const block: Block = { t: 'img', src: url };
    let inserted: 'inline' | 'append';
    const anchor = args.match;
    if (anchor !== undefined && anchor.trim() === '') {
      throw new Error('match 给了空白串：要么给非空的锚点，要么整个不给');
    }
    if (anchor === undefined) {
      blocks.push(block);
      inserted = 'append';
    } else {
      const hits: number[] = [];
      for (let i = 0; i < blocks.length; i += 1) {
        if (blockText(blocks[i]).includes(anchor)) hits.push(i);
      }
      if (hits.length === 0) throw new Error(`锚点未命中任何一行：${JSON.stringify(anchor)}`);
      if (hits.length > 1) {
        throw new Error(
          `锚点在 ${hits.length} 行里都出现（块序号 ${hits.join(', ')}），无法确定插哪一处。`,
        );
      }
      const i = hits[0];
      blocks.splice(args.where === 'before' ? i : i + 1, 0, block);
      inserted = 'inline';
    }
    const r = await ctx.vault.save(name, { ...doc, blocks });
    return { ok: true, name, url, inserted, blocks: r.chars };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 🔴🔴 这一条不能省。吞掉它，用户看到的是"插入失败"，
    //   于是重传同一张图 —— 云端就会堆一堆重复图，而用户完全不知道。
    throw new Error(`${msg}｜图片已上传成功：${url}（可在 note_read 里看到，也可手动填回正文）`);
  }
}

async function removeImage(ctx: ImageCtx, args: ImageArgs): Promise<unknown> {
  const name = assertId(args.name || ctx.defaultNote);
  const target = String(args.match ?? '').trim();
  if (target === '') throw new Error('remove 必须给 match（图片 URL 或其子串）');
  const note = await ctx.vault.load(name);
  if (note === null) throw new Error(`笔记不存在：${name}`);
  const blocks = [...(note.doc.blocks ?? [])];
  const hits: Array<{ i: number; src: string }> = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.t === 'img' && typeof b.src === 'string' && b.src.includes(target)) {
      hits.push({ i, src: b.src });
    }
  }
  if (hits.length === 0) {
    const have = blocks
      .filter((b): b is Block & { src: string } => b.t === 'img' && typeof b.src === 'string')
      .map((b) => b.src);
    throw new Error(
      `没有匹配的图片。${have.length === 0 ? '这篇笔记里没有任何图片。' : '现有图片：' + have.join('　')}`,
    );
  }
  if (hits.length > 1) {
    throw new Error(`匹配到 ${hits.length} 张图片，删哪一张？请给更长的 URL 片段。`);
  }
  blocks.splice(hits[0].i, 1);
  const r = await ctx.vault.save(name, { ...note.doc, blocks });
  return { ok: true, name, op: 'remove', removed: hits[0].src, chars: r.chars };
}

async function cloudUpload(buf: Buffer, filePath: string, sign: UpsignResult): Promise<string> {
  const cloud = sign.cloud_name || CLOUD_FALLBACK;
  const fd = new FormData();
  // 🔴 不设 Content-Type：让 fetch 自己带 boundary。
  //   手写 multipart 头是这类代码最常见的 bug 来源（boundary 前后差一个 \r\n 就全废）。
  fd.append('file', new Blob([new Uint8Array(buf)]), filePath.split(/[\\/]/).pop() ?? 'image');
  fd.append('api_key', sign.api_key);
  fd.append('timestamp', sign.timestamp);
  fd.append('signature', sign.signature);
  if (sign.upload_preset) fd.append('upload_preset', sign.upload_preset);
  if (sign.folder) fd.append('folder', sign.folder);
  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`图片上传失败：${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) throw new Error(`图片上传失败：HTTP ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { secure_url?: string };
  const url = j.secure_url ?? '';
  // 🔴 前缀校验必须做：签名请求被中间人改写、或图床返回了预期外的地址时，
  //   把这个 URL 写进正文 = 让所有读者去访问一个不受控地址。
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) {
    throw new Error('图床返回的地址不在预期域内，已拒绝写入正文：' + JSON.stringify(url));
  }
  return url;
}
