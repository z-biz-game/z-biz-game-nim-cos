// 可安装 = 装了之后离线还能打开，而且**改版不会被钉死**。
//
// cache 名带 VERSION：每次发布手工 +1，`activate` 里把不属于当前版本的老 cache 删掉。
// 命中策略是"同源子资源网络优先、失败退缓存"，不是 cache-first：本仓零构建、直接发裸
// ES module，js/*.js 与 css/*.css 的 URL 永远不变，一旦 cache-first 就等于把某一版代码
// 永久钉在设备上 —— 新 HTML 配旧 JS 的鬼状态（少一个按钮 id、多一个 import）就是这么来的。
// 网络优先让正常线上永远拿到新代码，只有真断网时才退到上一次存下的副本。
//
// file:// 下 SW 根本没有 registry（`navigator.serviceWorker` 为 undefined），注册那一步
// 由 js/main.js 用同一个协议判断跳过；这里再兜一层：非 http(s) 的请求一律放行不处理，
// 不抛未捕获异常。

const VERSION = 'nim-cos-v1';
const CACHE = 'nim-cos-' + VERSION;

// 只 precache 这张清单里、盘上真实存在的同名文件（构建产物没有 bundler，一一对应）。
const PRECACHE = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个 add 而不是 Promise.all 一把梭：一个 404 会让整个 install 失败、
    // 于是这台设备永远装不上，而缺的往往只是某个尺寸图标。
    for (const url of PRECACHE) {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        // 缺谁都不拦 install：离线兜底少一张图标，比整个 SW 装不上好。
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function sameOrigin(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch (err) {
    return false; // chrome-extension://、data: 这类没有 origin 的请求不接管
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !sameOrigin(req)) return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 导航：网络优先拿最新页面，断网才回退到缓存里的 index.html（离线壳）。
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match('./index.html');
        return cached || new Response('离线，且这台设备上还没有存过页面', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 同源子资源（js/css/png/manifest）：同样网络优先，成功就顺手刷新副本。
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // 读不到的模块就让它 404：返回一张假响应用户看不出坏了，反而更难查。
      return new Response('offline miss: ' + url.pathname, { status: 504 });
    }
  })());
});
