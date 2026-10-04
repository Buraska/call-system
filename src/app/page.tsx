"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArrowDownLeft, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Inbox, Link2, Menu, Mic, MoreHorizontal, Plus, Search, Send, Settings2, Sparkles, Tag as TagIcon, X } from "lucide-react";
import { SimulatedCallModal } from "./SimulatedCallModal";
import { api } from "../lib/api";
import { AppLocale, formatLocale, translate } from "./locales";
import { AssistantChat } from "./AssistantChat";


type User = { id: string; name: string; email: string; organization_id: string; role: string };
type Org = { name: string; phone_number?: string; forwarding_mode?: string; languages?: string[]; auto_reply_min_confidence?: number };
type Message = { id: string; contact_name?: string; caller_phone: string; summary: string; transcript: string; tag_id?: string | null; tag_name: string; tag_origin: "manual" | "existing" | "suggested"; confidence: number; language?: string; status: "new" | "done"; source?: string; duration_seconds?: number; created_at: string; auto_reply?: { channel: string; text: string; sent_at?: string; attempted_at?: string; status?: string }; last_reply?: { channel: string; text: string; sent_at: string; status?: string } };
type TagItem = { id: string; name: string; color: string; origin: string };
type Rule = { id: string; tag_id: string; tag_name: string; channel: "telegram"; message_template: string; enabled: boolean };
type Notice = { id: string; title: string; body: string; read: boolean; created_at: string; message_id?: string };


