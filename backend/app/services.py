import asyncio
import ipaddress
import json
import logging
import re
import socket
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from bson import ObjectId
import httpx
from openai import AsyncOpenAI
from twilio.rest import Client as TwilioClient

from .config import settings
from .database import get_db

from . import telegram
logger = logging.getLogger(__name__)


def oid(value: str) -> ObjectId:
    if not ObjectId.is_valid(value):
        raise ValueError("Invalid identifier")
    return ObjectId(value)


def serialize(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items() if key != "_id"}
    if isinstance(value, list):
        return [serialize(item) for item in value]
    return value


async def notify(org_id: str, title: str, body: str, message_id: str | None = None):
    db = get_db()
    item = {"organization_id": org_id, "title": title, "body": body, "message_id": message_id, "read": False, "created_at": datetime.now(timezone.utc)}
    await db.notifications.insert_one(item)
    subscribers = await db.telegram_subscribers.find({"organization_id": org_id, "state": "active"}).to_list(length=100)
    for subscriber in subscribers:
        await telegram.send_message(subscriber["chat_id"], f"{title}\n{body}")


async def push_notify(subscriptions: list[dict], item: dict):
    # Push transport is optional; the in-app notification remains available without VAPID configuration.
    try:
        from pywebpush import WebPushException, webpush
        from .config import settings as cfg
        private_key = cfg.vapid_private_key
        if not private_key:
            return
        for sub in subscriptions:
            try:
                await asyncio.to_thread(webpush, subscription_info=sub["subscription"], data=json.dumps({"title": item["title"], "body": item["body"], "url": "/"}), vapid_private_key=private_key, vapid_claims={"sub": f"mailto:{cfg.vapid_claims_email}"})
            except WebPushException:
                logger.exception("Push notification failed")
    except ImportError:
        return


async def transcribe_audio(audio: bytes, filename: str, content_type: str, possible_languages: list[str] | None = None) -> tuple[str, str]:
    if not settings.openai_api_key:
        return "", ""
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    language_names = {"ru": "Russian", "en": "English", "et": "Estonian"}
    prompt = None
    if possible_languages:
        names = [language_names[language] for language in possible_languages if language in language_names]
        if names:
            prompt = "The audio may be spoken in " + ", ".join(names) + "."
    result = await client.audio.transcriptions.create(file=(filename, audio, content_type), model=settings.openai_transcription_model, response_format="verbose_json", **({"prompt": prompt} if prompt else {}))
    return result.text.strip(), getattr(result, "language", "") or ""


async def transcribe(recording_url: str, possible_languages: list[str] | None = None) -> tuple[str, str]:
    if not settings.openai_api_key:
        return "", ""
    auth = (settings.twilio_account_sid, settings.twilio_auth_token) if settings.twilio_account_sid else None
    async with httpx.AsyncClient(timeout=90) as http:
        response = await http.get(recording_url, auth=auth)
        response.raise_for_status()
    return await transcribe_audio(response.content, "call.mp3", "audio/mpeg", possible_languages)


async def classify(text: str, tags: list[dict]) -> dict:
    if not text.strip():
        return {"summary": "Не удалось распознать сообщение", "tag_id": None, "tag_name": "Нужно проверить", "confidence": 0, "language": ""}
    if settings.openai_api_key:
        prompt_tags = [{"id": str(tag["_id"]), "name": tag["name"]} for tag in tags]
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        try:
            response = await client.chat.completions.create(
                model=settings.openai_classification_model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "Классифицируй короткое голосовое сообщение для административной службы. Ответь JSON с полями summary (одно предложение), tag_id (id существующей категории или null), new_tag_name (короткое название новой категории или null), confidence (0..1), language (ru/en/et). Выбирай существующую категорию только при хорошем соответствии. Никогда не создавай действие или ответ."},
                    {"role": "user", "content": json.dumps({"message": text, "categories": prompt_tags}, ensure_ascii=False)},
                ],
                temperature=0.1,
            )
            data = json.loads(response.choices[0].message.content or "{}")
            chosen = next((tag for tag in tags if str(tag["_id"]) == data.get("tag_id")), None)
            new_name = re.sub(r"[^\wА-Яа-яЁёõäöüšž -]", "", str(data.get("new_tag_name") or ""))[:80].strip()
            if chosen:
                return {"summary": str(data.get("summary") or text[:120]), "tag_id": str(chosen["_id"]), "tag_name": chosen["name"], "tag_origin": "existing", "confidence": float(data.get("confidence", 0.5)), "language": data.get("language", "")}
            if not new_name:
                new_name = "Новая категория"
            return {"summary": str(data.get("summary") or text[:120]), "tag_id": None, "tag_name": new_name, "tag_origin": "suggested", "confidence": float(data.get("confidence", 0.5)), "language": data.get("language", "")}
        except Exception:
            logger.exception("Classification failed; using safe fallback")
    lower = text.lower()
    keywords = {"вода": ["вод", "water", "vesi"], "счётчик": ["счётчик", "счетчик", "meter", "arvesti"], "дверь": ["двер", "door", "uks"], "шум": ["шум", "громк", "noise", "müra"], "парков": ["парков", "parking", "parkimine"]}
    chosen = next((tag for tag in tags if any(word in lower for key, words in keywords.items() if key in tag["name"].lower() for word in words)), None)
    if chosen:
        return {"summary": text[:120], "tag_id": str(chosen["_id"]), "tag_name": chosen["name"], "tag_origin": "existing", "confidence": 0.68, "language": ""}
    return {"summary": text[:120], "tag_id": None, "tag_name": "Новая категория", "tag_origin": "suggested", "confidence": 0.3, "language": ""}


