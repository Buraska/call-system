self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { title: "Новое обращение", body: event.data?.text() || "Поступило сообщение по звонку" }; }
  event.waitUntil(self.registration.showNotification(payload.title || "Новое обращение", {
    body: payload.body || "Поступило сообщение по звонку",
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