function dateLabel(value: string, locale: AppLocale) {
  return new Date(value).toLocaleDateString(formatLocale(locale), { day: "numeric", month: "short" });
}
function activeLocale(): AppLocale { return typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "ru"; }
function shortTime(value: string, locale: AppLocale = activeLocale()) { return new Date(value).toLocaleTimeString(formatLocale(locale), { hour: "2-digit", minute: "2-digit" }); }
function relativeTime(value: string, locale: AppLocale = activeLocale()) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (locale === "ru") {
    if (mins < 1) return "только что";
    if (mins < 60) return `${mins} мин. назад`;
    if (mins < 1440) return `${Math.floor(mins / 60)} ч. назад`;
  } else {
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`;
  }
  return dateLabel(value, locale);
}
function avatarClass(index: number) { return ["avatar-lilac", "avatar-peach", "avatar-mint", "avatar-blue", "avatar-rose"][index % 5]; }
function avatarLetter(name?: string) { return !name || name === "Unknown number" || name === "Неизвестный номер" ? "?" : name[0].toUpperCase(); }

function AuthScreen({ onAuthenticated, locale }: { onAuthenticated: (token: string, user: User) => void; locale: AppLocale }) {
  const t = (text: string) => translate(locale, text);
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
  return <main className="auth-page"><section className="auth-card"><a className="brand auth-brand" href="#"><span className="brand-mark"><span/><span/><span/></span><span>kontuur</span></a><div className="eyebrow">{t("ПРИЁМ ОБРАЩЕНИЙ ПО ЗВОНКАМ")}</div><h1>{register ? t("Создайте рабочее пространство") : t("С возвращением")}</h1><p className="auth-description">{t("Звонки, транскрипты и ответы клиентам — в одном простом списке.")}</p><form onSubmit={submit} className="auth-form">{register && <><label>{t("Ваше имя")}<input required name="name" autoComplete="name" placeholder={locale === "en" ? "Jane Smith" : "Мария Иванова"}/></label><label>{t("Название организации")}<input required name="organization_name" placeholder={t("Например, Kodu Haldus OÜ")}/></label><label>{t("Ваш номер телефона")}<input name="phone" type="tel" placeholder="+372 …"/></label></>}<label>{t("Рабочий email")}<input required name="email" type="email" autoComplete="email" placeholder="name@company.ee"/></label><label>{t("Пароль")}<input required name="password" type="password" minLength={register ? 8 : 1} autoComplete={register ? "new-password" : "current-password"} placeholder={register ? t("Не менее 8 символов") : t("Ваш пароль")}/></label>{error && <div className="form-error">{error}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? t("Подождите…") : register ? t("Создать аккаунт") : t("Войти")}</button></form><button className="auth-toggle" onClick={() => { setRegister(!register); setError(""); }}>{register ? t("Уже есть аккаунт? Войти") : t("Первая организация? Создать аккаунт")}</button><div className="auth-foot">{t("Данные доступны только сотрудникам вашей организации.")}</div></section></main>;
}


 
export default function Home() {
  const [locale, setLocale] = useState<AppLocale>("ru");
  const t = (text: string) => translate(locale, text);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const saved = localStorage.getItem("kontuur_language");
    const nextLocale: AppLocale = saved === "en" ? "en" : "ru";
    setLocale(nextLocale);
    document.documentElement.lang = nextLocale;
  }, []);
  function updateLocale(nextLocale: AppLocale) {
    setLocale(nextLocale);
    localStorage.setItem("kontuur_language", nextLocale);
    document.documentElement.lang = nextLocale;
  }
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("unanswered");
  const [query, setQuery] = useState("");
  const [selectedTagId, setSelectedTagId] = useState("");
  const [bulk, setBulk] = useState<string[]>([]);
  const [replyOpen, setReplyOpen] = useState(false);
  const [simulatedCallOpen, setSimulatedCallOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "actions" | "tags" | "phone" | "rules">("general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [ruleTagId, setRuleTagId] = useState("");
  const [ruleTemplate, setRuleTemplate] = useState("Здравствуйте! Мы получили ваше сообщение: {{summary}}. Передали его ответственному сотруднику.");
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [newTagName, setNewTagName] = useState("");
  const [globalConfidence, setGlobalConfidence] = useState(0.85);
  const [possibleLanguages, setPossibleLanguages] = useState<string[]>(["ru", "en", "et"]);
  const [forwarding, setForwarding] = useState<{ destination: string; steps: string[]; note: string } | null>(null);
  const [telegramOrganizationCode, setTelegramOrganizationCode] = useState("");
  const [telegramBotUrl, setTelegramBotUrl] = useState("");

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
  useEffect(() => { if (org?.auto_reply_min_confidence != null) setGlobalConfidence(org.auto_reply_min_confidence); }, [org?.auto_reply_min_confidence]);
  useEffect(() => { if (org?.languages) setPossibleLanguages(org.languages); }, [org?.languages]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileMenuOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);
  useEffect(() => {
    const restoreMobileDetail = (event: PopStateEvent) => {
      const state = event.state as { kontuurMobileDetail?: boolean; selectedId?: string } | null;
      if (state?.kontuurMobileDetail) {
        if (state.selectedId) setSelectedId(state.selectedId);
        setDetailOpen(true);
      } else {
        setDetailOpen(false);
      }
    };
    window.addEventListener("popstate", restoreMobileDetail);
    return () => window.removeEventListener("popstate", restoreMobileDetail);
  }, []);
  function openDetail(id?: string) {
    if (window.matchMedia("(max-width: 680px)").matches) {
      const currentState = window.history.state as { kontuurMobileDetail?: boolean } | null;
      const nextState = { ...(currentState || {}), kontuurMobileDetail: true, ...(id ? { selectedId: id } : {}) };
      if (currentState?.kontuurMobileDetail) window.history.replaceState(nextState, "");
      else window.history.pushState(nextState, "");
    }
    if (id) setSelectedId(id);
    setDetailOpen(true);
  }
  function closeDetail() {
    const currentState = window.history.state as { kontuurMobileDetail?: boolean } | null;
    if (currentState?.kontuurMobileDetail) window.history.back();
    else setDetailOpen(false);
  }
  const visibleMessages = useMemo(() => messages.filter((message) => {
    const matchesFilter = filter === "all" || (filter === "unanswered" && !message.auto_reply && !message.last_reply);
    const matchesTag = !selectedTagId || message.tag_id === selectedTagId;
    const haystack = `${message.contact_name ?? ""} ${message.caller_phone} ${message.summary} ${message.tag_name}`.toLowerCase();
    return matchesFilter && matchesTag && haystack.includes(query.toLowerCase());
  }), [messages, filter, query, selectedTagId]);
  const replyableMessages = useMemo(() => visibleMessages.filter((message) => message.source === "telegram"), [visibleMessages]);
  const allVisibleSelected = replyableMessages.length > 0 && replyableMessages.every((message) => bulk.includes(message.id));
  const active = messages.find((item) => item.id === selectedId);
  useEffect(() => {
    if (active && visibleMessages.some((message) => message.id === active.id)) return;
    setSelectedId(visibleMessages[0]?.id ?? "");
  }, [active, visibleMessages]);
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
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { setToast(t("Браузер не поддерживает push-уведомления")); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { setToast(t("Разрешите уведомления в настройках браузера")); return; }
    try {
      const keyData = await api("/api/push/public-key", token);
      if (!keyData.public_key) { setToast(t("Push не настроен сервером — новые звонки видны в приложении")); return; }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyData.public_key) });
      await api("/api/push/subscribe", token, { method: "POST", body: JSON.stringify(subscription.toJSON()) });
      setToast(t("Уведомления включены"));
    } catch (err) { setToast((err as Error).message); }
  }
  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!active || !token) return;
    const form = new FormData(event.currentTarget); const text = String(form.get("text") || "");
    const result = bulk.length
      ? await mutate("/api/messages/bulk-reply", "POST", { message_ids: bulk, text })
      : await mutate(`/api/messages/${active.id}/reply`, "POST", { text });
    if (result) { setReplyOpen(false); setBulk([]); setToast(result.status === "demo" || result.results?.some((item: { status: string }) => item.status === "demo") ? t("Демо-режим: сообщение не отправлено") : t("Ответ отправлен")); }
  }
  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const body = {
      tag_id: String(form.get("tag_id")),
      message_template: String(form.get("message_template")),
      enabled: ruleEnabled,
    };
    const result = editingRule
      ? await mutate(`/api/rules/${editingRule.id}`, "PATCH", body)
      : await mutate("/api/rules", "POST", body);
    if (result) {
      setActionDialogOpen(false);
      setToast(t(editingRule ? "Действие обновлено" : "Правило сохранено"));
      setEditingRule(null);
    }
  }
  function openActionDialog(tagId = selectedTagId) {
    setEditingRule(null);
    setRuleTagId(tagId || "");
    setRuleTemplate(locale === "en" ? "Hello! We received your message: {{summary}}. We forwarded it to the appropriate team member." : "Здравствуйте! Мы получили ваше сообщение: {{summary}}. Передали его ответственному сотруднику.");
    setRuleEnabled(true);
    setActionDialogOpen(true);
  }
  function editAction(rule: Rule) {
    setEditingRule(rule);
    setRuleTagId(rule.tag_id);
    setRuleTemplate(rule.message_template);
    setRuleEnabled(rule.enabled);
    setActionDialogOpen(true);
  }
  async function saveGlobalConfidence() {
    const result = await mutate("/api/organization", "PATCH", { auto_reply_min_confidence: globalConfidence });
    if (result) setToast(t("Общий порог уверенности сохранён"));
  }
  async function savePossibleLanguages() {
    const result = await mutate("/api/organization", "PATCH", { languages: possibleLanguages });
    if (result) setToast(t("Возможные языки сохранены"));
  }
  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!newTagName.trim()) return;
    const result = await mutate("/api/tags", "POST", { name: newTagName.trim() });
    if (result) { setNewTagName(""); setToast(t("Тэг создан")); }
  }
  async function acceptTag(message: Message) {
    const result = await mutate(`/api/messages/${message.id}/accept-tag`, "POST", {});
    if (result) setToast(t("Предложенный тэг добавлен в список категорий"));
  }
  async function openSetup() {
    setSettingsTab("phone"); setSettingsOpen(true);
    try { setForwarding(await api("/api/setup/forwarding", token)); } catch { /* displayed in the main error area */ }
  }
  async function createTelegramOrganizationCode() {
    const result = await mutate("/api/telegram/organization-code", "POST");
    if (result) { setTelegramOrganizationCode(result.code); setTelegramBotUrl(result.bot_url); }
  }
  async function markNotice(notice: Notice) {
    await mutate(`/api/notifications/${notice.id}/read`, "POST", { read: true });
    if (notice.message_id) openDetail(notice.message_id);
  }
  if (!token || !user) return <AuthScreen onAuthenticated={authenticate} locale={locale} />;

  return <main className={`app-shell ${detailOpen ? "show-detail" : ""}`}>
    {mobileMenuOpen && <button type="button" className="mobile-menu-backdrop" aria-label={t("Закрыть меню")} onClick={() => setMobileMenuOpen(false)}/>}<aside id="primary-navigation" className={`sidebar ${mobileMenuOpen ? "mobile-menu-open" : ""}`} onClickCapture={() => setMobileMenuOpen(false)}><button type="button" className="mobile-menu-close" aria-label={t("Закрыть меню")} onClick={() => setMobileMenuOpen(false)}><X size={18}/></button><a className="brand" href="#"><span className="brand-mark"><span/><span/><span/></span><span>kontuur</span></a>
      <button className="workspace-switch" onClick={() => { setSettingsTab("general"); setSettingsOpen(true); }}><span className="workspace-avatar">{(org?.name || "K")[0]}</span><span className="workspace-name"><strong>{org?.name || t("Организация")}</strong><span>{t("Рабочее пространство")}</span></span><ChevronDown size={15}/></button>
      <div className="side-label">{t("РАБОТА")}</div><button className={`side-link ${filter === "all" && !selectedTagId ? "active" : ""}`} onClick={() => { setFilter("all"); setSelectedTagId(""); }}><Inbox size={17}/><span>{t("Входящие")}</span><span className="side-count">{newCount}</span></button><button className={`side-link ${filter === "unanswered" && !selectedTagId ? "active" : ""}`} onClick={() => { setFilter("unanswered"); setSelectedTagId(""); }}><Send size={17}/><span>{t("Без ответа")}</span><span className="side-count muted-count">{messages.filter((item) => !item.auto_reply && !item.last_reply).length}</span></button><button className="side-link" onClick={() => { setFilter("all"); setSelectedTagId(""); }}><Archive size={17}/><span>{t("Архив")}</span></button>
      <div className="sidebar-spacer"/><div className="side-label">{t("ВАШИ ТЭГИ")} <button aria-label={t("Добавить тэг")} className="tiny-plus" onClick={() => { setSettingsTab("tags"); setSettingsOpen(true); }}>+</button></div>
      {tags.slice(0, 5).map((tag) => <button key={tag.id} className={`tag-nav ${selectedTagId === tag.id ? "selected" : ""}`} onClick={() => { setSelectedTagId(tag.id); setQuery(""); }}><i className="tag-dot" style={{ background: tag.color }}/>{tag.name}<span>{messages.filter((item) => item.tag_id === tag.id).length}</span></button>)}<button className="show-tags" onClick={() => { setSettingsTab("tags"); setSettingsOpen(true); }}>{t("Все тэги")} <ChevronRight size={14}/></button>
      <div className="sidebar-bottom"><button className="side-link" onClick={() => { setSettingsTab("general"); setSettingsOpen(true); }}><Settings2 size={17}/><span>{t("Настройки")}</span></button><button className="side-link" onClick={enableNotifications}><Bell size={17}/><span>{t("Уведомления")}</span></button><div className="user-card"><div className="user-avatar">{user.name[0]}</div><div><strong>{user.name}</strong><span>{t("Администратор")}</span></div><button className="logout-link" onClick={logout} title={t("Выйти")}><MoreHorizontal size={18}/></button></div></div>
    </aside>

    <section className="inbox-column"><header className="inbox-header"><div className="title-row"><div><div className="eyebrow">{new Date().toLocaleDateString(formatLocale(locale), { weekday: "long", day: "numeric", month: "long" }).toUpperCase()}</div><h1>{t("Входящие")} <span className="title-count">{newCount}</span></h1></div><div className="mobile-header-actions"><button type="button" className="icon-button mobile-menu-toggle" aria-label={t("Открыть меню")} aria-controls="primary-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}><Menu size={18}/></button><button className="icon-button mobile-settings" aria-label={t("Настройки")} onClick={() => { setSettingsTab("general"); setSettingsOpen(true); }}><Settings2 size={18}/></button></div></div>
        <div className="inbox-toolbar"><div className="filter-tabs"><button className={`filter-tab ${filter === "unanswered" ? "selected" : ""}`} onClick={() => setFilter("unanswered")}>{t("Без ответа")}</button><button className={`filter-tab ${filter === "all" ? "selected" : ""}`} onClick={() => setFilter("all")}>{t("Все")}</button></div><button type="button" className="add-rule-toolbar" onClick={() => { setSettingsTab("actions"); setSettingsOpen(true); }}><Settings2 size={13}/>{t("Действия")}</button></div>
        <label className="search-box"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Поиск по сообщениям")}/><kbd>⌘ K</kbd></label></header>
      {bulk.length > 0 && <div className="bulk-bar"><span>{t("Выбрано:")} <b>{bulk.length}</b></span><button onClick={() => setBulk([])}><X size={14}/> {t("Снять выбор")}</button><button className="bulk-send" onClick={() => setReplyOpen(true)}><Send size={14}/> {t("Ответить выбранным")}</button></div>}
      {error && <div className="inline-error"><span>{error}</span><button onClick={() => setError("")}><X size={14}/></button></div>}
      <div className="list-select-toolbar"><span>{t("Сообщений:")} {visibleMessages.length}</span><button className="select-all-button" disabled={!replyableMessages.length} aria-pressed={allVisibleSelected} onClick={() => { const visibleIds = replyableMessages.map((message) => message.id); setBulk(allVisibleSelected ? [] : visibleIds); }}>{allVisibleSelected ? t("Снять выделение") : t("Выделить всё")}</button></div>
      <div className="message-list">{visibleMessages.map((message, index) => <article key={message.id} className={`message-row ${selectedId === message.id ? "current" : ""}`} onClick={() => openDetail(message.id)}>{message.source === "telegram" && <label className="row-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={bulk.includes(message.id)} onChange={() => setBulk((old) => old.includes(message.id) ? old.filter((id) => id !== message.id) : [...old, message.id])}/><span/></label>}<div className="row-main"><div className="row-top"><strong>{message.contact_name || t("Неизвестный номер")}</strong><time>{relativeTime(message.created_at, locale)}</time></div><div className="row-phone">{message.caller_phone}</div><p>{message.summary}</p><div className="row-bottom"><span className={`tag-pill ${message.tag_origin === "suggested" ? "suggested" : ""}`}><i className="tag-dot" style={{ background: message.tag_origin === "suggested" ? "#ab8bbd" : undefined }}/>{message.tag_name}</span><span className="confidence">{Math.round(message.confidence * 100)}%</span></div></div>{message.status === "new" && <i className="new-indicator"/>}</article>)}</div>
      <footer className="list-footer"><div className="list-footer-left"><span>{t("Показано")} {visibleMessages.length} {t("из")} {messages.length}</span></div><button onClick={() => refresh(token)}>{t("Обновить")} <ChevronDown size={14}/></button></footer>
    </section>

    <section className="detail-column"><header className="detail-header"><div className="detail-header-left"><button className="icon-button detail-back" aria-label={t("Назад")} onClick={closeDetail}><ChevronLeft size={18}/></button><span className="live-dot"/>{active ? t("Звонок обработан") : t("Сообщение")}{active && <span className="detail-time">· {relativeTime(active.created_at, locale)}</span>}</div><div className="detail-header-actions"><button className="icon-button" aria-label={t("Предыдущее сообщение")} onClick={() => navigateMessage(-1, visibleMessages, active, setSelectedId)}><ChevronLeft size={17}/></button><button className="icon-button" aria-label={t("Следующее сообщение")} onClick={() => navigateMessage(1, visibleMessages, active, setSelectedId)}><ChevronRight size={17}/></button><span className="vertical-rule"/><div className="notice-wrapper"><button className="icon-button notification-button" aria-label={t("Уведомления")} onClick={() => setNoticeOpen(!noticeOpen)}><Bell size={17}/>{unreadCount > 0 && <i/>}</button>{noticeOpen && <div className="notice-popover"><div className="notice-heading">{t("Уведомления")} <button onClick={enableNotifications}>{t("Включить push")}</button></div>{notices.length === 0 ? <p className="notice-empty">{t("Новых уведомлений пока нет")}</p> : notices.slice(0, 8).map((notice) => <button key={notice.id} className={`notice-item ${notice.read ? "read" : ""}`} onClick={() => markNotice(notice)}><span className="notice-dot"/><span><b>{notice.title}</b><small>{notice.body} · {relativeTime(notice.created_at, locale)}</small></span></button>)}</div>}</div><button className="icon-button" aria-label={t("Другие действия")}><MoreHorizontal size={18}/></button></div></header>
 
      {active ? <><div className="detail-scroll"><div className="contact-block"><div className={`avatar ${avatarClass(messages.indexOf(active))}`}>{avatarLetter(active.contact_name)}</div><div className="contact-main"><h2>{active.contact_name || t("Неизвестный номер")}</h2><div className="phone-line">{active.caller_phone}<button aria-label={t("Скопировать номер")} onClick={() => navigator.clipboard?.writeText(active.caller_phone)}><Link2 size={13}/></button></div></div><button className="icon-button contact-more" aria-label={t("Действия с контактом")}><MoreHorizontal size={18}/></button></div>
        <div className="summary-card"><div className="summary-label"><Sparkles size={14}/> {t("КРАТКО")}</div><h3>{active.summary}</h3><div className="tag-line"><span className={`tag-pill detail-tag ${active.tag_origin === "suggested" ? "suggested" : ""}`}><i className="tag-dot" style={{ background: active.tag_origin === "suggested" ? "#ab8bbd" : undefined }}/>{active.tag_name}{active.tag_origin === "suggested" && <Sparkles size={11}/>}</span>{active.tag_origin === "suggested" && <><span className="ai-label">{t("Предложен ИИ")}</span><button className="text-button accept-tag" onClick={() => acceptTag(active)}>{t("Добавить в тэги")}</button></>}<select className="change-tag" value={active.tag_id || ""} onChange={(event) => mutate(`/api/messages/${active.id}`, "PATCH", { tag_id: event.target.value })}><option value="" disabled>{t("Изменить")}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div><div className="confidence-note">{active.confidence != null ? `${t("Уверенность категории:")} ${Math.round(active.confidence * 100)}%` : ""}</div></div>
        <section className="content-section"><div className="section-heading"><h3>{t("Транскрипт звонка")}</h3><button className="text-button" onClick={() => navigator.clipboard?.writeText(active.transcript)}>{t("Копировать")}</button></div><div className="transcript-card"><div className="transcript-meta"><span className="transcript-icon"><ArrowDownLeft size={14}/></span><span>{t("Звонящий")}</span><time>{shortTime(active.created_at, locale)}</time></div><p>«{active.transcript}»</p><div className="transcript-foot"><span><Clock3 size={13}/> {duration(active.duration_seconds)}</span><span>{languageName(active.language, locale)} · {t("Распознано автоматически")}</span></div></div></section>
        <section className="content-section action-section"><div className="section-heading"><h3>{t("Автоматическое действие")}</h3><button className="text-button" onClick={() => { setSettingsTab("actions"); setSettingsOpen(true); }}>{t("Настроить")}</button></div>{active.auto_reply ? <div className="action-card"><div className="action-status"><span className="check-ring"><Check size={12}/></span><span>{active.auto_reply.status === "demo" ? t("Демо: сообщение не отправлено") : t("Ответ отправлен")}</span><span className="channel-badge">{active.auto_reply.channel.toUpperCase()}</span><time>{shortTime(active.auto_reply.sent_at || active.auto_reply.attempted_at || "", locale)}</time></div><p>{active.auto_reply.text}</p><div className="action-foot"><span>{t("Правило:")} <b>{active.tag_name}</b></span><span>{active.auto_reply.sent_at ? `${t("Отправлено")} ${shortTime(active.auto_reply.sent_at, locale)}` : t("Действие выполнено")}</span></div></div> : <div className="action-empty"><span>{t("Автоматического ответа нет")}</span><button className="text-button" onClick={() => { setSettingsTab("actions"); setSettingsOpen(true); }}>{t("Настроить правило")}</button></div>}</section>
        <section className="content-section activity-section"><div className="section-heading"><h3>{t("Сведения")}</h3></div><div className="activity-line"><div className="activity-icon"><Bell size={13}/></div><div><span>{t("Уведомление организации")}</span><small>{relativeTime(active.created_at, locale)} · {t("Push и список уведомлений")}</small></div><CheckCheck size={14} className="activity-check"/></div><div className="activity-line"><div className="activity-icon ai-activity"><Sparkles size={13}/></div><div><span>{t("Транскрипт готов · тэг определён")}</span><small>{languageName(active.language, locale)} · {t("уверенность")} {Math.round((active.confidence || 0) * 100)}%</small></div></div><div className="activity-line"><div className="activity-icon"><Clock3 size={13}/></div><div><span>{t("Аудиозапись удалена после распознавания")}</span><small>{t("Хранится транскрипт и метаданные звонка")}</small></div></div></section>
      </div><footer className="detail-footer"><button className={`done-button ${active.status === "done" ? "is-done" : ""}`} onClick={() => mutate(`/api/messages/${active.id}`, "PATCH", { status: active.status === "done" ? "new" : "done" })}>{active.status === "done" ? <CheckCheck size={16}/> : <Check size={16}/>} {active.status === "done" ? t("Обработано") : t("Отметить обработанным")}</button>{active.source === "telegram" && <button className="reply-button" onClick={() => { setBulk([]); setReplyOpen(true); }}><Send size={15}/> {t("Ответить вручную")}</button>}</footer></> : <div className="empty-detail"><Inbox size={26}/><strong>{t("Выберите обращение")}</strong><span>{t("Звонки и ответы будут показаны здесь")}</span></div>}</section>

    {replyOpen && active && <div className="modal-backdrop" onClick={() => setReplyOpen(false)}><form className="reply-modal" onSubmit={sendReply} onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">{t("ОТВЕТ КЛИЕНТУ")}</span><h2>{bulk.length ? `${t("Ответ для")} ${bulk.length} ${t("получателей")}` : active.contact_name || active.caller_phone}</h2></div><button type="button" className="icon-button" onClick={() => setReplyOpen(false)} aria-label={t("Закрыть")}><X size={18}/></button></div><p className="form-hint">{t("Ответ отправится в исходный Telegram-чат.")}</p><textarea name="text" required maxLength={1000} defaultValue={active.auto_reply?.text || active.last_reply?.text || (locale === "en" ? "Hello! We received your message and forwarded it to the appropriate team member. We’ll update you as soon as we have more information." : "Здравствуйте! Мы получили ваше сообщение и передали его ответственному сотруднику. Сообщим, как только появится информация.")}/><div className="modal-bottom"><span>{bulk.length ? `${bulk.length} ${t("выбранных Telegram-чатов")}` : t("Ответ придёт в Telegram")}</span><button className="primary-button" disabled={busy}><Send size={14}/> {t("Отправить")}</button></div></form></div>}

    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><div className="settings-modal full-settings" onClick={(event) => event.stopPropagation()}>
      <div className="modal-top"><div><span className="eyebrow">{t("ОРГАНИЗАЦИЯ ·")} {org?.name}</span><h2>{t("Настройки")}</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label={t("Закрыть")}><X size={18}/></button></div>
      <div className="settings-tabs"><button className={settingsTab === "general" ? "active" : ""} onClick={() => setSettingsTab("general")}>{t("Основные")}</button><button className={settingsTab === "actions" ? "active" : ""} onClick={() => setSettingsTab("actions")}>{t("Действия")}</button><button className={settingsTab === "tags" ? "active" : ""} onClick={() => setSettingsTab("tags")}>{t("Тэги")}</button><button className={settingsTab === "phone" ? "active" : ""} onClick={openSetup}>{t("Телефон и уведомления")}</button></div>
      {settingsTab === "general" && <div className="settings-content">
        <p className="settings-intro">{t("Общие действия и порог уверенности для всех автоматических правил организации.")}</p>
        <div className="confidence-setting"><label htmlFor="app-locale">{t("Язык интерфейса")}</label><select id="app-locale" value={locale} onChange={(event) => updateLocale(event.target.value as AppLocale)}><option value="ru">{t("Русский")}</option><option value="en">{t("Английский")}</option></select></div>
        <div className="confidence-setting"><label htmlFor="global-confidence">{t("Минимальная уверенность")}</label><select id="global-confidence" value={globalConfidence} onChange={(event) => setGlobalConfidence(Number(event.target.value))}><option value={0.7}>70%</option><option value={0.8}>80%</option><option value={0.85}>85%</option><option value={0.9}>90%</option><option value={0.95}>95%</option></select><button className="primary-button" type="button" disabled={busy} onClick={saveGlobalConfidence}>{t("Сохранить порог")}</button></div>
        <p className="form-hint">{t("Действие запускается только если уверенность классификации не ниже этого значения.")}</p>
        <div className="language-setting"><strong>{t("Возможные языки для Whisper")}</strong><div className="language-options">{[{ code: "ru", label: t("Русский") }, { code: "en", label: t("Английский") }, { code: "et", label: t("Эстонский") }].map(({ code, label }) => <label key={code}><input type="checkbox" checked={possibleLanguages.includes(code)} onChange={() => setPossibleLanguages((current) => current.includes(code) ? current.filter((language) => language !== code) : [...current, code])}/>{label}</label>)}</div><p className="form-hint">{t("Используется как подсказка при распознавании; язык по-прежнему определяется автоматически.")}</p><button className="primary-button" type="button" disabled={busy} onClick={savePossibleLanguages}>{t("Сохранить языки")}</button></div>
        <div className="settings-quick-actions"><button className="simulate-call-button" onClick={() => setSimulatedCallOpen(true)}><Mic size={15}/>{t("Записать тестовый звонок")}</button><button className="simulate-call-button" disabled={busy} onClick={createTelegramOrganizationCode}>{t("Создать код подписки Telegram")}</button>{telegramOrganizationCode && <div className="telegram-code-result"><a className="form-hint" href={telegramBotUrl} target="_blank" rel="noreferrer">{t("Открыть Telegram и отправить ссылку")}</a><p className="form-hint">{t("Код организации подставится автоматически. В боте останется указать только имя.")}</p><button className="form-hint" onClick={() => navigator.clipboard?.writeText(telegramOrganizationCode)}>{t("Скопировать код организации:")} {telegramOrganizationCode}</button></div>}</div>
      </div>}
      {settingsTab === "actions" && <div className="settings-content"><p className="settings-intro">{t("Настраивайте автоматические Telegram-ответы для обращений. Все правила используют общий порог уверенности из вкладки «Основные».")}</p><button type="button" className="add-rule-toolbar settings-add-rule" onClick={() => openActionDialog()}><Plus size={13}/>{t("Добавить действие")}</button><div className="rule-list-title">{t("Действия организации")} <span>{rules.length}</span></div>{rules.map((rule) => <div key={rule.id} className="rule-row"><i className="tag-dot"/><div><strong>{rule.tag_name}</strong><small>{rule.enabled ? t("Включено") : t("Отключено")}</small></div><span className="rule-action">{t("Отправить")} Telegram</span><div className="rule-controls"><button type="button" className="rule-edit" onClick={() => editAction(rule)}>{t("Редактировать")}</button><button type="button" className="rule-delete" disabled={busy} onClick={() => mutate(`/api/rules/${rule.id}`, "DELETE")}>{t("Удалить")}</button></div></div>)}{rules.length === 0 && <div className="notice-empty">{t("Пока нет настроенных действий.")}</div>}</div>}
      {settingsTab === "tags" && <div className="settings-content"><p className="settings-intro">{t("Создавайте и объединяйте тэги, по которым распределяются обращения и запускаются действия.")}</p><form className="new-tag-form" onSubmit={createTag}><label>{t("Добавить тэг")}<input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder={t("Например, Протечка в подъезде")}/></label><button className="text-button">{t("+ Создать")}</button></form><div className="tag-settings-list">{tags.map((tag) => <div key={tag.id}><i className="tag-dot" style={{ background: tag.color }}/><span>{tag.name}</span><small>{tag.origin === "ai" ? t("Предложен ИИ") : t("Создан организацией")}</small><button className="tag-edit" onClick={async () => { const name = window.prompt(t("Новое название тэга"), tag.name); if (name?.trim()) await mutate(`/api/tags/${tag.id}`, "PATCH", { name: name.trim() }); }}>{t("Переименовать")}</button><select className="merge-select" aria-label={`${t("Объединить")} ${tag.name}`} defaultValue="" onChange={async (event) => { const into = event.target.value; if (into && window.confirm(`${t("Объединить")} «${tag.name}» ${t("с выбранным тэгом?")}`)) await mutate(`/api/tags/${tag.id}`, "PATCH", { merge_into: into }); event.target.value = ""; }}><option value="">{t("Объединить…")}</option>{tags.filter((other) => other.id !== tag.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}</select><button className="tag-add-rule" onClick={() => openActionDialog(tag.id)}>{t("Добавить правило")}</button></div>)}</div></div>}
      {settingsTab === "phone" && <div className="settings-content"><p className="settings-intro">{t("Подключите переадресацию, если номер занят или вы не ответили. Звонки будут попадать на номер Kontuur.")}</p><form className="phone-config" onSubmit={async (event) => { event.preventDefault(); const phone = String(new FormData(event.currentTarget).get("phone_number") || ""); const saved = await mutate("/api/organization", "PATCH", { phone_number: phone }); if (saved) { setForwarding(await api("/api/setup/forwarding", token)); setToast(t("Номер сервиса сохранён")); } }}><label>{t("Назначенный номер телефонии")}<input name="phone_number" type="tel" defaultValue={org?.phone_number || ""} required placeholder="+372…" /></label><button className="primary-button">{t("Сохранить номер")}</button></form><p className="form-hint">{t("Укажите отдельный входящий номер, выделенный этой организации в аккаунте провайдера.")}</p><div className="forwarding-number"><span>{t("НОМЕР СЕРВИСА")}</span><strong>{forwarding?.destination || org?.phone_number || t("Не назначен — добавьте номер в настройках сервера")}</strong></div><ol className="forwarding-steps">{(forwarding?.steps || [t("Укажите номер сервиса в настройках переадресации оператора."), t("Выберите переадресацию при занятости и отсутствии ответа."), t("Проверьте настройку тестовым звонком.")]).map((step, index) => <li key={step}><i>{index + 1}</i>{step}</li>)}</ol><p className="form-hint">{forwarding?.note || t("Коды и меню настройки зависят от оператора. Проверьте инструкцию Telia, Elisa или Tele2.")}</p><button className="primary-button" onClick={enableNotifications}><Bell size={14}/> {t("Включить push-уведомления")}</button></div>}
      <button type="button" className="mobile-settings-logout" onClick={logout}>{t("Выйти из аккаунта")}</button>
      </div></div>}
    {actionDialogOpen && <div className="modal-backdrop action-dialog-backdrop" onClick={() => setActionDialogOpen(false)}><form className="settings-modal action-dialog" onSubmit={saveRule} onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">{editingRule ? t("НАСТРОЙКА ДЕЙСТВИЯ") : t("НОВОЕ ДЕЙСТВИЕ")}</span><h2>{editingRule ? t("Редактировать действие") : t("Добавить действие")}</h2></div><button type="button" className="icon-button" onClick={() => setActionDialogOpen(false)} aria-label={t("Закрыть")}><X size={18}/></button></div><p className="settings-intro">{t("Выберите тэг и настройте Telegram-ответ для подходящих обращений.")}</p><div className="new-rule-form"><label>{t("Тэг")}<select name="tag_id" required value={ruleTagId} onChange={(event) => setRuleTagId(event.target.value)}><option value="" disabled>{t("Выберите тэг")}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><div className="rule-action">{t("Канал")}: Telegram</div><label>{t("Текст сообщения")}<textarea name="message_template" required value={ruleTemplate} onChange={(event) => setRuleTemplate(event.target.value)}/></label><label className="rule-enabled-field"><input type="checkbox" checked={ruleEnabled} onChange={(event) => setRuleEnabled(event.target.checked)}/>{t("Действие включено")}</label><div className="template-hint">{t("Переменные:")} <code>{"{{summary}}"}</code>, <code>{"{{phone}}"}</code>, <code>{"{{tag}}"}</code></div><div className="action-dialog-actions"><button type="button" className="secondary-button" onClick={() => setActionDialogOpen(false)}>{t("Отмена")}</button><button className="primary-button" disabled={busy}>{editingRule ? t("Сохранить изменения") : t("Добавить действие")}</button></div></div></form></div>}
    {simulatedCallOpen && token && <SimulatedCallModal token={token} onClose={() => setSimulatedCallOpen(false)} onCreated={async () => { setSimulatedCallOpen(false); await refresh(token); }} locale={locale}/>}
    {toast && <div className="toast"><Check size={15}/>{toast}<button onClick={() => setToast("")}><X size={13}/></button></div>}
    {token && <AssistantChat token={token} contextMessageId={selectedId || null} locale={locale}/>}
  </main>;
}

function navigateMessage(direction: number, list: Message[], active: Message | undefined, set: (id: string) => void) { if (!active) return; const index = list.findIndex((message) => message.id === active.id); const next = list[index + direction]; if (next) set(next.id); }
function duration(value?: number) { if (!value) return "—"; return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function languageName(value: string | undefined, locale: AppLocale = activeLocale()) {
  const names: Record<string, [string, string]> = {
    ru: ["Russian", "Русский"], en: ["English", "Английский"], et: ["Estonian", "Эстонский"],
    russian: ["Russian", "Русский"], english: ["English", "Английский"], estonian: ["Estonian", "Эстонский"],
  };
  return value && names[value] ? names[value][locale === "en" ? 0 : 1] : locale === "en" ? "Language not detected" : "Язык не определён";
}
function urlBase64ToUint8Array(base64String: string) { const padding = "=".repeat((4 - base64String.length % 4) % 4); const raw = atob((base64String + padding).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((char) => char.charCodeAt(0))); }
