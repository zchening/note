/**
 * 备份与恢复。
 *
 * 🔴 与老项目最大的结构差异：**没有"远端版本 vs 导出版本"这一层判断**。
 *   老项目服务端有baseV 乐观并发，导入时能比"远端第 42 版 / 导出时第 42 版"
 *   来决定覆盖还是跳过。新服务端 last-write-wins、根本不存版本号，
 *   所以"跳过冲突"这条保护在新架构下**没有判据可用**。
 *
 *   替代方案（也是本工具唯一的防误伤手段）：
 *   1. mode 默认 preview —— 什么都不写，只报告计划。AI 绝大多数情况下用 preview。
 *   2. apply 时**逐篇先读远端**，若远端非空且与包内内容**不同**，
 *      默认跳过并列入 skipped，只有 force=true 才覆盖。
 *      注意这比"比版本号"更保守：只要内容不同就跳，不问"谁新"。
 *      宁可让人重跑一次 force，也不要默认覆盖掉用户在网页上刚写的内容。
 *
 * 🔴 plain 模式产物含**明文正文**。这是它的用途（可读、可 grep），
 *   但必须在 description 里写明，落盘即裸奔。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize, emptyDoc } from '@bj/shared-schema';
import type { Doc } from '@bj/shared-schema';
import type { Vault } from './vault.ts';
import { assertId } from './config.ts';
import { plainOf } from './tools-doc.ts';
import { buildZip, readZip } from './zip.ts';

export interface BackupCtx {
  vault: Vault;
  defaultNote: string;
  listNames: () => string[];
  outDir: string;
}

export interface ExportArgs {
  names?: string[];
  mode?: 'plain' | 'raw';
  out?: string;
}

export async function toolExport(ctx: BackupCtx, args: ExportArgs): Promise<unknown> {
  const mode = args.mode ?? 'plain';
  if (mode !== 'plain' && mode !== 'raw') throw new Error('mode 只支持 plain | raw');
  const names = (Array.isArray(args.names) && args.names.length > 0 ? args.names : ctx.listNames())
    .map((n) => assertId(n));
  if (names.length === 0) throw new Error('没有可导出的笔记：注册表是空的。先用工具打开过某篇。');

  const entries: Array<{ name: string; data: Buffer }> = [];
  const manifestNotes: Array<Record<string, unknown>> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const done: Array<{ name: string; chars: number }> = [];

  for (const name of names) {
    const note = await ctx.vault.load(name).catch((e: unknown) => ({ err: e }));
    if (note === null) {
      skipped.push({ name, reason: '远端没有这篇笔记' });
      continue;
    }
    if (note && 'err' in note) {
      skipped.push({ name, reason: note.err instanceof Error ? note.err.message : String(note.err) });
      continue;
    }
    const doc = (note as { doc: Doc }).doc;
    if (mode === 'raw') {
      entries.push({
        name: `${name}.json`,
        data: Buffer.from(canonicalize(doc), 'utf8'),
      });
      manifestNotes.push({ name, chars: canonicalize(doc).length });
    } else {
      entries.push({ name: `${name}.md`, data: Buffer.from(plainOf(doc), 'utf8') });
      entries.push({
        name: `${name}.json`,
        data: Buffer.from(canonicalize(doc), 'utf8'),
      });
      manifestNotes.push({
        name,
        chars: canonicalize(doc).length,
        reminders: (doc.reminders ?? []).map((r) => ({ id: r.id, at: r.at, text: r.text, done: r.done })),
      });
    }
    done.push({ name, chars: canonicalize(doc).length });
  }

  const manifest = {
    app: 'notesync-bj',
    schema: 1,
    exportedAt: Date.now(),
    mode,
    noteCount: done.length,
    notes: manifestNotes,
  };
  // 🔴 manifest 必须在第一个：导入端按固定名字找它，放最后就得扫全包。
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  const zip = buildZip(entries);
  const stamp = new Date();
  const def = path.join(
    ctx.outDir,
    'notesync-bj-backup-' +
      `${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}` +
      `-${p2(stamp.getHours())}${p2(stamp.getMinutes())}.zip`,
  );
  // 🔴 出参是绝对路径且可由调用方指定 —— 只允许 .zip 后缀，
  //   否则一个"导出"调用就能覆盖用户机器上的任意文件。
  const out = args.out === undefined || args.out === '' ? def : String(args.out);
  if (!/\.zip$/i.test(out)) throw new Error('out 必须以 .zip 结尾：' + out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip);
  return {
    ok: true,
    path: out,
    bytes: zip.length,
    mode,
    notes: done,
    skipped,
    warn: mode === 'plain' ? 'plain 模式产物含明文正文与提醒事项，请自行妥善保管' : '',
  };
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

export interface ImportArgs {
  from: string;
  mode?: 'preview' | 'apply';
  names?: string[];
  to?: string;
  force?: boolean;
}

export async function toolImport(ctx: BackupCtx, args: ImportArgs): Promise<unknown> {
  const from = String(args.from ?? '');
  if (from === '') throw new Error('必须给 from（本工具 note_export 产出的 zip 路径）');
  const mode = args.mode ?? 'preview';
  if (mode !== 'preview' && mode !== 'apply') throw new Error('mode 只支持 preview | apply');
  let entries;
  try {
    entries = readZip(fs.readFileSync(from));
  } catch (e) {
    throw new Error(`读包失败：${from}（${(e as Error)?.message ?? String(e)}）`);
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const mEntry = byName.get('manifest.json');
  if (!mEntry) throw new Error('包里没有 manifest.json —— 这不是本工具导出的备份');
  let manifest: { app?: string; schema?: number; notes?: Array<{ name?: string }> };
  try {
    manifest = JSON.parse(mEntry.toString('utf8')) as typeof manifest;
  } catch {
    throw new Error('manifest.json 解析失败，包可能损坏');
  }
  if (manifest.app !== 'notesync-bj') throw new Error('这不是 NoteSync(bj) 的备份包（app=' + String(manifest.app) + '）');
  if (manifest.schema !== 1) throw new Error('备份包格式版本不支持：' + String(manifest.schema));

  const want = Array.isArray(args.names) && args.names.length > 0 ? new Set(args.names.map((n) => assertId(n))) : null;
  const plan: Array<Record<string, unknown>> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const applied: Array<Record<string, unknown>> = [];

  const listed = Array.isArray(manifest.notes) ? manifest.notes : [];
  for (const item of listed) {
    const orig = String(item.name ?? '');
    if (orig === '') continue;
    // 🔴 改名只允许单篇。多篇共一个目标名会互相覆盖，且报错太晚。
    const target = args.to !== undefined && args.to !== '' && listed.length === 1 ? assertId(args.to) : assertId(orig);
    if (want !== null && !want.has(target) && !want.has(orig)) continue;

    const jEntry = byName.get(`${orig}.json`);
    if (!jEntry) {
      skipped.push({ name: orig, reason: '包里缺 ' + orig + '.json' });
      continue;
    }
    let doc: Doc;
    try {
      doc = JSON.parse(jEntry.toString('utf8')) as Doc;
    } catch {
      skipped.push({ name: orig, reason: '笔记 JSON 解析失败' });
      continue;
    }

    const remote = await ctx.vault.load(target).catch(() => null);
    const remoteEmpty =
      remote === null ||
      ((remote.doc.blocks ?? []).length === 0 && (remote.doc.reminders ?? []).length === 0);
    if (remoteEmpty) {
      plan.push({ name: orig, target, action: 'create' });
    } else {
      const same = canonicalize(remote.doc) === canonicalize(doc);
      plan.push({ name: orig, target, action: same ? 'no-change' : 'overwrite' });
    }

    if (mode !== 'apply') continue;
    if (remote !== null) {
      const same = canonicalize(remote.doc) === canonicalize(doc);
      if (same) {
        applied.push({ name: orig, target, action: 'no-change' });
        continue;
      }
      if (!args.force) {
        // 🔴 内容不同且没 force → 跳过。理由见文件头第2 条。
        skipped.push({ name: orig, reason: '远端已有不同内容，需 force=true 才覆盖' });
        continue;
      }
    }
    try {
      const r = await ctx.vault.save(target, doc);
      applied.push({ name: orig, target, action: remoteEmpty ? 'create' : 'overwrite', chars: r.chars });
    } catch (e) {
      skipped.push({ name: orig, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (mode === 'preview') {
    return { plan, skipped, hint: '这是预览，什么都没写。要真写请 mode=apply' };
  }
  return { ok: true, applied, skipped };
}

export { emptyDoc };
