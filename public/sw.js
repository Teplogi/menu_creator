// めにゅらく！ Service Worker
// 役割: プッシュ通知の受信・表示と、通知タップ時のアプリ起動。
// （オフラインキャッシュは今は入れていない。将来ここに追加できる。）

self.addEventListener("install", (event) => {
  self.skipWaiting(); // 新SWを即時有効化
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// プッシュ受信 → 通知を表示
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "めにゅらく！", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "めにゅらく！";
  const options = {
    body: data.body || "",
    icon: "/icon.png",
    badge: "/icon.png",
    tag: data.tag || undefined, // 同じtagは上書き（連投で埋もれない）
    renotify: !!data.tag,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 通知タップ → 既存のタブがあればフォーカス、無ければ開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate && c.navigate(url);
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
