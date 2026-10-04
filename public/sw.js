self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { title: "New message", body: event.data?.text() || "A new call message has arrived" }; }
  event.waitUntil(self.registration.showNotification(payload.title || "New message", {
    body: payload.body || "A new call message has arrived",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: payload.url || "/" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((window) => "focus" in window);
    if (existing) return existing.focus();
    return clients.openWindow(event.notification.data?.url || "/");
  }));
});
