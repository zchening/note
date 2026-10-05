/**
 * 图片上传 —— 压缩 + 图床签名直传
 *
 * 🔴 移植依据：老项目 index.html:2346-2420 + server.js:647-668（v10.0.0 形态）。
 *   **不靠推理定案**，两处源码都读过。差异点在下面逐条标注。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么必须服务端签发（老项目 v10.0.0 血泪）
 *
 *   此前是**免签名 preset 直传**，而 cloud_name + preset 名就印在页面源码里。
 *   任何人拿它就能往本站 Cloudinary 账号白图：烧配额、塞违规内容连累封号。
 *   改法：preset 转 Signed，签名由自家服务端一次一签。
 *   云端 secret 只当**配额闸门**，不碰笔记明文，零知识不破。
 *
 * 🔴 三条协议纪律（我第一版漏了前两条，是读老项目才发现的）：
 *
 *   1. **强制 JSON content-type**。
 *      不要求的话这是 simple 请求，任意恶意网页都能跨域连发要签名；
 *      要求了就触发预检，而本服务不回 ACAO 头，浏览器直接拦死。
 *      老项目 v5.52 的 /api/fail 用的是同一手法。
 *
 *   2. **签名只覆盖参与签名的那几个参数**。
 *      多带一个未签参数就会被 Cloudinary 判签名不符。
 *      刻意**不传** public_id / transformation —— 签名只覆盖
 *      folder + timestamp + upload_preset 三项，public_id 交云端随机生成，
 *      前端无从控制（老项目原注释：这是安全的一部分）。
 *
 *   3. **服务端日志绝不记 secret / 签名**，只记时间与归属笔记。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么图片是 DecoratorNode 而不是 inline element（ARCH.md §4.2）
 *
 *   图片是真嵌入 UI，不参与行内文本流。inline 的话两端合并时会被当成
 *   可逐字比较的字符，退化成"整块替换"；decorator 是"光标到此为止"的原子，
 *   语义上正好匹配。
 */

import { $createImageBlockNode } from '../nodes.ts';
import { $getSelection, $isRangeSelection, $insertNodes, $createParagraphNode } from 'lexical';
import type { LexicalEditor } from 'lexical';

/** 压缩后的目标边长上限（老项目 1600px，同值）。 */
const MAX_EDGE = 1600;
/** JPEG 质量（老项目 0.85，同值）。 */
const JPEG_QUALITY = 0.85;
/** 单张上限（老项目没设，但必须有 —— 否则用户误传 200MB 文件会拖垮手机）。 */
const MAX_INPUT_BYTES = 30 * 1024 * 1024;

export interface UpSignTicket {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  uploadPreset: string;
  folder: string;
}

export interface UploadDeps {
  /** 现有笔记 id（只用于服务端日志归属，不参与签名）。 */
  noteId: string;
  /** 当前页面 origin（同源，走相对路径即可）。 */
  base: string;
  /** 失败时的用户可见提示。必须是给人看的一句话。 */
  onError: (msg: string) => void;
  /** 过程中的状态提示。 */
  onStatus: (msg: string) => void;
  /**
   * 成功提示。
   *
   * 🔴 与 onStatus 分开而不是复用：两者驻留时长不同
   *   （过程态常驻、成功态2 秒自动收），共用一个回调就得在回调里
   *   猜"这次是过程还是成功"，那是把状态藏进副作用的老毛病。
   */
  onOk: () => void;
}

/* ------------------------------------------------------------------ *
 * 压缩
 * ------------------------------------------------------------------ */

/**
 * 压成 JPEG Blob。
 *
 * 🔴 为什么必须压：手机直出照片动辄 4~8MB，Cloudinary 免费额度按
 *   带宽计费，裸传既烧配额又让上传慢到用户以为坏了。
 *
 * 🔴 压缩失败**不静默降级**成"直接传原图" —— 那正是烧配额的路径。
 *   老项目同款：reject 让上层走失败分支。
 */
async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('不是图片文件');
  if (file.size > MAX_INPUT_BYTES) throw new Error('图片太大（超过 30MB）');

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片解码失败'));
    el.src = dataUrl;
  });

  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (w === 0 || h === 0) throw new Error('图片尺寸异常');
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持图片压缩');
  ctx.drawImage(img, 0, 0, w, h);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
  });
  if (!blob) throw new Error('压缩失败');
  return blob;
}

/* ------------------------------------------------------------------ *
 * 签名 + 直传
 * ------------------------------------------------------------------ */

/**
 * 向自家服务器取一次一签。
 *
 * 🔴 三条纪律见文件头。判据「签发响应不完整」是老项目原话照搬：
 *   云端配置漏了某个字段时，前端必须立刻报错而不是带着 undefined 去发请求
 *   （那会得到一个云端 400，用户完全看不懂发生了什么）。
 */
