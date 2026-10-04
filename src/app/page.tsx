"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArrowDownLeft, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Inbox, Link2, Menu, MessageCircle, Mic, MoreHorizontal, Phone, Plus, Search, Send, Settings2, Sparkles, Tag as TagIcon, X } from "lucide-react";
import { SimulatedCallModal } from "./SimulatedCallModal";
import { api } from "../lib/api";
import { AssistantChat } from "./AssistantChat";


type User = { id: string; name: string; email: string; organization_id: string; role: string };
type Org = { name: string; phone_number?: string; forwarding_mode?: string; languages?: string[]; auto_reply_min_confidence?: number };
type Message = { id: string; contact_name?: string; caller_phone: string; summary: string; transcript: string; tag_id?: string | null; tag_name: string; tag_origin: "manual" | "existing" | "suggested"; confidence: number; language?: string; status: "new" | "done"; source?: string; duration_seconds?: number; created_at: string; auto_reply?: { channel: string; text: string; sent_at?: string; attempted_at?: string; status?: string }; last_reply?: { channel: string; text: string; sent_at: string; status?: string } };
type TagItem = { id: string; name: string; color: string; origin: string };
type Rule = { id: string; tag_id: string; tag_name: string; channel: "telegram"; message_template: string; enabled: boolean };
type Notice = { id: string; title: string; body: string; read: boolean; created_at: string; message_id?: string };


function dateLabel(value: string) {
  return new Date(value).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}
