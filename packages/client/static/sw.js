/**
 * Service Worker —— 手写，不引 Workbox
 *
 * 策略只有两条（ARCH.md §4.6 已定稿，不再加第三条）：
 *   1. **network-first + 版本化缓存名**：先网络、失败回落缓存。
 *      理由：这是"笔记"应用，断网时读本地、网络好时必须立刻拿新版。
 *      版本化缓存名让每次发版自动换缓存，不需要手动清缓存（老项目踩过"用户永远看不到新版"）。
 *   2. **10s AbortController 超时**：网络不响应就立刻回落缓存，不让首屏卡在白屏上。
 *
 * 🔴 绝不缓存的东西：/api/*（密文中继）。理由见下。
 *
 * 🔴 为什么 `/api/*` 一律 network-only，连回落缓存都不给：
 *   笔记正文是密文，但「拉取密文」这个动作的**响应体**是按 `x-note-key` 相关的凭据
 *   隔离的。把某台设备请求到的密文缓存下来给另一台设备看，就是把一份密文复制到
 *   另一个身份下 —— 即使解不开，也是"密文脱离原本的上下文长期留存"，
 *   与 ARCH「E2EE 是投毒防线/失守防线」这一层直接冲突。
 *   离线时该看到的是"连不上"，不是"看到别的设备刚拉的那份"。
 *
 * 🔴 缓存的是**应用外壳**（app.js / index.html / 图标），不是用户数据。
 *   外壳无密钥、无隐私，缓存它只是为了秒开；数据一律走网络。
 */

/**
 * 🔴🔴 缓存名的版本必须来自**注册 URL 的 `?v=` 参数**（= app.js 里的 APP_VERSION），
 * 不能在 sw.js 里写死。老项目 index.html:10337 / sw.js:4-5 早就根治过这个：
 *   `navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(APP_VERSION))`
 *   + `const VER = (new URL(self.location.href).searchParams.get('v')) || 'x';`
 * 写死版本号的症状很隐蔽：发版后 SW 照样装上、缓存名不变，
 * 用户**永远拿旧壳**，且没有任何报错（老项目 v5.35 之前就长期是这个症状）。
 *
 * 取不到 `?v=` 时回退到一个带时间戳的串：宁可"这次换名了"（多一次重新缓存），
 * 也不要"永远不换名"（用户永远看不到新版）。
 */
const VER = (new URL(self.location.href).searchParams.get('v') || '') || ('x' + self.registration?.scope?.length + '-' + (self.__BJ_FALLBACK_V || '0'));
const CACHE = `notesync-bj-${VER}`;

/**
 * 应用外壳清单。刻意短：能离线打开界面就够，笔记数据不在其中。
 * 🔴 三个静态资源必须列进来，否则离线时安装横幅拿不到 manifest 与图标
 *   （老项目 sw.js:6 的 ASSETS 同样列了 manifest.json 与三枚图标）。
 */
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个 add而不是 cache.addAll：addAll 是一把梭，任一个 404 整个 install 就失败，
      // SW 装不上 = 静默失去离线能力，而用户完全看不出发生了什么。
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((e) => {
            console.warn('[sw] 预缓存失败（不影响使用）', url, e);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 换版本时删掉旧缓存，否则会无限堆积（老项目缓存能涨到几十 MB）
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** 10s 超时：网络不响应就回落，不让首屏干等 */
const NET_TIMEOUT_MS = 10_000;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域资源不接管

  // 🔴 API 永不走缓存（含离线回落），理由见文件头
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(timer);
    // 只缓存成功响应；opaque / 错误响应进缓存会把错误页存成"离线可用"
    if (res && res.ok && res.type === 'basic') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    clearTimeout(timer);
    const hit = await cache.match(req).catch(() => null);
    if (hit) return hit;
    // 缓存也没有：如实失败，让页面显示"连不上"，不伪造一个空响应
    return new Response('离线且无缓存', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
