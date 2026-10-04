"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Mic, X } from "lucide-react";
import { api } from "../lib/api";

type Message = { id: string };

export function SimulatedCallModal({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: (message: Message) => void }) {
  const [callerPhone, setCallerPhone] = useState("");
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (!audio) { setAudioUrl(""); return; }
    const url = URL.createObjectURL(audio);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const elapsed = Math.min(120, Math.floor((Date.now() - startedAtRef.current) / 1000));
      setSeconds(elapsed);
      if (elapsed >= 120 && recorderRef.current?.state === "recording") recorderRef.current.stop();
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function startRecording() {
    setError("");
    setAudio(null);
    setSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setAudio(blob);
        setSeconds(Math.max(1, Math.min(120, Math.round((Date.now() - startedAtRef.current) / 1000))));
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setRecording(false);
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start();
      setRecording(true);
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError((err as Error).message || "Не удалось получить доступ к микрофону");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!audio) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("caller_phone", callerPhone);
    form.append("duration_seconds", String(seconds));
    form.append("audio", audio, `call.${audio.type.includes("mp4") ? "mp4" : "webm"}`);
    try {
      const message = await api("/api/calls/simulate", token, { method: "POST", body: form });
      onCreated(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onClick={onClose}><form className="simulated-call-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
    <div className="modal-top"><div><span className="eyebrow">ТЕСТ ОБРАБОТКИ ЗВОНКА</span><h2>Записать обращение</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={18}/></button></div>
    <label className="simulated-call-field">Номер звонившего<input required type="tel" value={callerPhone} onChange={(event) => setCallerPhone(event.target.value)} placeholder="+37255551234"/></label>
    <div className="simulated-call-recorder">
      {recording ? <><span className="recording-indicator"/><strong>Идёт запись · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</strong><button type="button" className="secondary-button" onClick={stopRecording}>Остановить</button></> : <button type="button" className="primary-button" onClick={startRecording}><Mic size={15}/>{audio ? "Записать заново" : "Начать запись"}</button>}
      {audio && !recording && <audio className="simulated-call-preview" controls src={audioUrl}/>}
    </div>
    <p className="simulated-call-warning">Запись будет обработана как входящий звонок. Включённые правила автоответа сработают и могут отправить реальное SMS или сообщение WhatsApp на указанный номер.</p>
    {error && <div className="inline-error"><span>{error}</span></div>}
    <div className="simulated-call-actions"><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" disabled={!audio || recording || busy}>{busy ? "Обработка…" : "Обработать как звонок"}</button></div>
  </form></div>;
}