function shortTime(value: string) { return new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }); }
function relativeTime(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`;
  return dateLabel(value);
}
function avatarClass(index: number) { return ["avatar-lilac", "avatar-peach", "avatar-mint", "avatar-blue", "avatar-rose"][index % 5]; }
function avatarLetter(name?: string) { return !name || name === "Unknown number" ? "?" : name[0].toUpperCase(); }

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
  return <main className="auth-page"><section className="auth-card"><a className="brand auth-brand" href="#"><span className="brand-mark"><span/><span/><span/></span><span>kontuur</span></a><div className="eyebrow">{"CALL INTAKE"}</div><h1>{register ? "Create your workspace" : "Welcome back"}</h1><p className="auth-description">{"Calls, transcripts, and customer replies in one simple inbox."}</p><form onSubmit={submit} className="auth-form">{register && <><label>{"Your name"}<input required name="name" autoComplete="name" placeholder={"Jane Smith"}/></label><label>{"Organization name"}<input required name="organization_name" placeholder={"For example, Acme Property Management"}/></label><label>{"Your phone number"}<input name="phone" type="tel" placeholder="+372 …"/></label></>}<label>{"Work email"}<input required name="email" type="email" autoComplete="email" placeholder="name@company.ee"/></label><label>{"Password"}<input required name="password" type="password" minLength={register ? 8 : 1} autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "At least 8 characters" : "Your password"}/></label>{error && <div className="form-error">{error}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button></form><button className="auth-toggle" onClick={() => { setRegister(!register); setError(""); }}>{register ? "Already have an account? Sign in" : "First organization? Create an account"}</button><div className="auth-foot">{"Your data is only available to members of your organization."}</div></section></main>;
}


 
export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { document.documentElement.lang = "en"; }, []);
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
  const [ruleTemplate, setRuleTemplate] = useState("Hello! We received your message: {{summary}}. We forwarded it to the appropriate team member.");
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
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { setToast("This browser does not support push notifications"); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { setToast("Allow notifications in your browser settings"); return; }
    try {
      const keyData = await api("/api/push/public-key", token);
      if (!keyData.public_key) { setToast("Push is not configured on the server; new calls will appear in the app"); return; }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyData.public_key) });
      await api("/api/push/subscribe", token, { method: "POST", body: JSON.stringify(subscription.toJSON()) });
      setToast("Notifications enabled");
    } catch (err) { setToast((err as Error).message); }
  }
  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!active || !token) return;
    const form = new FormData(event.currentTarget); const text = String(form.get("text") || "");
    const result = bulk.length
      ? await mutate("/api/messages/bulk-reply", "POST", { message_ids: bulk, text })
      : await mutate(`/api/messages/${active.id}/reply`, "POST", { text });
    if (result) { setReplyOpen(false); setBulk([]); setToast(result.status === "demo" || result.results?.some((item: { status: string }) => item.status === "demo") ? "Demo mode: message was not sent" : "Reply sent"); }
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
      setToast(editingRule ? "Action updated" : "Rule saved");
      setEditingRule(null);
    }
  }
  function openActionDialog(tagId = selectedTagId) {
    setEditingRule(null);
    setRuleTagId(tagId || "");
    setRuleTemplate("Hello! We received your message: {{summary}}. We forwarded it to the appropriate team member.");
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
    if (result) setToast("Organization threshold saved");
  }
  async function savePossibleLanguages() {
    const result = await mutate("/api/organization", "PATCH", { languages: possibleLanguages });
    if (result) setToast("Transcription languages saved");
  }
  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!newTagName.trim()) return;
    const result = await mutate("/api/tags", "POST", { name: newTagName.trim() });
    if (result) { setNewTagName(""); setToast("Tag created"); }
  }
  async function acceptTag(message: Message) {
    const result = await mutate(`/api/messages/${message.id}/accept-tag`, "POST", {});
    if (result) setToast("Suggested tag added to the category list");
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
  if (!token || !user) return <AuthScreen onAuthenticated={authenticate} />;

  return <main className={`app-shell ${detailOpen ? "show-detail" : ""}`}>
    {mobileMenuOpen && <button type="button" className="mobile-menu-backdrop" aria-label={"Close menu"} onClick={() => setMobileMenuOpen(false)}/>}<aside id="primary-navigation" className={`sidebar ${mobileMenuOpen ? "mobile-menu-open" : ""}`} onClickCapture={() => setMobileMenuOpen(false)}><button type="button" className="mobile-menu-close" aria-label={"Close menu"} onClick={() => setMobileMenuOpen(false)}><X size={18}/></button><a className="brand" href="#"><span className="brand-mark"><span/><span/><span/></span><span>kontuur</span></a>
      <button className="workspace-switch" onClick={() => { setSettingsTab("general"); setSettingsOpen(true); }}><span className="workspace-avatar">{(org?.name || "K")[0]}</span><span className="workspace-name"><strong>{org?.name || "Organization"}</strong><span>{"Workspace"}</span></span><ChevronDown size={15}/></button>
      <div className="side-label">{"INBOX"}</div><button className={`side-link ${filter === "all" && !selectedTagId ? "active" : ""}`} onClick={() => { setFilter("all"); setSelectedTagId(""); }}><Inbox size={17}/><span>{"Inbox"}</span><span className="side-count">{newCount}</span></button><button className={`side-link ${filter === "unanswered" && !selectedTagId ? "active" : ""}`} onClick={() => { setFilter("unanswered"); setSelectedTagId(""); }}><Send size={17}/><span>{"Unanswered"}</span><span className="side-count muted-count">{messages.filter((item) => !item.auto_reply && !item.last_reply).length}</span></button><button className="side-link" onClick={() => { setFilter("all"); setSelectedTagId(""); }}><Archive size={17}/><span>{"Archive"}</span></button>
      <div className="sidebar-spacer"/><div className="side-label">{"YOUR TAGS"} <button aria-label={"Add tag"} className="tiny-plus" onClick={() => { setSettingsTab("tags"); setSettingsOpen(true); }}>+</button></div>
      {tags.slice(0, 5).map((tag) => <button key={tag.id} className={`tag-nav ${selectedTagId === tag.id ? "selected" : ""}`} onClick={() => { setSelectedTagId(tag.id); setQuery(""); }}><i className="tag-dot" style={{ background: tag.color }}/>{tag.name}<span>{messages.filter((item) => item.tag_id === tag.id).length}</span></button>)}<button className="show-tags" onClick={() => { setSettingsTab("tags"); setSettingsOpen(true); }}>{"All tags"} <ChevronRight size={14}/></button>
      <div className="sidebar-bottom"><button className="side-link" onClick={() => { setSettingsTab("general"); setSettingsOpen(true); }}><Settings2 size={17}/><span>{"Settings"}</span></button><button className="side-link" onClick={enableNotifications}><Bell size={17}/><span>{"Notifications"}</span></button><div className="user-card"><div className="user-avatar">{user.name[0]}</div><div><strong>{user.name}</strong><span>{"Administrator"}</span></div><button className="logout-link" onClick={logout} title={"Sign out"}><MoreHorizontal size={18}/></button></div></div>
    </aside>

    <section className="inbox-column"><header className="inbox-header"><div className="title-row"><div><div className="eyebrow">{new Date().toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }).toUpperCase()}</div><h1>{"Inbox"} <span className="title-count">{newCount}</span></h1></div><div className="mobile-header-actions"><button type="button" className="icon-button mobile-menu-toggle" aria-label={"Open menu"} aria-controls="primary-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}><Menu size={18}/></button><button className="icon-button mobile-settings" aria-label={"Settings"} onClick={() => { setSettingsTab("general"); setSettingsOpen(true); }}><Settings2 size={18}/></button></div></div>
        <div className="inbox-toolbar"><div className="filter-tabs"><button className={`filter-tab ${filter === "unanswered" ? "selected" : ""}`} onClick={() => setFilter("unanswered")}>{"Unanswered"}</button><button className={`filter-tab ${filter === "all" ? "selected" : ""}`} onClick={() => setFilter("all")}>{"All"}</button></div><button type="button" className="add-rule-toolbar" onClick={() => { setSettingsTab("actions"); setSettingsOpen(true); }}><Settings2 size={13}/>{"Actions"}</button></div>
        <label className="search-box"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={"Search messages"}/><kbd>⌘ K</kbd></label></header>
      {bulk.length > 0 && <div className="bulk-bar"><span>{"Selected:"} <b>{bulk.length}</b></span><button onClick={() => setBulk([])}><X size={14}/> {"Clear selection"}</button><button className="bulk-send" onClick={() => setReplyOpen(true)}><Send size={14}/> {"Reply to selected"}</button></div>}
      {error && <div className="inline-error"><span>{error}</span><button onClick={() => setError("")}><X size={14}/></button></div>}
      <div className="list-select-toolbar"><span>{"Messages:"} {visibleMessages.length}</span><button className="select-all-button" disabled={!replyableMessages.length} aria-pressed={allVisibleSelected} onClick={() => { const visibleIds = replyableMessages.map((message) => message.id); setBulk(allVisibleSelected ? [] : visibleIds); }}>{allVisibleSelected ? "Clear selection" : "Select all"}</button></div>
      <div className="message-list">{visibleMessages.map((message, index) => <article key={message.id} className={`message-row ${selectedId === message.id ? "current" : ""}`} onClick={() => openDetail(message.id)}>{message.source === "telegram" && <label className="row-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={bulk.includes(message.id)} onChange={() => setBulk((old) => old.includes(message.id) ? old.filter((id) => id !== message.id) : [...old, message.id])}/><span/></label>}<span className={`message-placeholder-icon ${message.source === "telegram" ? "telegram" : "phone"}`} aria-hidden="true">{message.source === "telegram" ? <MessageCircle size={16}/> : <Phone size={15}/>}</span><div className="row-main"><div className="row-top"><strong>{message.contact_name || "Unknown number"}</strong><time>{relativeTime(message.created_at)}</time></div><div className="row-phone">{message.caller_phone}</div><p>{message.summary}</p><div className="row-bottom"><span className={`tag-pill ${message.tag_origin === "suggested" ? "suggested" : ""}`}><i className="tag-dot" style={{ background: message.tag_origin === "suggested" ? "#ab8bbd" : undefined }}/>{message.tag_name}</span><span className="confidence">{Math.round(message.confidence * 100)}%</span></div></div>{message.status === "new" && <i className="new-indicator"/>}</article>)}</div>
      <footer className="list-footer"><div className="list-footer-left"><span>{"Showing"} {visibleMessages.length} {"of"} {messages.length}</span></div><button onClick={() => refresh(token)}>{"Refresh"} <ChevronDown size={14}/></button></footer>
    </section>

    <section className="detail-column"><header className="detail-header"><div className="detail-header-left"><button className="icon-button detail-back" aria-label={"Back"} onClick={closeDetail}><ChevronLeft size={18}/></button><span className="live-dot"/>{active ? "Call processed" : "Message"}{active && <span className="detail-time">· {relativeTime(active.created_at)}</span>}</div><div className="detail-header-actions"><button className="icon-button" aria-label={"Previous message"} onClick={() => navigateMessage(-1, visibleMessages, active, setSelectedId)}><ChevronLeft size={17}/></button><button className="icon-button" aria-label={"Next message"} onClick={() => navigateMessage(1, visibleMessages, active, setSelectedId)}><ChevronRight size={17}/></button><span className="vertical-rule"/><div className="notice-wrapper"><button className="icon-button notification-button" aria-label={"Notifications"} onClick={() => setNoticeOpen(!noticeOpen)}><Bell size={17}/>{unreadCount > 0 && <i/>}</button>{noticeOpen && <div className="notice-popover"><div className="notice-heading">{"Notifications"} <button onClick={enableNotifications}>{"Enable push"}</button></div>{notices.length === 0 ? <p className="notice-empty">{"No new notifications"}</p> : notices.slice(0, 8).map((notice) => <button key={notice.id} className={`notice-item ${notice.read ? "read" : ""}`} onClick={() => markNotice(notice)}><span className="notice-dot"/><span><b>{notice.title}</b><small>{notice.body} · {relativeTime(notice.created_at)}</small></span></button>)}</div>}</div><button className="icon-button" aria-label={"More actions"}><MoreHorizontal size={18}/></button></div></header>
 
      {active ? <><div className="detail-scroll"><div className="contact-block"><div className={`avatar ${avatarClass(messages.indexOf(active))}`}>{avatarLetter(active.contact_name)}</div><div className="contact-main"><h2>{active.contact_name || "Unknown number"}</h2><div className="phone-line">{active.caller_phone}<button aria-label={"Copy phone number"} onClick={() => navigator.clipboard?.writeText(active.caller_phone)}><Link2 size={13}/></button></div></div><button className="icon-button contact-more" aria-label={"Contact actions"}><MoreHorizontal size={18}/></button></div>
        <div className="summary-card"><div className="summary-label"><Sparkles size={14}/> {"SUMMARY"}</div><h3>{active.summary}</h3><div className="tag-line"><span className={`tag-pill detail-tag ${active.tag_origin === "suggested" ? "suggested" : ""}`}><i className="tag-dot" style={{ background: active.tag_origin === "suggested" ? "#ab8bbd" : undefined }}/>{active.tag_name}{active.tag_origin === "suggested" && <Sparkles size={11}/>}</span>{active.tag_origin === "suggested" && <><span className="ai-label">{"AI suggested"}</span><button className="text-button accept-tag" onClick={() => acceptTag(active)}>{"Add to tags"}</button></>}<select className="change-tag" value={active.tag_id || ""} onChange={(event) => mutate(`/api/messages/${active.id}`, "PATCH", { tag_id: event.target.value })}><option value="" disabled>{"Change"}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div><div className="confidence-note">{active.confidence != null ? `${"Category confidence:"} ${Math.round(active.confidence * 100)}%` : ""}</div></div>
        <section className="content-section"><div className="section-heading"><h3>{"Call transcript"}</h3><button className="text-button" onClick={() => navigator.clipboard?.writeText(active.transcript)}>{"Copy"}</button></div><div className="transcript-card"><div className="transcript-meta"><span className="transcript-icon"><ArrowDownLeft size={14}/></span><span>{"Caller"}</span><time>{shortTime(active.created_at)}</time></div><p>«{active.transcript}»</p><div className="transcript-foot"><span><Clock3 size={13}/> {duration(active.duration_seconds)}</span><span>{languageName(active.language)} · {"Detected automatically"}</span></div></div></section>
        <section className="content-section action-section"><div className="section-heading"><h3>{"Automatic action"}</h3><button className="text-button" onClick={() => { setSettingsTab("actions"); setSettingsOpen(true); }}>{"Configure"}</button></div>{active.auto_reply ? <div className="action-card"><div className="action-status"><span className="check-ring"><Check size={12}/></span><span>{active.auto_reply.status === "demo" ? "Demo: message not sent" : "Reply sent"}</span><span className="channel-badge">{active.auto_reply.channel.toUpperCase()}</span><time>{shortTime(active.auto_reply.sent_at || active.auto_reply.attempted_at || "")}</time></div><p>{active.auto_reply.text}</p><div className="action-foot"><span>{"Rule:"} <b>{active.tag_name}</b></span><span>{active.auto_reply.sent_at ? `${"Sent"} ${shortTime(active.auto_reply.sent_at)}` : "Action completed"}</span></div></div> : <div className="action-empty"><span>{"No automatic reply"}</span><button className="text-button" onClick={() => { setSettingsTab("actions"); setSettingsOpen(true); }}>{"Configure rule"}</button></div>}</section>
        <section className="content-section activity-section"><div className="section-heading"><h3>{"Details"}</h3></div><div className="activity-line"><div className="activity-icon"><Bell size={13}/></div><div><span>{"Organization notification"}</span><small>{relativeTime(active.created_at)} · {"Push and notification list"}</small></div><CheckCheck size={14} className="activity-check"/></div><div className="activity-line"><div className="activity-icon ai-activity"><Sparkles size={13}/></div><div><span>{"Transcript ready · tag assigned"}</span><small>{languageName(active.language)} · {"confidence"} {Math.round((active.confidence || 0) * 100)}%</small></div></div><div className="activity-line"><div className="activity-icon"><Clock3 size={13}/></div><div><span>{"Audio recording deleted after transcription"}</span><small>{"Transcript and call metadata are retained"}</small></div></div></section>
      </div><footer className="detail-footer"><button className={`done-button ${active.status === "done" ? "is-done" : ""}`} onClick={() => mutate(`/api/messages/${active.id}`, "PATCH", { status: active.status === "done" ? "new" : "done" })}>{active.status === "done" ? <CheckCheck size={16}/> : <Check size={16}/>} {active.status === "done" ? "Processed" : "Mark as processed"}</button>{active.source === "telegram" && <button className="reply-button" onClick={() => { setBulk([]); setReplyOpen(true); }}><Send size={15}/> {"Reply manually"}</button>}</footer></> : <div className="empty-detail"><Inbox size={26}/><strong>{"Select a message"}</strong><span>{"Calls and replies will appear here"}</span></div>}</section>

    {replyOpen && active && <div className="modal-backdrop" onClick={() => setReplyOpen(false)}><form className="reply-modal" onSubmit={sendReply} onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">{"REPLY TO CUSTOMER"}</span><h2>{bulk.length ? `${"Reply to"} ${bulk.length} ${"recipients"}` : active.contact_name || active.caller_phone}</h2></div><button type="button" className="icon-button" onClick={() => setReplyOpen(false)} aria-label={"Close"}><X size={18}/></button></div><p className="form-hint">{"The reply will go to the original Telegram chat."}</p><textarea name="text" required maxLength={1000} defaultValue={active.auto_reply?.text || active.last_reply?.text || ("Hello! We received your message and forwarded it to the appropriate team member. We’ll update you as soon as we have more information.")}/><div className="modal-bottom"><span>{bulk.length ? `${bulk.length} ${"selected Telegram chats"}` : "The reply will be sent through Telegram"}</span><button className="primary-button" disabled={busy}><Send size={14}/> {"Send"}</button></div></form></div>}

    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><div className="settings-modal full-settings" onClick={(event) => event.stopPropagation()}>
      <div className="modal-top"><div><span className="eyebrow">{"ORGANIZATION ·"} {org?.name}</span><h2>{"Settings"}</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label={"Close"}><X size={18}/></button></div>
      <div className="settings-tabs"><button className={settingsTab === "general" ? "active" : ""} onClick={() => setSettingsTab("general")}>{"General"}</button><button className={settingsTab === "actions" ? "active" : ""} onClick={() => setSettingsTab("actions")}>{"Actions"}</button><button className={settingsTab === "tags" ? "active" : ""} onClick={() => setSettingsTab("tags")}>{"Tags"}</button><button className={settingsTab === "phone" ? "active" : ""} onClick={openSetup}>{"Phone and notifications"}</button></div>
      {settingsTab === "general" && <div className="settings-content">
        <p className="settings-intro">{"Default actions and confidence threshold for all organization rules."}</p>
        <div className="confidence-setting"><label htmlFor="global-confidence">{"Minimum confidence"}</label><select id="global-confidence" value={globalConfidence} onChange={(event) => setGlobalConfidence(Number(event.target.value))}><option value={0.7}>70%</option><option value={0.8}>80%</option><option value={0.85}>85%</option><option value={0.9}>90%</option><option value={0.95}>95%</option></select><button className="primary-button" type="button" disabled={busy} onClick={saveGlobalConfidence}>{"Save threshold"}</button></div>
        <p className="form-hint">{"An action runs only when classification confidence meets or exceeds this value."}</p>
        <div className="language-setting"><strong>{"Whisper transcription languages"}</strong><div className="language-options">{[{ code: "ru", label: "Russian" }, { code: "en", label: "English" }, { code: "et", label: "Estonian" }].map(({ code, label }) => <label key={code}><input type="checkbox" checked={possibleLanguages.includes(code)} onChange={() => setPossibleLanguages((current) => current.includes(code) ? current.filter((language) => language !== code) : [...current, code])}/>{label}</label>)}</div><p className="form-hint">{"Used as a transcription hint; the language is still detected automatically."}</p><button className="primary-button" type="button" disabled={busy} onClick={savePossibleLanguages}>{"Save languages"}</button></div>
        <div className="settings-quick-actions"><button className="simulate-call-button" onClick={() => setSimulatedCallOpen(true)}><Mic size={15}/>{"Record a test call"}</button><button className="simulate-call-button" disabled={busy} onClick={createTelegramOrganizationCode}>{"Create Telegram subscription link"}</button>{telegramOrganizationCode && <div className="telegram-code-result"><a className="form-hint" href={telegramBotUrl} target="_blank" rel="noreferrer">{"Open Telegram and send the link"}</a><p className="form-hint">{"The organization code is added automatically. Subscribers only need to enter their name in the bot."}</p><button className="form-hint" onClick={() => navigator.clipboard?.writeText(telegramOrganizationCode)}>{"Copy organization code:"} {telegramOrganizationCode}</button></div>}</div>
      </div>}
      {settingsTab === "actions" && <div className="settings-content"><p className="settings-intro">{"Configure automatic Telegram replies for messages. All rules use the confidence threshold from General settings."}</p><button type="button" className="add-rule-toolbar settings-add-rule" onClick={() => openActionDialog()}><Plus size={13}/>{"Add action"}</button><div className="rule-list-title">{"Organization actions"} <span>{rules.length}</span></div>{rules.map((rule) => <div key={rule.id} className="rule-row"><i className="tag-dot"/><div><strong>{rule.tag_name}</strong><small>{rule.enabled ? "Enabled" : "Disabled"}</small></div><span className="rule-action">{"Send"} Telegram</span><div className="rule-controls"><button type="button" className="rule-edit" onClick={() => editAction(rule)}>{"Edit"}</button><button type="button" className="rule-delete" disabled={busy} onClick={() => mutate(`/api/rules/${rule.id}`, "DELETE")}>{"Delete"}</button></div></div>)}{rules.length === 0 && <div className="notice-empty">{"No actions configured yet."}</div>}</div>}
      {settingsTab === "tags" && <div className="settings-content"><p className="settings-intro">{"Create and merge tags used to organize messages and trigger actions."}</p><form className="new-tag-form" onSubmit={createTag}><label>{"Add tag"}<input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder={"For example, Building leak"}/></label><button className="text-button">{"+ Create"}</button></form><div className="tag-settings-list">{tags.map((tag) => <div key={tag.id}><i className="tag-dot" style={{ background: tag.color }}/><span>{tag.name}</span><small>{tag.origin === "ai" ? "AI suggested" : "Created by organization"}</small><button className="tag-edit" onClick={async () => { const name = window.prompt("New tag name", tag.name); if (name?.trim()) await mutate(`/api/tags/${tag.id}`, "PATCH", { name: name.trim() }); }}>{"Rename"}</button><select className="merge-select" aria-label={`${"Merge"} ${tag.name}`} defaultValue="" onChange={async (event) => { const into = event.target.value; if (into && window.confirm(`${"Merge"} «${tag.name}» ${"with the selected tag?"}`)) await mutate(`/api/tags/${tag.id}`, "PATCH", { merge_into: into }); event.target.value = ""; }}><option value="">{"Merge…"}</option>{tags.filter((other) => other.id !== tag.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}</select><button className="tag-add-rule" onClick={() => openActionDialog(tag.id)}>{"Add rule"}</button></div>)}</div></div>}
      {settingsTab === "phone" && <div className="settings-content"><p className="settings-intro">{"Set up call forwarding when the line is busy or unanswered. Calls will be forwarded to your Kontuur number."}</p><form className="phone-config" onSubmit={async (event) => { event.preventDefault(); const phone = String(new FormData(event.currentTarget).get("phone_number") || ""); const saved = await mutate("/api/organization", "PATCH", { phone_number: phone }); if (saved) { setForwarding(await api("/api/setup/forwarding", token)); setToast("Service number saved"); } }}><label>{"Assigned service number"}<input name="phone_number" type="tel" defaultValue={org?.phone_number || ""} required placeholder="+372…" /></label><button className="primary-button">{"Save number"}</button></form><p className="form-hint">{"Enter the dedicated inbound phone number assigned to this organization by your provider."}</p><div className="forwarding-number"><span>{"SERVICE NUMBER"}</span><strong>{forwarding?.destination || org?.phone_number || "Not assigned — add a number in server settings"}</strong></div><ol className="forwarding-steps">{(forwarding?.steps || ["Enter the service number in your carrier’s call-forwarding settings.", "Enable forwarding when busy and when calls go unanswered.", "Verify the setup with a test call."]).map((step, index) => <li key={step}><i>{index + 1}</i>{step}</li>)}</ol><p className="form-hint">{forwarding?.note || "Carrier codes and menus vary. Check the instructions from your carrier."}</p><button className="primary-button" onClick={enableNotifications}><Bell size={14}/> {"Enable push notifications"}</button></div>}
      <button type="button" className="mobile-settings-logout" onClick={logout}>{"Sign out"}</button>
      </div></div>}
    {actionDialogOpen && <div className="modal-backdrop action-dialog-backdrop" onClick={() => setActionDialogOpen(false)}><form className="settings-modal action-dialog" onSubmit={saveRule} onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">{editingRule ? "EDIT ACTION" : "NEW ACTION"}</span><h2>{editingRule ? "Edit action" : "Add action"}</h2></div><button type="button" className="icon-button" onClick={() => setActionDialogOpen(false)} aria-label={"Close"}><X size={18}/></button></div><p className="settings-intro">{"Choose a tag and configure a Telegram reply for matching messages."}</p><div className="new-rule-form"><label>{"Tag"}<select name="tag_id" required value={ruleTagId} onChange={(event) => setRuleTagId(event.target.value)}><option value="" disabled>{"Select a tag"}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><div className="rule-action">{"Channel"}: Telegram</div><label>{"Message text"}<textarea name="message_template" required value={ruleTemplate} onChange={(event) => setRuleTemplate(event.target.value)}/></label><label className="rule-enabled-field"><input type="checkbox" checked={ruleEnabled} onChange={(event) => setRuleEnabled(event.target.checked)}/>{"Action enabled"}</label><div className="template-hint">{"Variables:"} <code>{"{{summary}}"}</code>, <code>{"{{phone}}"}</code>, <code>{"{{tag}}"}</code></div><div className="action-dialog-actions"><button type="button" className="secondary-button" onClick={() => setActionDialogOpen(false)}>{"Cancel"}</button><button className="primary-button" disabled={busy}>{editingRule ? "Save changes" : "Add action"}</button></div></div></form></div>}
    {simulatedCallOpen && token && <SimulatedCallModal token={token} onClose={() => setSimulatedCallOpen(false)} onCreated={async () => { setSimulatedCallOpen(false); await refresh(token); }} />}
    {toast && <div className="toast"><Check size={15}/>{toast}<button onClick={() => setToast("")}><X size={13}/></button></div>}
    {token && <AssistantChat token={token} contextMessageId={selectedId || null} />}
  </main>;
}

function navigateMessage(direction: number, list: Message[], active: Message | undefined, set: (id: string) => void) { if (!active) return; const index = list.findIndex((message) => message.id === active.id); const next = list[index + direction]; if (next) set(next.id); }
function duration(value?: number) { if (!value) return "—"; return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function languageName(value?: string) {
  const names: Record<string, string> = {
    ru: "Russian", russian: "Russian",
    en: "English", english: "English",
    et: "Estonian", estonian: "Estonian",
  };
  return value ? names[value.toLowerCase()] || value : "Language not detected";
}
function urlBase64ToUint8Array(base64String: string) { const padding = "=".repeat((4 - base64String.length % 4) % 4); const raw = atob((base64String + padding).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((char) => char.charCodeAt(0))); }
