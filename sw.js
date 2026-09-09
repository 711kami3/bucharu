// ぶちゃる Service Worker
//
// 【この版での変更（2026-09-08）】旧版は「必ず通信を待つ」作りだったため、
// 電波が弱い（繋がってはいるがデータが流れない）状態で画面が真っ白になった。
// 完全に圏外なら即座に失敗してキャッシュが使われるが、弱電波では失敗もせず待ち続けるため。
//
//  1. 通信の待ち時間に上限（NET_TIMEOUT_MS）を設けた。
//     間に合わなければキャッシュを返す。通信自体は裏で続行し、キャッシュを更新する。
//  2. 初回インストールを1ファイルずつに変えた。
//     旧版は addAll で、1つでも取得に失敗するとオフライン機能が丸ごと入らなかった。
//  3. 同一オリジンのファイルだけを扱うようにした。
//     Firestore など外部との通信には一切触れない（再送処理を邪魔しないため）。
//
// 【2026-09-09 追記】キャッシュ名を fm-v29 → fm-v30 に上げた。
// index.html のセキュリティ修正を各端末に確実に届けるため。
// ★以後、index.html を更新したら必ずこの番号を上げること。
// 番号を上げないと、端末は古い版を使い続ける（実際にそうなることを確認済み）。

const CACHE = 'fm-v32';   // ★更新時は必ず番号を上げる（上げないと古い版が残り続ける）

// 通信をこの時間だけ待つ。超えたらキャッシュを返す（通信は裏で続く）
const NET_TIMEOUT_MS = 3000;

const ASSETS = [
  './', './index.html', './terms.html', './manifest.json',
  './fuji-normal.png', './fuji-surprise.png', './fuji-scold.png', './fuji-sleepy.png',
  './bucharu-icon.png',
  './vendor/zxing.min.js',
  './vendor/firebase-app-compat.js',
  './vendor/firebase-auth-compat.js',
  './vendor/firebase-firestore-compat.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 1つずつ入れる。1個失敗しても残りは入る（addAll は全部まとめて失敗する）
    // cache:'reload' を付けて、ブラウザ自身のキャッシュを迂回し必ずサーバーから取り直す。
    // これが無いと、更新したはずのファイルが古いまま入ってしまう。
    await Promise.all(ASSETS.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (e) { /* 1つ失敗しても他は入れる */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 外部（Firestore・Google認証など）には触らない。素通しする
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  // 通信はすぐ始める。成功したらキャッシュを更新する
  const network = fetch(req).then(res => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => null);

  // 画面を返した後も、裏の通信とキャッシュ更新を最後までやらせる
  e.waitUntil(network);

  e.respondWith((async () => {
    const cached = await caches.match(req);

    if (!cached) {
      // キャッシュが無い場合は通信を待つしかない
      const res = await network;
      if (res) return res;
      // 画面の表示要求なら、せめてトップ画面を出す（真っ白を避ける）
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504, statusText: 'offline' });
    }

    // キャッシュがある場合：通信を少しだけ待ち、間に合わなければキャッシュを返す
    const timeout = new Promise(r => setTimeout(() => r(null), NET_TIMEOUT_MS));
    const fresh = await Promise.race([network, timeout]);
    return (fresh && fresh.ok) ? fresh : cached;
  })());
});
