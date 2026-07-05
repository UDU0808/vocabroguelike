/*
 * Service Worker 缓存文件
 *
 * 作用：
 * - 让第二次打开游戏更快。
 * - 离线或网络不稳定时，尽量从缓存里拿已有文件。
 *
 * 【自己最常改】
 * - CACHE_NAME：正式改版时要同步更新。
 *   它需要和 game.js 里的 ASSET_VERSION、index.html 里的 ?v=版本号保持一致。
 *   不同步的话，手机/浏览器可能继续使用旧 game.js、旧 CSS、旧配置。
 */
const CACHE_NAME = "vocabroguelike-v118-hidden-joystick-no-frost";

/*
 * 首次安装 Service Worker 时预缓存的“轻量文件”。
 *
 * 本次加载优化原则：
 * - 这里只放首屏必要或非常小的文件。
 * - 不要把所有英雄动作图、所有怪物图、所有 Boss 图都放进来。
 * - 大图资源由游戏进入对应阶段后按需缓存。
 *
 * 【自己可以加】
 * - 新增首屏必须的 CSS、JS、小图标。
 *
 * 【不建议加】
 * - assets/heroes/xxx/walk.webp 这类大动作图。
 * - assets/bosses/types/xxx/attack.webp 这类 Boss 大图。
 */
const STATIC_HINTS = [
  "./",
  "./index.html",
  "./styles.css",
  "./game.js",
  "./assets/config/heroes.json",
  "./assets/config/monsters.json",
  "./assets/config/bosses.json",
  "./assets/config/items.json",
  "./assets/config/levels.json",
  "./assets/config/words.json",
  "./assets/ui/menu_bg_image2.webp"
];

// install：浏览器安装新版缓存时触发。
// cache.addAll(STATIC_HINTS) 会预先缓存上面的轻量文件；catch 防止某个文件失败导致整个安装报错。
// skipWaiting() 表示新 Service Worker 安装后尽快接管，不用等旧页面全部关闭。
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_HINTS)).catch(() => {}));
  self.skipWaiting();
});

// activate：新版 Service Worker 激活时触发。
// 这里会删除旧版本缓存，只保留当前 CACHE_NAME。
// 所以正式修改后一定要改 CACHE_NAME，否则旧缓存可能删不掉。
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

// fetch：页面请求任何资源时都会经过这里。
//
// 缓存策略说明：
// - HTML/JS/CSS/JSON：network first，优先读网络新文件，失败才用缓存。
//   这些文件经常改，不能长期死用旧缓存。
// - 图片/音频等静态大资源：cache first，缓存里有就直接用，没有再请求网络。
//   这些文件大，二次打开时直接用缓存更快。
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 只处理同源资源，外站资源交给浏览器默认处理。
  if (url.origin !== location.origin) return;

  // 调试模式：网址带 ?dev=1 或 ?nocache=1 时不走 Service Worker 缓存。
  if (url.searchParams.has("dev") || url.searchParams.has("nocache")) return;

  const pathname = url.pathname;
  const networkFirst = req.mode === "navigate" ||
    pathname.endsWith("/index.html") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".json");

  if (networkFirst) {
    event.respondWith(fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      return resp;
    }).catch(() => caches.match(req).then(cached => cached || caches.match("./index.html"))));
    return;
  }

  // 图片、音频等大资源走 cache first：
  // - 已缓存：直接返回，速度快。
  // - 未缓存：请求网络，并顺手保存到当前版本缓存里。
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return resp;
      });
    })
  );
});
