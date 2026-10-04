import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any
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
        return {"summary": "Could not transcribe the message", "tag_id": None, "tag_name": "Needs review", "confidence": 0, "language": ""}
    if settings.openai_api_key:
        prompt_tags = [{"id": str(tag["_id"]), "name": tag["name"]} for tag in tags]
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        try:
            response = await client.chat.completions.create(
                model=settings.openai_classification_model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "Classify a short voice message for a property management team. Respond with JSON fields summary (one sentence in English), tag_id (the id of a strongly matching existing category or null), new_tag_name (a short English category name using Latin letters for a new category or null), confidence (0..1), and language (ru/en/et). Never create an action or reply."},
                    {"role": "user", "content": json.dumps({"message": text, "categories": prompt_tags}, ensure_ascii=False)},
                ],
                temperature=0.1,
            )
            data = json.loads(response.choices[0].message.content or "{}")
            chosen = next((tag for tag in tags if str(tag["_id"]) == data.get("tag_id")), None)
            new_name = re.sub(r"[^A-Za-z0-9õäöüšžÕÄÖÜŠŽ -]", "", str(data.get("new_tag_name") or ""))[:80].strip()
            if chosen:
                return {"summary": str(data.get("summary") or text[:120]), "tag_id": str(chosen["_id"]), "tag_name": chosen["name"], "tag_origin": "existing", "confidence": float(data.get("confidence", 0.5)), "language": data.get("language", "")}
            if not new_name:
                new_name = "New category"
            return {"summary": str(data.get("summary") or text[:120]), "tag_id": None, "tag_name": new_name, "tag_origin": "suggested", "confidence": float(data.get("confidence", 0.5)), "language": data.get("language", "")}
        except Exception:
            logger.exception("Classification failed; using safe fallback")
    lower = text.lower()
    keywords = {
        "water": ["water", "вод"],
        "вод": ["вод", "water"],
        "meter": ["meter", "счётчик", "счетчик"],
        "счётчик": ["счётчик", "счетчик", "meter"],
        "building": ["door", "entrance", "двер", "подъезд"],
        "door": ["door", "entrance", "двер"],
        "дверь": ["двер", "door", "entrance"],
        "noise": ["noise", "шум", "громк"],
        "шум": ["шум", "громк", "noise"],
        "parking": ["parking", "парков"],
        "парков": ["парков", "parking"],
    }
    chosen = next((tag for tag in tags if any(key in tag["name"].lower() for key, words in keywords.items() if any(word in lower for word in words))), None)
    if chosen:
        return {"summary": text[:120], "tag_id": str(chosen["_id"]), "tag_name": chosen["name"], "tag_origin": "existing", "confidence": 0.68, "language": ""}
    return {"summary": text[:120], "tag_id": None, "tag_name": "New category", "tag_origin": "suggested", "confidence": 0.3, "language": ""}


def render_template(template: str, message: dict, call: dict) -> str:
    mapping = {"summary": message.get("summary", ""), "transcript": message.get("transcript", ""), "phone": call.get("caller_phone", ""), "tag": message.get("tag_name", "")}
    return re.sub(r"\{\{(summary|transcript|phone|tag)\}\}", lambda match: str(mapping.get(match.group(1), "")), template)


async def send_telegram(to: str, text: str) -> dict:
    if not settings.telegram_bot_token:
        return {"status": "demo", "detail": "Telegram bot is not configured; message was not sent"}
    return await telegram.send_message(to, text)


async def run_actions(message: dict, call: dict):
    if call.get("source") != "telegram" or not message.get("tag_id"):
        return
    db = get_db()
    organization = await db.organizations.find_one({"_id": ObjectId(message["organization_id"])})
    minimum_confidence = float((organization or {}).get("auto_reply_min_confidence", settings.auto_reply_min_confidence))
    if float(message.get("confidence", 0)) < minimum_confidence:
        return
    rules = await db.action_rules.find({
        "organization_id": message["organization_id"],
        "tag_id": message["tag_id"],
        "channel": "telegram",
        "enabled": True,
    }).to_list(length=20)
    for rule in rules:
        content = render_template(rule["message_template"], message, call)
        result = await send_telegram(call["caller_phone"], content)
        run = {"organization_id": message["organization_id"], "message_id": str(message["_id"]), "rule_id": str(rule["_id"]), "channel": "telegram", "status": result["status"], "detail": result.get("detail"), "provider_id": result.get("provider_id"), "created_at": datetime.now(timezone.utc)}
        await db.action_runs.insert_one(run)
        if result["status"] == "sent":
            await db.messages.update_one({"_id": message["_id"]}, {"$set": {"auto_reply": {"channel": "telegram", "text": content, "status": "sent", "sent_at": datetime.now(timezone.utc), "provider_id": result.get("provider_id")}}})
            await notify(message["organization_id"], "Automatic reply sent", f"{message.get('tag_name', 'Inquiry')} · Telegram", str(message["_id"]))
        elif result["status"] == "demo":
            await db.messages.update_one({"_id": message["_id"]}, {"$set": {"auto_reply": {"channel": "telegram", "text": content, "status": "demo", "attempted_at": datetime.now(timezone.utc)}}})



async def delete_recording(recording_sid: str):
    if not recording_sid or not settings.twilio_account_sid or not settings.twilio_auth_token:
        return
    try:
        client = TwilioClient(settings.twilio_account_sid, settings.twilio_auth_token)
        await asyncio.to_thread(client.recordings(recording_sid).delete)
    except Exception:
        logger.exception("Could not delete processed Twilio recording")
