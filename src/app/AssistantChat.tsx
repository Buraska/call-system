"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, ChevronDown, LoaderCircle, Mic, Plus, Send, Square, X } from "lucide-react";
import { api } from "../lib/api";
import styles from "./AssistantChat.module.css";

type ChatSummary = { id: string; title: string; updated_at: string };
type ChatAction = { name: string; status: string; detail?: string };
type ChatMessage = { role: "user" | "assistant"; content: string; actions?: ChatAction[]; created_at: string; context_message_id?: string | null };
type Chat = ChatSummary & { messages: ChatMessage[] };
export function AssistantChat({ token, contextMessageId }: { token: string; contextMessageId: string | null }) {
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recordingBusy, setRecordingBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const text = {
    open: "Open AI assistant", close: "Close assistant", launcher: "Assistant", panel: "AI assistant chat",
    currentContext: "Current message context", noSelection: "No message selected", back: "Back to chat", history: "Chat history",
    newChat: "New chat", privateChats: "Your private chats will appear here.", usingContext: "Using the selected message as context",
    selectContext: "Select a message to give the assistant context", you: "You", assistant: "Assistant", actions: "Actions",
    working: "Assistant is working…", composerLabel: "Message the assistant", placeholder: "Ask about this message…",
    chooseAudio: "Choose an audio recording", uploadAudio: "Upload voice recording", stopRecording: "Stop recording",
    recordMessage: "Record voice message", recording: "Recording…", transcribing: "Transcribing…",
    keyboardHint: "Enter to send · Shift+Enter for a new line", send: "Send message", noSpeech: "No speech was detected. Try another recording.",
    transcriptionAdded: "Transcription added to message", micError: "Microphone access was not available.", transcribed: (language: string) => `Transcribed · ${language}`,
  };

  const loadChats = useCallback(async () => {
    const items = await api("/api/assistant/chats", token) as ChatSummary[];
    setChats(items);
    return items;
  }, [token]);

  const openChat = useCallback(async (id: string) => {
    setBusy(true); setError("");
    try { setChat(await api(`/api/assistant/chats/${encodeURIComponent(id)}`, token) as Chat); setHistoryOpen(false); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }, [token]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api("/api/assistant/chats", token).then(async (items: ChatSummary[]) => {
      if (!alive) return;
      setChats(items);
      if (!chat && items.length) {
        const latest = await api(`/api/assistant/chats/${encodeURIComponent(items[0].id)}`, token) as Chat;
        if (alive) setChat(latest);
      }
    }).catch((err) => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [open, token, chat?.id]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chat?.messages.length, busy]);
  useEffect(() => () => { recorderRef.current?.stop(); streamRef.current?.getTracks().forEach((track) => track.stop()); }, []);

  async function createChat() {
    setBusy(true); setError("");
    try { const created = await api("/api/assistant/chats", token, { method: "POST", body: JSON.stringify({}) }) as Chat; setChat(created); setHistoryOpen(false); setDraft(""); await loadChats(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      let current = chat;
      if (!current) current = await api("/api/assistant/chats", token, { method: "POST", body: JSON.stringify({}) }) as Chat;
      setDraft("");
      const updated = await api(`/api/assistant/chats/${encodeURIComponent(current.id)}/messages`, token, { method: "POST", body: JSON.stringify({ content, context_message_id: contextMessageId }) }) as Chat;
      setChat(updated); await loadChats();
    } catch (err) { setDraft(content); setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function transcribe(file: File) {
    setRecordingBusy(true); setError(""); setNotice("");
    try {
      const form = new FormData(); form.append("audio", file, file.name || "recording.webm");
      const result = await api("/api/assistant/transcribe", token, { method: "POST", body: form }) as { text: string; language: string };
      if (!result.text?.trim()) { setError(text.noSpeech); return; }
      setDraft((old) => old ? `${old.trimEnd()} ${result.text.trim()}` : result.text.trim());
      setNotice(result.language ? text.transcribed(result.language) : text.transcriptionAdded);
    } catch (err) { setError((err as Error).message); }
    finally { setRecordingBusy(false); }
  }

  async function toggleRecording() {
    if (recording) { recorderRef.current?.stop(); setRecording(false); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { fileRef.current?.click(); return; }
    setError(""); setNotice("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream); recorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        setRecording(false); stream.getTracks().forEach((track) => track.stop()); streamRef.current = null;
        if (chunks.length) void transcribe(new File(chunks, `voice-${Date.now()}.webm`, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.start(); setRecording(true);
    } catch (err) { setError((err as Error).message || text.micError); }
  }

  function dismiss() { if (recording) { recorderRef.current?.stop(); setRecording(false); } setOpen(false); }

  return <>
    <button type="button" className={styles.launcher} aria-label={open ? text.close : text.open} aria-expanded={open} onClick={() => setOpen((value) => !value)}><Bot size={19}/><span>{text.launcher}</span></button>
    {open && <section className={styles.panel} aria-label={text.panel}>
      <header className={styles.header}><div className={styles.headerTitle}><span className={styles.botIcon}><Bot size={17}/></span><div><strong>{"Kontuur assistant"}</strong><small>{contextMessageId ? text.currentContext : text.noSelection}</small></div></div><div className={styles.headerButtons}><button type="button" className={styles.iconButton} aria-label={historyOpen ? text.back : text.history} onClick={() => setHistoryOpen((value) => !value)}>{historyOpen ? <ArrowLeft size={17}/> : <ChevronDown size={17}/>}</button><button type="button" className={styles.iconButton} aria-label={text.close} onClick={dismiss}><X size={17}/></button></div></header>
      {historyOpen ? <div className={styles.history} aria-label={text.history}><button type="button" className={styles.newChat} disabled={busy} onClick={createChat}><Plus size={16}/> {text.newChat}</button>{chats.length ? chats.map((item) => <button type="button" key={item.id} className={`${styles.historyItem} ${chat?.id === item.id ? styles.historyActive : ""}`} onClick={() => openChat(item.id)}><strong>{item.title || text.newChat}</strong><time>{new Date(item.updated_at).toLocaleDateString("en-US")}</time></button>) : <p className={styles.empty}>{text.privateChats}</p>}</div> : <>
        <div className={styles.contextBanner}>{contextMessageId ? text.usingContext : text.selectContext}</div>
        <div className={styles.messages} aria-live="polite" aria-relevant="additions text">
          {chat?.messages.map((message, index) => (
            <article className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`} key={`${message.created_at}-${index}`}>
              <div className={styles.messageRole}>{message.role === "user" ? text.you : text.assistant}</div>
              <div className={styles.messageText}>{message.content}</div>
              {message.actions?.length ? <div className={styles.actions}><strong>{text.actions}</strong>{message.actions.map((action, actionIndex) => (
                <div className={styles.action} key={`${action.name}-${actionIndex}`}>
                  <span className={action.status === "completed" || action.status === "success" || action.status === "sent" ? styles.actionSuccess : action.status === "demo" ? styles.actionDemo : styles.actionFailed}>{action.status}</span>
                  <span><b>{action.name}</b>{action.detail && <small>{action.detail}</small>}</span>
                </div>
              ))}</div> : null}
            </article>
          ))}
          {busy && <div className={styles.busy} role="status"><LoaderCircle size={16} className={styles.spinner}/> {text.working}</div>}
          <div ref={endRef}/>
        </div>
        {error && <div className={styles.error} role="alert">{error}</div>}{notice && <div className={styles.notice} role="status">{notice}</div>}
        <form className={styles.composer} onSubmit={submit} aria-busy={busy || recordingBusy}><textarea aria-label={text.composerLabel} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={text.placeholder} rows={2} disabled={busy || recordingBusy} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/><div className={styles.composerButtons}><input ref={fileRef} className={styles.fileInput} type="file" accept="audio/*" aria-label={text.chooseAudio} onChange={(event) => { const file = event.target.files?.[0]; if (file) void transcribe(file); event.currentTarget.value = ""; }}/><button type="button" className={styles.iconButton} disabled={busy || recordingBusy} onClick={() => fileRef.current?.click()} aria-label={text.uploadAudio}><Mic size={17}/></button><button type="button" className={`${styles.iconButton} ${recording ? styles.recording : ""}`} disabled={busy || recordingBusy} onClick={toggleRecording} aria-label={recording ? text.stopRecording : text.recordMessage}>{recording ? <Square size={15}/> : <span className={styles.recordDot}/>}</button><span className={styles.composerHint} role="status" aria-live="polite">{recording ? text.recording : recordingBusy ? text.transcribing : text.keyboardHint}</span><button type="submit" className={styles.send} disabled={!draft.trim() || busy || recordingBusy} aria-label={text.send}><Send size={16}/></button></div></form>
      </>}
    </section>}
  </>;
}