def render_template(template: str, message: dict, call: dict) -> str:
    mapping = {"summary": message.get("summary", ""), "transcript": message.get("transcript", ""), "phone": call.get("caller_phone", ""), "tag": message.get("tag_name", "")}
    return re.sub(r"\{\{(summary|transcript|phone|tag)\}\}", lambda match: str(mapping.get(match.group(1), "")), template)


async def send_message(channel: str, to: str, text: str) -> dict:
    if channel == "telegram":
        if not settings.telegram_bot_token:
            return {"status": "demo", "detail": "Telegram bot is not configured; message was not sent"}
        return await telegram.send_message(to, text)
    if not settings.twilio_account_sid or not settings.twilio_auth_token or not settings.twilio_phone_number:
        return {"status": "demo", "detail": "Twilio credentials are not configured; message was not sent"}
    client = TwilioClient(settings.twilio_account_sid, settings.twilio_auth_token)
    destination = f"whatsapp:{to}" if channel == "whatsapp" and not to.startswith("whatsapp:") else to
    origin = f"whatsapp:{settings.twilio_phone_number}" if channel == "whatsapp" else settings.twilio_phone_number
    try:
        message = await asyncio.to_thread(client.messages.create, to=destination, from_=origin, body=text)
        return {"status": "sent", "provider_id": message.sid}
    except Exception as error:
        logger.exception("Message send failed")
        return {"status": "failed", "detail": str(error)[:300]}


async def run_actions(message: dict, call: dict):
    if not message.get("tag_id"):
        return
    db = get_db()
    organization = await db.organizations.find_one({"_id": ObjectId(message["organization_id"])})
    minimum_confidence = float((organization or {}).get("auto_reply_min_confidence", settings.auto_reply_min_confidence))
    if float(message.get("confidence", 0)) < minimum_confidence:
        return
    rules = await db.action_rules.find({"organization_id": message["organization_id"], "tag_id": message["tag_id"], "enabled": True}).to_list(length=20)
    for rule in rules:
        content = render_template(rule["message_template"], message, call)
        if rule["channel"] == "webhook":
            result = await send_webhook(rule.get("webhook_url", ""), {"event": "call.message.created", "message": serialize(message), "call": serialize(call), "text": content})
        else:
            result = await send_message(rule["channel"], call.get("caller_phone", ""), content)
        run = {"organization_id": message["organization_id"], "message_id": str(message["_id"]), "rule_id": str(rule["_id"]), "channel": rule["channel"], "status": result["status"], "detail": result.get("detail"), "provider_id": result.get("provider_id"), "created_at": datetime.now(timezone.utc)}
        await db.action_runs.insert_one(run)
        if result["status"] == "sent":
            await db.messages.update_one({"_id": message["_id"]}, {"$set": {"auto_reply": {"channel": rule["channel"], "text": content, "status": "sent", "sent_at": datetime.now(timezone.utc), "provider_id": result.get("provider_id")}}})
            await notify(message["organization_id"], "Автоответ отправлен", f"{message.get('tag_name', 'Обращение')} · {rule['channel']}", str(message["_id"]))
        elif result["status"] == "demo":
            await db.messages.update_one({"_id": message["_id"]}, {"$set": {"auto_reply": {"channel": rule["channel"], "text": content, "status": "demo", "attempted_at": datetime.now(timezone.utc)}}})


async def send_webhook(url: str, payload: dict) -> dict:
    if not url:
        return {"status": "failed", "detail": "Webhook URL is missing"}
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if parsed.scheme != "https" or not host or parsed.username or parsed.password or host.lower() == "localhost" or host.endswith(".localhost"):
            return {"status": "failed", "detail": "Webhook must use a public HTTPS host"}
        addresses = await asyncio.to_thread(socket.getaddrinfo, host, parsed.port or 443, 0, socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
            return {"status": "failed", "detail": "Webhook host resolves to a non-public IP address"}
    except Exception as error:
        return {"status": "failed", "detail": f"Invalid webhook destination: {str(error)[:200]}"}
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
            return {"status": "sent", "detail": f"HTTP {response.status_code}"}
        except Exception as error:
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
            else:
                return {"status": "failed", "detail": str(error)[:300]}
    return {"status": "failed", "detail": "Delivery attempts exhausted"}


async def delete_recording(recording_sid: str):
    if not recording_sid or not settings.twilio_account_sid or not settings.twilio_auth_token:
        return
    try:
        client = TwilioClient(settings.twilio_account_sid, settings.twilio_auth_token)
        await asyncio.to_thread(client.recordings(recording_sid).delete)
    except Exception:
        logger.exception("Could not delete processed Twilio recording")
