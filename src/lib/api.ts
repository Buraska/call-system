const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const apiHost = new URL(API).hostname;
const usesNgrok = [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.io"].some((suffix) => apiHost.endsWith(suffix));

export async function api(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (usesNgrok) headers.set("ngrok-skip-browser-warning", "true");
  const response = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `Ошибка запроса (${response.status})`);
  return data;
}