export async function fetchUpSignTicket(deps: UploadDeps): Promise<UpSignTicket> {
  let raw: unknown;
  try {
    const r = await fetch(`${deps.base}/api/upsign`, {
      method: 'POST',
      // 🔴 这一行就是防跨域要签名的护栏，别"看着多余"删掉
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: deps.noteId }),
    });
    if (!r.ok) throw new Error(r.status === 501 ? '服务器未启用上传签名' : `签发失败 ${r.status}`);
    raw = await r.json();
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : '无法取得上传授权');
  }

  const o = raw as Partial<UpSignTicket> & { cloud_name?: string; upload_preset?: string };
  // 🔴 兼容两种字段命名：服务端给 camelCase（cloudName/preset）是新写法，
  //   给 Cloudinary 原生 snake_case（cloud_name/upload_preset）是老项目写法。
  //   两边都收，但**任一必需字段缺失就立刻报错**。
  const cloudName = o.cloudName || o.cloud_name || '';
  const uploadPreset = o.uploadPreset || o.upload_preset || '';
  const apiKey = o.apiKey || '';
  const signature = o.signature || '';
  const timestamp = typeof o.timestamp === 'number' ? o.timestamp : 0;
  const folder = o.folder || '';

  if (!cloudName || !apiKey || !signature || !uploadPreset || timestamp === 0) {
    throw new Error('签发响应不完整');
  }
  return { cloudName, apiKey, timestamp, signature, uploadPreset, folder };
}

/** 拿票 → 组 FormData → 直传 Cloudinary → 回 secure_url。 */
export async function uploadImage(blob: Blob, ticket: UpSignTicket): Promise<string> {
  const form = new FormData();
  form.append('file', blob);
  form.append('api_key', ticket.apiKey);
  form.append('timestamp', String(ticket.timestamp));
  form.append('signature', ticket.signature);
  form.append('upload_preset', ticket.uploadPreset);
  if (ticket.folder) form.append('folder', ticket.folder);
  // 🔴🔴 刻意**不传** public_id / transformation（见文件头纪律 2）：
  //   签名只覆盖 folder+timestamp+upload_preset，多带一个未签参数
  //   就会被云端判签名不符，症状是 400 且提示含糊。

  const r = await fetch(`https://api.cloudinary.com/v1_1/${ticket.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) throw new Error(`上传失败 ${r.status}`);
  const j = (await r.json()) as { secure_url?: string };
  if (!j.secure_url) throw new Error('上传响应不完整');
  return j.secure_url;
}

/* ------------------------------------------------------------------ *
 * 插入
 * ------------------------------------------------------------------ */

/**
 * 在光标处插入图片块。
 *
 * 🔴 与老项目的差别：老项目是 `range.insertNode(img)` 直接插 DOM，
 *   新项目走 Lexical 节点体系（$insertNodes）。
 *   但**语义完全对齐**：图片是一个独立的块，不与两侧文字混排
 *   （老项目插完还补一个 <br>，Lexical 侧天然就是独立块，不需补）。
 *
 * 🔴 无选区时追加到文末，**不 return 空**。
 *   教训来自 S5-d：面板加提醒那版「没选区就什么都不插」，
 *   症状是对账立刻把提醒判死、用户以为功能没实现。
 */
export function insertImageAtCaret(editor: LexicalEditor, url: string): void {
  editor.update(
    () => {
      const sel = $getSelection();
      const node = $createImageBlockNode(url, '');
      if ($isRangeSelection(sel)) {
        $insertNodes([node]);
        return;
      }
      // 无选区（编辑器未聚焦）→ 追加到文末，并留一个空段落供继续输入
      $insertNodes([node, $createParagraphNode()]);
    },
    { discrete: true },
  );
}

/* ------------------------------------------------------------------ *
 * 全流程
 * ------------------------------------------------------------------ */

/**
 * 完整链路：压缩 → 取票 → 直传 → 插入。
 *
 * 🔴 失败必须**看得见且读得完**：老项目 v10.0.0 关键路径止血 ——
 *   2 秒在手机上根本来得及看清一次失败原因，所以失败文案驻留 4.5 秒、
 *   且必须包含原因 + 「图片未插入，请重试」这句明确告知。
 *   静默失败 = 用户以为功能坏了。
 *
 * 🔴🔴 **必须返回成败，不能靠调用方"看提示条现在是什么态"反推**。
 *   我第一版写成 `Promise<void>` + 调用方检查 DOM 的 data-kind ——
 *   那是把"数据"藏在"副作用"里，两个提示同时弹出、或提示条已被
 *   收起计时器删掉时，判定就不成立了。返回布尔是唯一可靠口径。
 *
 * @returns true = 图片已插入；false = 失败（已通过 onError 告知原因）
 */
export async function handleImageUpload(
  file: File,
  editor: LexicalEditor,
  deps: UploadDeps,
): Promise<boolean> {
  if (!file || !file.type.startsWith('image/')) {
    deps.onError('不是图片文件，图片未插入，请重试');
    return false;
  }
  try {
    deps.onStatus('正在压缩图片…');
    const blob = await compressImage(file);
    deps.onStatus('正在上传…');
    const ticket = await fetchUpSignTicket(deps);
    const url = await uploadImage(blob, ticket);
    insertImageAtCaret(editor, url);
    deps.onOk();
    return true;
  } catch (e) {
    deps.onError(`上传失败：${e instanceof Error ? e.message : '未知错误'}，图片未插入，请重试`);
    return false;
  }
}
