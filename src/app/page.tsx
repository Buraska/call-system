"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArrowDownLeft, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Inbox, Link2, MoreHorizontal, Search, Send, Settings2, SlidersHorizontal, Sparkles, Tag as TagIcon, X } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
type User = { id: string; name: string; email: string; organization_id: string; role: string };
type Org = { name: string; phone_number?: string; forwarding_mode?: string; languages?: string[] };
type Message = { id: string; contact_name?: string; caller_phone: string; summary: string; transcript: string; tag_id?: string | null; tag_name: string; tag_origin: "manual" | "existing" | "suggested"; confidence: number; language?: string; status: "new" | "done"; source?: string; duration_seconds?: number; created_at: string; auto_reply?: { channel: string; text: string; sent_at?: string; attempted_at?: string; status?: string }; last_reply?: { channel: string; text: string; sent_at: string; status?: string } };
type TagItem = { id: string; name: string; color: string; origin: string };
type Rule = { id: string; tag_id: string; tag_name: string; channel: "sms" | "whatsapp" | "webhook"; message_template: string; enabled: boolean; min_confidence: number; webhook_url?: string };
type Notice = { id: string; title: string; body: string; read: boolean; created_at: string; message_id?: string };

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `Ошибка запроса (${response.status})`);
  return data;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(" г.", "");
}
function shortTime(value: string) { return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function relativeTime(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин. назад`;
  if (mins < 1440) return `${Math.floor(mins / 60)} ч. назад`;
  return dateLabel(value);
}
function avatarClass(index: number) { return ["avatar-lilac", "avatar-peach", "avatar-mint", "avatar-blue", "avatar-rose"][index % 5]; }
function avatarLetter(name?: string) { return !name || name === "Неизвестный номер" ? "?" : name[0].toUpperCase(); }

function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: User) => void }) {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const result = await api(`/api/auth/${register ? "register" : "login"}`, null, { method: "POST", body: JSON.stringify(body) });
      localStorage.setItem("kontuur_token", result.access_token);
      onAuthenticated(result.access_token, result.user);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-card"><a className="brand auth-brand" href="#"><span className="brand-mark"><span/><span/><span/></span><span>kontuur</span></a><div className="eyebrow">ПРИЁМ ОБРАЩЕНИЙ ПО ЗВОНКАМ</div><h1>{register ? "Создайте рабочее пространство" : "С возвращением"}</h1><p className="auth-description">Звонки, транскрипты и ответы клиентам — в одном простом списке.</p><form onSubmit={submit} className="auth-form">{register && <><label>Ваше имя<input required name="name" autoComplete="name" placeholder="Мария Иванова"/></label><label>Название организации<input required name="organization_name" placeholder="Например, Kodu Haldus OÜ"/></label><label>Ваш номер телефона<input name="phone" type="tel" placeholder="+372 …"/></label></>}<label>Рабочий email<input required name="email" type="email" autoComplete="email" placeholder="name@company.ee"/></label><label>Пароль<input required name="password" type="password" minLength={register ? 8 : 1} autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "Не менее 8 символов" : "Ваш пароль"}/></label>{error && <div className="form-error">{error}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? "Подождите…" : register ? "Создать аккаунт" : "Войти"}</button></form><button className="auth-toggle" onClick={() => { setRegister(!register); setError(""); }}>{register ? "Уже есть аккаунт? Войти" : "Первая организация? Создать аккаунт"}</button><div className="auth-foot">Данные доступны только сотрудникам вашей организации.</div></section></main>;
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [bulk, setBulk] = useState<string[]>([]);
  const [replyOpen, setReplyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"rules" | "phone">("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [ruleTagId, setRuleTagId] = useState("");
  const [ruleChannel, setRuleChannel] = useState<"sms" | "whatsapp" | "webhook">("sms");
  const [replyChannel, setReplyChannel] = useState<"sms" | "whatsapp">("sms");
  const [newTagName, setNewTagName] = useState("");
  const [forwarding, setForwarding] = useState<{ destination: string; steps: string[]; note: string } | null>(null);

  const refresh = useCallback(async (auth: string) => {
    try {
      const [msgData, tagData, ruleData, noticeData, orgData] = await Promise.all([
        api("/api/messages?limit=200", auth), api("/api/tags", auth), api("/api/rules", auth), api("/api/notifications", auth), api("/api/organization", auth),
      ]);
      setMessages(msgData); setTags(tagData); setRules(ruleData); setNotices(noticeData); setOrg(orgData);
      setSelectedId((current) => current && msgData.some((item: Message) => item.id === current) ? current : msgData[0]?.id ?? "");
    } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("kontuur_token");
    if (!saved) return;
    api("/api/auth/me", saved).then(async (data) => { setToken(saved); setUser(data.user); await refresh(saved); }).catch(() => localStorage.removeItem("kontuur_token"));
  }, [refresh]);
  useEffect(() => { if (!token) return; const id = window.setInterval(() => refresh(token), 15000); return () => window.clearInterval(id); }, [token, refresh]);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(""), 3500); return () => window.clearTimeout(id); }, [toast]);

  const visibleMessages = useMemo(() => messages.filter((message) => {
    const matchesFilter = filter === "all" || (filter === "new" && message.status === "new") || (filter === "unanswered" && !message.auto_reply && !message.last_reply);
    const haystack = `${message.contact_name ?? ""} ${message.caller_phone} ${message.summary} ${message.tag_name}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  }), [messages, filter, query]);
  const active = messages.find((item) => item.id === selectedId);
  const newCount = messages.filter((item) => item.status === "new").length;
  const unreadCount = notices.filter((item) => !item.read).length;
  const activeRuns = active ? [] : [];

  async function authenticate(auth: string, account: User) {
    setToken(auth); setUser(account); setError("");
    try { await api("/api/demo/seed", auth, { method: "POST" }); } catch { /* demo seeding is optional */ }
    await refresh(auth);
  }
  async function mutate(path: string, method: string, body?: unknown) {
    if (!token) return null;
    setBusy(true); setError("");
    try { const result = await api(path, token, { method, body: body === undefined ? undefined : JSON.stringify(body) }); await refresh(token); return result; }
    catch (err) { setError((err as Error).message); return null; }
    finally { setBusy(false); }
  }
  function logout() { localStorage.removeItem("kontuur_token"); setToken(null); setUser(null); setOrg(null); setMessages([]); }
  async function enableNotifications() {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { setToast("Браузер не поддерживает push-уведомления"); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { setToast("Разрешите уведомления в настройках браузера"); return; }
    try {
      const keyData = await api("/api/push/public-key", token);
      if (!keyData.public_key) { setToast("Push не настроен сервером — новые звонки видны в приложении"); return; }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyData.public_key) });
      await api("/api/push/subscribe", token, { method: "POST", body: JSON.stringify(subscription.toJSON()) });
      setToast("Уведомления включены");
    } catch (err) { setToast((err as Error).message); }
  }
  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!active || !token) return;
    const form = new FormData(event.currentTarget); const text = String(form.get("text") || "");
    const result = bulk.length
      ? await mutate("/api/messages/bulk-reply", "POST", { message_ids: bulk, channel: replyChannel, text })
      : await mutate(`/api/messages/${active.id}/reply`, "POST", { channel: replyChannel, text });
    if (result) { setReplyOpen(false); setBulk([]); setToast(result.status === "demo" || result.results?.some((item: { status: string }) => item.status === "demo") ? "Демо-режим: провайдер не подключён, SMS не отправлено" : "Ответ отправлен"); }
  }
  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await mutate("/api/rules", "POST", { tag_id: String(form.get("tag_id")), channel: String(form.get("channel")), message_template: String(form.get("message_template")), min_confidence: Number(form.get("confidence")), webhook_url: String(form.get("webhook_url") || "") || null, enabled: true });
    if (result) setToast("Правило сохранено");
  }
  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!newTagName.trim()) return;
    const result = await mutate("/api/tags", "POST", { name: newTagName.trim() });
    if (result) { setNewTagName(""); setToast("Тэг создан"); }
  }
  async function acceptTag(message: Message) {
    const result = await mutate(`/api/messages/${message.id}/accept-tag`, "POST", {});
    if (result) setToast("Предложенный тэг добавлен в список категорий");
  }
  async function openSetup() {
    setSettingsTab("phone"); setSettingsOpen(true);
    try { setForwarding(await api("/api/setup/forwarding", token)); } catch { /* displayed in the main error area */ }
  }
  async function markNotice(notice: Notice) {
    await mutate(`/api/notifications/${notice.id}/read`, "POST", { read: true });
    if (notice.message_id) { setSelectedId(notice.message_id); setDetailOpen(true); }
  }
  if (!token || !user) return <AuthScreen onAuthenticated={authenticate} />;

  return <main className={`app-shell ${detailOpen ? "show-detail" : ""}`}>
    <aside className="sidebar"><a className="brand" href="#"><span className="brand-mark"><span/><span/><span/></span><span>kontuur</span></a>
      <button className="workspace-switch" onClick={() => setSettingsOpen(true)}><span className="workspace-avatar">{(org?.name || "K")[0]}</span><span className="workspace-name"><strong>{org?.name || "Организация"}</strong><span>Рабочее пространство</span></span><ChevronDown size={15}/></button>
      <div className="side-label">РАБОТА</div><button className="side-link active" onClick={() => setFilter("all")}><Inbox size={17}/><span>Входящие</span><span className="side-count">{newCount}</span></button><button className="side-link" onClick={() => setFilter("unanswered")}><Send size={17}/><span>Без ответа</span><span className="side-count muted-count">{messages.filter((item) => !item.auto_reply && !item.last_reply).length}</span></button><button className="side-link" onClick={() => setFilter("all")}><Archive size={17}/><span>Архив</span></button>
      <div className="sidebar-spacer"/><div className="side-label">ВАШИ ТЭГИ <button aria-label="Добавить тэг" className="tiny-plus" onClick={() => setSettingsOpen(true)}>+</button></div>
      {tags.slice(0, 5).map((tag) => <button key={tag.id} className="tag-nav" onClick={() => setQuery(tag.name)}><i className="tag-dot" style={{ background: tag.color }}/>{tag.name}<span>{messages.filter((item) => item.tag_id === tag.id).length}</span></button>)}<button className="show-tags" onClick={() => setSettingsOpen(true)}>Все тэги <ChevronRight size={14}/></button>
      <div className="sidebar-bottom"><button className="side-link" onClick={() => { setSettingsTab("rules"); setSettingsOpen(true); }}><Settings2 size={17}/><span>Настройки</span></button><button className="side-link" onClick={enableNotifications}><Bell size={17}/><span>Уведомления</span></button><div className="user-card"><div className="user-avatar">{user.name[0]}</div><div><strong>{user.name}</strong><span>Администратор</span></div><button className="logout-link" onClick={logout} title="Выйти"><MoreHorizontal size={18}/></button></div></div>
    </aside>

    <section className="inbox-column"><header className="inbox-header"><div className="title-row"><div><div className="eyebrow">{new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" }).toUpperCase()}</div><h1>Входящие <span className="title-count">{newCount}</span></h1></div><button className="icon-button mobile-settings" aria-label="Настройки" onClick={() => setSettingsOpen(true)}><Settings2 size={18}/></button></div>
        <div className="inbox-toolbar"><div className="filter-tabs"><button className={`filter-tab ${filter === "all" ? "selected" : ""}`} onClick={() => setFilter("all")}>Все</button><button className={`filter-tab ${filter === "new" ? "selected" : ""}`} onClick={() => setFilter("new")}>Новые <span>{newCount}</span></button><button className={`filter-tab ${filter === "unanswered" ? "selected" : ""}`} onClick={() => setFilter("unanswered")}>Без ответа</button></div><button className="icon-button filter-button" aria-label="Фильтры"><SlidersHorizontal size={16}/></button></div>
        <label className="search-box"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по сообщениям"/><kbd>⌘ K</kbd></label></header>
      {bulk.length > 0 && <div className="bulk-bar"><span>Выбрано: <b>{bulk.length}</b></span><button onClick={() => setBulk([])}><X size={14}/> Снять выбор</button><button className="bulk-send" onClick={() => { setReplyChannel("sms"); setReplyOpen(true); }}><Send size={14}/> Ответить выбранным</button></div>}
      {error && <div className="inline-error"><span>{error}</span><button onClick={() => setError("")}><X size={14}/></button></div>}
      <div className="message-list">{visibleMessages.map((message, index) => <article key={message.id} className={`message-row ${selectedId === message.id ? "current" : ""}`} onClick={() => { setSelectedId(message.id); setDetailOpen(true); }}><label className="row-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={bulk.includes(message.id)} onChange={() => setBulk((old) => old.includes(message.id) ? old.filter((id) => id !== message.id) : [...old, message.id])}/><span/></label><div className={`avatar ${avatarClass(index)}`}>{avatarLetter(message.contact_name)}</div><div className="row-content"><div className="row-top"><strong>{message.contact_name || message.caller_phone}</strong><time>{shortTime(message.created_at)}</time></div><p>{message.summary}</p><div className="row-bottom"><span className={`tag-pill ${message.tag_origin === "suggested" ? "suggested" : ""}`}><i className="tag-dot" style={{ background: message.tag_origin === "suggested" ? "#ab8bbd" : undefined }}/>{message.tag_name}{message.tag_origin === "suggested" && <Sparkles size={11}/>}</span>{(message.auto_reply || message.last_reply) && <span className="sent-mini"><Check size={12}/> {message.auto_reply?.status === "demo" || message.last_reply?.status === "demo" ? "Демо · не отправлено" : "Ответ отправлен"}</span>}</div></div>{message.status === "new" && <span className="unread-dot"/>}</article>)}{visibleMessages.length === 0 && <div className="empty-state"><Inbox size={20}/><strong>{messages.length ? "Ничего не найдено" : "Пока нет звонков"}</strong><span>{messages.length ? "Попробуйте изменить запрос или фильтр" : "Включите переадресацию, чтобы принимать обращения"}</span>{messages.length === 0 && <button className="text-button" onClick={openSetup}>Настроить номер</button>}</div>}</div>
      <footer className="list-footer"><span>Показано {visibleMessages.length} из {messages.length}</span><button onClick={() => refresh(token)}>Обновить <ChevronDown size={14}/></button></footer>
    </section>

    <section className="detail-column"><header className="detail-header"><div className="detail-header-left"><button className="icon-button detail-back" aria-label="Назад" onClick={() => setDetailOpen(false)}><ChevronLeft size={18}/></button><span className="live-dot"/>{active ? "Звонок обработан" : "Сообщение"}{active && <span className="detail-time">· {relativeTime(active.created_at)}</span>}</div><div className="detail-header-actions"><button className="icon-button" aria-label="Предыдущее сообщение" onClick={() => navigateMessage(-1, visibleMessages, active, setSelectedId)}><ChevronLeft size={17}/></button><button className="icon-button" aria-label="Следующее сообщение" onClick={() => navigateMessage(1, visibleMessages, active, setSelectedId)}><ChevronRight size={17}/></button><span className="vertical-rule"/><div className="notice-wrapper"><button className="icon-button notification-button" aria-label="Уведомления" onClick={() => setNoticeOpen(!noticeOpen)}><Bell size={17}/>{unreadCount > 0 && <i/>}</button>{noticeOpen && <div className="notice-popover"><div className="notice-heading">Уведомления <button onClick={enableNotifications}>Включить push</button></div>{notices.length === 0 ? <p className="notice-empty">Новых уведомлений пока нет</p> : notices.slice(0, 8).map((notice) => <button key={notice.id} className={`notice-item ${notice.read ? "read" : ""}`} onClick={() => markNotice(notice)}><span className="notice-dot"/><span><b>{notice.title}</b><small>{notice.body} · {relativeTime(notice.created_at)}</small></span></button>)}</div>}</div><button className="icon-button" aria-label="Другие действия"><MoreHorizontal size={18}/></button></div></header>
      {active ? <><div className="detail-scroll"><div className="contact-block"><div className={`avatar ${avatarClass(messages.indexOf(active))}`}>{avatarLetter(active.contact_name)}</div><div className="contact-main"><h2>{active.contact_name || "Неизвестный номер"}</h2><div className="phone-line">{active.caller_phone}<button aria-label="Скопировать номер" onClick={() => navigator.clipboard?.writeText(active.caller_phone)}><Link2 size={13}/></button></div></div><button className="icon-button contact-more" aria-label="Действия с контактом"><MoreHorizontal size={18}/></button></div>
        <div className="summary-card"><div className="summary-label"><Sparkles size={14}/> КРАТКО</div><h3>{active.summary}</h3><div className="tag-line"><span className={`tag-pill detail-tag ${active.tag_origin === "suggested" ? "suggested" : ""}`}><i className="tag-dot" style={{ background: active.tag_origin === "suggested" ? "#ab8bbd" : undefined }}/>{active.tag_name}{active.tag_origin === "suggested" && <Sparkles size={11}/>}</span>{active.tag_origin === "suggested" && <><span className="ai-label">Предложен ИИ</span><button className="text-button accept-tag" onClick={() => acceptTag(active)}>Добавить в тэги</button></>}<select className="change-tag" value={active.tag_id || ""} onChange={(event) => mutate(`/api/messages/${active.id}`, "PATCH", { tag_id: event.target.value })}><option value="" disabled>Изменить</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div><div className="confidence-note">{active.confidence != null ? `Уверенность категории: ${Math.round(active.confidence * 100)}%` : ""}</div></div>
        <section className="content-section"><div className="section-heading"><h3>Транскрипт звонка</h3><button className="text-button" onClick={() => navigator.clipboard?.writeText(active.transcript)}>Копировать</button></div><div className="transcript-card"><div className="transcript-meta"><span className="transcript-icon"><ArrowDownLeft size={14}/></span><span>Звонящий</span><time>{shortTime(active.created_at)}</time></div><p>«{active.transcript}»</p><div className="transcript-foot"><span><Clock3 size={13}/> {duration(active.duration_seconds)}</span><span>{languageName(active.language)} · Распознано автоматически</span></div></div></section>
        <section className="content-section action-section"><div className="section-heading"><h3>Автоматическое действие</h3><button className="text-button" onClick={() => { setSettingsTab("rules"); setSettingsOpen(true); }}>Настроить</button></div>{active.auto_reply ? <div className="action-card"><div className="action-status"><span className="check-ring"><Check size={12}/></span><span>{active.auto_reply.status === "demo" ? "Демо: сообщение не отправлено" : "Ответ отправлен"}</span><span className="channel-badge">{active.auto_reply.channel.toUpperCase()}</span><time>{shortTime(active.auto_reply.sent_at || active.auto_reply.attempted_at || "")}</time></div><p>{active.auto_reply.text}</p><div className="action-foot"><span>Правило: <b>{active.tag_name}</b></span><button onClick={() => { setSettingsTab("rules"); setSettingsOpen(true); }}><ChevronRight size={15}/></button></div></div> : active.last_reply ? <div className="action-card"><div className="action-status"><span className="check-ring"><Check size={12}/></span><span>{active.last_reply.status === "demo" ? "Демо: сообщение не отправлено" : "Ответ отправлен сотрудником"}</span><span className="channel-badge">{active.last_reply.channel.toUpperCase()}</span></div><p>{active.last_reply.text}</p></div> : <div className="no-action-card"><div className="no-action-icon"><TagIcon size={16}/></div><div><strong>Для этого тэга нет действия</strong><span>Можно настроить ответ по категории</span></div><button onClick={() => { setRuleTagId(active.tag_id || ""); setSettingsTab("rules"); setSettingsOpen(true); }}>Настроить</button></div>}{rules.find((rule) => rule.tag_id === active.tag_id && rule.enabled) && <div className="confidence-note">Правило активно при уверенности от {Math.round((rules.find((rule) => rule.tag_id === active.tag_id)?.min_confidence || 0) * 100)}%</div>}</section>
        <section className="content-section activity-section"><div className="section-heading"><h3>Сведения</h3></div><div className="activity-line"><div className="activity-icon"><Bell size={13}/></div><div><span>Уведомление организации</span><small>{relativeTime(active.created_at)} · Push и список уведомлений</small></div><CheckCheck size={14} className="activity-check"/></div><div className="activity-line"><div className="activity-icon ai-activity"><Sparkles size={13}/></div><div><span>Транскрипт готов · тэг определён</span><small>{languageName(active.language)} · уверенность {Math.round((active.confidence || 0) * 100)}%</small></div></div><div className="activity-line"><div className="activity-icon"><Clock3 size={13}/></div><div><span>Аудиозапись удалена после распознавания</span><small>Хранится транскрипт и метаданные звонка</small></div></div></section>
      </div><footer className="detail-footer"><button className={`done-button ${active.status === "done" ? "is-done" : ""}`} onClick={() => mutate(`/api/messages/${active.id}`, "PATCH", { status: active.status === "done" ? "new" : "done" })}>{active.status === "done" ? <CheckCheck size={16}/> : <Check size={16}/>} {active.status === "done" ? "Обработано" : "Отметить обработанным"}</button><button className="reply-button" onClick={() => { setBulk([]); setReplyChannel("sms"); setReplyOpen(true); }}><Send size={15}/> Ответить вручную</button></footer></> : <div className="empty-detail"><Inbox size={26}/><strong>Выберите обращение</strong><span>Звонки и ответы будут показаны здесь</span></div>}</section>

    {replyOpen && active && <div className="modal-backdrop" onClick={() => setReplyOpen(false)}><form className="reply-modal" onSubmit={sendReply} onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">ОТВЕТ КЛИЕНТУ</span><h2>{bulk.length ? `Ответ для ${bulk.length} получателей` : active.contact_name || active.caller_phone}</h2></div><button type="button" className="icon-button" onClick={() => setReplyOpen(false)} aria-label="Закрыть"><X size={18}/></button></div><label className="channel-select">Канал ответа<select value={replyChannel} onChange={(event) => setReplyChannel(event.target.value as "sms" | "whatsapp")}><option value="sms">SMS</option><option value="whatsapp">WhatsApp Business</option></select><ChevronDown size={14}/></label><textarea name="text" required maxLength={1000} defaultValue={active.auto_reply?.text || active.last_reply?.text || "Здравствуйте! Мы получили ваше сообщение и передали его ответственному сотруднику. Сообщим, как только появится информация."}/><div className="modal-bottom"><span>{bulk.length ? `${bulk.length} выбранных номеров` : `Ответ придёт на ${active.caller_phone}`}</span><button className="primary-button" disabled={busy}><Send size={14}/> Отправить</button></div><p className="form-hint">Для отправки нужны настроенные реквизиты SMS/WhatsApp провайдера.</p></form></div>}

    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><div className="settings-modal full-settings" onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">ОРГАНИЗАЦИЯ · {org?.name}</span><h2>Настройки</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Закрыть"><X size={18}/></button></div><div className="settings-tabs"><button className={settingsTab === "rules" ? "active" : ""} onClick={() => setSettingsTab("rules")}>Тэги и действия</button><button className={settingsTab === "phone" ? "active" : ""} onClick={() => { setSettingsTab("phone"); openSetup(); }}>Телефон и уведомления</button></div>
      {settingsTab === "rules" ? <div className="settings-content"><p className="settings-intro">ИИ предлагает категории. Автоматический ответ отправляется только по включённому правилу и при достаточной уверенности.</p><form className="new-rule-form" onSubmit={createRule}><div className="rule-form-title">Добавить действие</div><label>Тэг<select name="tag_id" required value={ruleTagId} onChange={(event) => setRuleTagId(event.target.value)}><option value="" disabled>Выберите тэг</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><label>Канал<select name="channel" value={ruleChannel} onChange={(event) => setRuleChannel(event.target.value as "sms" | "whatsapp" | "webhook")}><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="webhook">Вебхук</option></select></label>{ruleChannel === "webhook" && <label>HTTPS URL вебхука<input name="webhook_url" type="url" required placeholder="https://example.ee/webhooks/call"/></label>}<label>{ruleChannel === "webhook" ? "Событие или текст payload" : "Текст сообщения"}<textarea name="message_template" required defaultValue="Здравствуйте! Мы получили ваше сообщение: {{summary}}. Передали его ответственному сотруднику."/></label><div className="template-hint">Переменные: <code>{"{{summary}}"}</code>, <code>{"{{phone}}"}</code>, <code>{"{{tag}}"}</code></div><label>Минимальная уверенность<select name="confidence" defaultValue="0.85"><option value="0.7">70%</option><option value="0.8">80%</option><option value="0.85">85%</option><option value="0.9">90%</option><option value="0.95">95%</option></select></label><button className="primary-button" disabled={busy}>Сохранить правило</button></form>
        <div className="rule-list-title">Правила организации <span>{rules.length}</span></div>{rules.map((rule) => <div key={rule.id} className="rule-row"><i className="tag-dot"/><div><strong>{rule.tag_name}</strong><small>{rule.enabled ? `Уверенность от ${Math.round(rule.min_confidence * 100)}%` : "Отключено"}</small></div><span className="rule-action">{rule.channel === "webhook" ? "Webhook" : `Отправить ${rule.channel.toUpperCase()}`}</span><button className="rule-delete" onClick={() => mutate(`/api/rules/${rule.id}`, "DELETE")}>Удалить</button></div>)}{rules.length === 0 && <div className="notice-empty">Пока нет настроенных действий.</div>}
        <form className="new-tag-form" onSubmit={createTag}><label>Добавить тэг<input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder="Например, Протечка в подъезде"/></label><button className="text-button">+ Создать</button></form><div className="tag-settings-list">{tags.map((tag) => <div key={tag.id}><i className="tag-dot" style={{ background: tag.color }}/><span>{tag.name}</span><small>{tag.origin === "ai" ? "Предложен ИИ" : "Создан организацией"}</small><button className="tag-edit" onClick={async () => { const name = window.prompt("Новое название тэга", tag.name); if (name?.trim()) await mutate(`/api/tags/${tag.id}`, "PATCH", { name: name.trim() }); }}>Переименовать</button><select className="merge-select" aria-label={`Объединить ${tag.name}`} defaultValue="" onChange={async (event) => { const into = event.target.value; if (into && window.confirm(`Объединить «${tag.name}» с выбранным тэгом?`)) await mutate(`/api/tags/${tag.id}`, "PATCH", { merge_into: into }); event.target.value = ""; }}><option value="">Объединить…</option>{tags.filter((other) => other.id !== tag.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}</select></div>)}</div></div> : <div className="settings-content"><p className="settings-intro">Подключите переадресацию, если номер занят или вы не ответили. Звонки будут попадать на номер Kontuur.</p><form className="phone-config" onSubmit={async (event) => { event.preventDefault(); const phone = String(new FormData(event.currentTarget).get("phone_number") || ""); const saved = await mutate("/api/organization", "PATCH", { phone_number: phone }); if (saved) { setForwarding(await api("/api/setup/forwarding", token)); setToast("Номер сервиса сохранён"); } }}><label>Назначенный номер телефонии<input name="phone_number" type="tel" defaultValue={org?.phone_number || ""} required placeholder="+372…" /></label><button className="primary-button">Сохранить номер</button></form><p className="form-hint">Укажите отдельный входящий номер, выделенный этой организации в аккаунте провайдера.</p><div className="forwarding-number"><span>НОМЕР СЕРВИСА</span><strong>{forwarding?.destination || org?.phone_number || "Не назначен — добавьте номер в настройках сервера"}</strong></div><ol className="forwarding-steps">{(forwarding?.steps || ["Укажите номер сервиса в настройках переадресации оператора.", "Выберите переадресацию при занятости и отсутствии ответа.", "Проверьте настройку тестовым звонком."]).map((step, index) => <li key={step}><i>{index + 1}</i>{step}</li>)}</ol><p className="form-hint">{forwarding?.note || "Коды и меню настройки зависят от оператора. Проверьте инструкцию Telia, Elisa или Tele2."}</p><button className="primary-button" onClick={enableNotifications}><Bell size={14}/> Включить push-уведомления</button></div>}
      </div></div>}
    {toast && <div className="toast"><Check size={15}/>{toast}<button onClick={() => setToast("")}><X size={13}/></button></div>}
  </main>;
}

function navigateMessage(direction: number, list: Message[], active: Message | undefined, set: (id: string) => void) { if (!active) return; const index = list.findIndex((message) => message.id === active.id); const next = list[index + direction]; if (next) set(next.id); }
function duration(value?: number) { if (!value) return "—"; return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function languageName(value?: string) { return ({ ru: "Русский", en: "Английский", et: "Эстонский", russian: "Русский", english: "Английский", estonian: "Эстонский" } as Record<string, string>)[value || ""] || "Язык не определён"; }
function urlBase64ToUint8Array(base64String: string) { const padding = "=".repeat((4 - base64String.length % 4) % 4); const raw = atob((base64String + padding).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((char) => char.charCodeAt(0))); }
