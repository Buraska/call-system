from datetime import datetime, timezone
from typing import Any
import hashlib
import logging
import re
import secrets

from bson import ObjectId
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from jose import jwt
from pymongo.errors import DuplicateKeyError
from twilio.request_validator import RequestValidator

from .config import settings
from .database import get_db, lifespan
from .models import (BulkReply, LoginRequest, ManualReply, MessageUpdate, NotificationRead,
                     OrganizationSettings, RegisterRequest, RuleCreate, RuleUpdate,
                     TagCreate, TagUpdate, WebPushSubscription, now_utc)
from .security import create_access_token, current_user, hash_password, verify_password
from .services import classify, delete_recording, notify, oid, run_actions, serialize, transcribe, transcribe_audio, send_telegram
from .assistant import router as assistant_router
from . import telegram

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Kontuur API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin, "http://127.0.0.1:3000"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(assistant_router)


def public_user(user: dict) -> dict:
    return {"id": str(user["_id"]), "name": user["name"], "email": user["email"], "organization_id": user["organization_id"], "role": user.get("role", "admin")}


async def org_for(user: dict) -> dict:
    org = await get_db().organizations.find_one({"_id": ObjectId(user["organization_id"])})
    if not org:
        raise HTTPException(404, "Organization not found")
    return org


async def validate_twilio(request: Request, form: dict[str, Any]):
    if not settings.twilio_auth_token:
        if settings.demo_mode and request.url.hostname in {"localhost", "127.0.0.1", "::1"}:
            return
        raise HTTPException(503, "Telephony provider is not configured")
    signature = request.headers.get("X-Twilio-Signature", "")
    validator = RequestValidator(settings.twilio_auth_token)
    url = str(request.url)
    # Proxies may rewrite scheme/host; configure APP_BASE_URL as the public URL.
    if settings.app_base_url.startswith("https://"):
        url = settings.app_base_url.rstrip("/") + request.url.path
    if not validator.validate(url, form, signature):
        raise HTTPException(403, "Invalid telephony webhook signature")


@app.get("/health")
async def health():
    await get_db().command("ping")
    return {"status": "ok", "database": "connected", "demo_mode": settings.demo_mode}


@app.post("/api/auth/register", status_code=201)
async def register(body: RegisterRequest):
    db = get_db()
    now = now_utc()
    # Assign a dedicated inbound line to each organization from the phone settings.
    org = {"name": body.organization_name, "owner_phone": body.phone, "phone_number": "", "forwarding_mode": "busy_or_no_answer", "languages": ["ru", "en", "et"], "created_at": now}
    org_result = await db.organizations.insert_one(org)
    user = {"name": body.name, "email": body.email.lower(), "password_hash": hash_password(body.password), "organization_id": str(org_result.inserted_id), "role": "admin", "created_at": now}
    try:
        result = await db.users.insert_one(user)
    except DuplicateKeyError:
        await db.organizations.delete_one({"_id": org_result.inserted_id})
        raise HTTPException(409, "An account with this email already exists")
    for name, color in [("Water outage", "#6eaf8a"), ("Building maintenance", "#d49c65"), ("Parking question", "#829bca"), ("Neighbor noise", "#ba8db8")]:
        await db.tags.insert_one({"organization_id": str(org_result.inserted_id), "name": name, "color": color, "origin": "manual", "created_at": now})
    user["_id"] = result.inserted_id
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": public_user(user), "organization": serialize(org)}


@app.post("/api/auth/login")
async def login(body: LoginRequest):
    user = await get_db().users.find_one({"email": body.email.lower()})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": public_user(user)}


@app.get("/api/auth/me")
async def me(user: dict = Depends(current_user)):
    org = await org_for(user)
    return {"user": public_user(user), "organization": serialize(org)}


@app.get("/api/organization")
async def get_organization(user: dict = Depends(current_user)):
    org = await org_for(user)
    return serialize(org) | {"auto_reply_min_confidence": org.get("auto_reply_min_confidence", settings.auto_reply_min_confidence)}

@app.patch("/api/organization")
async def update_organization(body: OrganizationSettings, user: dict = Depends(current_user)):
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    if "organization_name" in data:
        data["name"] = data.pop("organization_name")
    data["updated_at"] = now_utc()
    db = get_db()
    if "phone_number" in data:
        try:
            await db.phone_numbers.update_one({"organization_id": user["organization_id"]}, {"$set": {"number": data["phone_number"], "updated_at": now_utc()}, "$setOnInsert": {"organization_id": user["organization_id"], "provider": "twilio"}}, upsert=True)
        except DuplicateKeyError:
            raise HTTPException(409, "This service number is already assigned to another organization")
    await db.organizations.update_one({"_id": ObjectId(user["organization_id"])}, {"$set": data})
    org = await org_for(user)
    return serialize(org) | {"auto_reply_min_confidence": org.get("auto_reply_min_confidence", settings.auto_reply_min_confidence)}


@app.get("/api/setup/forwarding")
async def forwarding_setup(user: dict = Depends(current_user)):
    org = await org_for(user)
    destination = org.get("phone_number") or ""
    return {"destination": destination, "forwarding_mode": org.get("forwarding_mode", "busy_or_no_answer"), "steps": ["Open your mobile carrier's call forwarding settings.", f"Enter the service number: {destination or 'a number will be assigned after telephony setup'}.", "Enable call forwarding when the line is busy or you cannot answer.", "Ask a colleague to call and confirm that the call reaches the voicemail system."], "codes": {"busy_or_no_answer": "**67*NUMBER# (code varies by carrier)", "no_answer": "**61*NUMBER# (code varies by carrier)"}, "note": "USSD codes vary by carrier. Check your carrier's instructions."}


@app.get("/api/tags")
async def list_tags(user: dict = Depends(current_user)):
    tags = await get_db().tags.find({"organization_id": user["organization_id"], "archived": {"$ne": True}}).sort("created_at", 1).to_list(length=500)
    return [serialize(tag) | {"id": str(tag["_id"])} for tag in tags]


@app.post("/api/tags", status_code=201)
async def create_tag(body: TagCreate, user: dict = Depends(current_user)):
    item = {"organization_id": user["organization_id"], "name": body.name.strip(), "color": body.color, "origin": "manual", "created_at": now_utc()}
    found = await get_db().tags.find_one({"organization_id": user["organization_id"], "name": {"$regex": f"^{body.name.strip()}$", "$options": "i"}, "archived": {"$ne": True}})
    if found:
        raise HTTPException(409, "A tag with this name already exists")
    result = await get_db().tags.insert_one(item)
    item["_id"] = result.inserted_id
    return serialize(item) | {"id": str(result.inserted_id)}


@app.patch("/api/tags/{tag_id}")
async def update_tag(tag_id: str, body: TagUpdate, user: dict = Depends(current_user)):
    db = get_db()
    try:
        tag = await db.tags.find_one({"_id": oid(tag_id), "organization_id": user["organization_id"]})
    except ValueError:
        tag = None
    if not tag:
        raise HTTPException(404, "Tag not found")
    if body.merge_into:
        target = await db.tags.find_one({"_id": oid(body.merge_into), "organization_id": user["organization_id"], "archived": {"$ne": True}})
        if not target or target["_id"] == tag["_id"]:
            raise HTTPException(400, "Invalid tag to merge")
        await db.messages.update_many({"organization_id": user["organization_id"], "tag_id": str(tag["_id"])}, {"$set": {"tag_id": str(target["_id"]), "tag_name": target["name"], "tag_origin": "existing"}})
        await db.action_rules.update_many({"organization_id": user["organization_id"], "tag_id": str(tag["_id"])}, {"$set": {"tag_id": str(target["_id"])}})
        await db.tags.update_one({"_id": tag["_id"]}, {"$set": {"archived": True, "merged_into": str(target["_id"]), "updated_at": now_utc()}})
        return {"ok": True, "merged_into": str(target["_id"])}
    if body.name:
        await db.tags.update_one({"_id": tag["_id"]}, {"$set": {"name": body.name.strip(), "updated_at": now_utc()}})
        await db.messages.update_many({"organization_id": user["organization_id"], "tag_id": tag_id}, {"$set": {"tag_name": body.name.strip()}})
    return serialize(await db.tags.find_one({"_id": tag["_id"]})) | {"id": tag_id}


@app.post("/api/messages/{message_id}/accept-tag")
async def accept_suggested_tag(message_id: str, user: dict = Depends(current_user)):
    db = get_db()
    try:
        message = await db.messages.find_one({"_id": oid(message_id), "organization_id": user["organization_id"]})
    except ValueError:
        message = None
    if not message:
        raise HTTPException(404, "Message not found")
    if message.get("tag_id"):
        await db.tags.update_one({"_id": oid(message["tag_id"]), "organization_id": user["organization_id"]}, {"$set": {"origin": "manual", "updated_at": now_utc()}})
        await db.messages.update_one({"_id": message["_id"]}, {"$set": {"tag_origin": "existing"}})
        return {"ok": True, "tag_id": message["tag_id"]}
    existing = await db.tags.find_one({"organization_id": user["organization_id"], "name": message.get("tag_name"), "archived": {"$ne": True}})
    if existing:
        tag = existing
    else:
        tag = {"organization_id": user["organization_id"], "name": message.get("tag_name", "New category"), "color": "#ab8bbd", "origin": "ai", "created_at": now_utc()}
        result = await db.tags.insert_one(tag)
        tag["_id"] = result.inserted_id
    await db.messages.update_one({"_id": message["_id"]}, {"$set": {"tag_id": str(tag["_id"]), "tag_name": tag["name"], "tag_origin": "existing"}})
    return {"ok": True, "tag_id": str(tag["_id"]), "tag_name": tag["name"]}


@app.get("/api/rules")
async def list_rules(user: dict = Depends(current_user)):
    rules = await get_db().action_rules.find({"organization_id": user["organization_id"]}).sort("created_at", -1).to_list(length=500)
    return [serialize(rule) | {"id": str(rule["_id"])} for rule in rules]


@app.post("/api/rules", status_code=201)
async def create_rule(body: RuleCreate, user: dict = Depends(current_user)):
    db = get_db()
    tag = await db.tags.find_one({"_id": oid(body.tag_id), "organization_id": user["organization_id"], "archived": {"$ne": True}})
    if not tag:
        raise HTTPException(404, "Tag not found")
    item = {"organization_id": user["organization_id"], "tag_id": body.tag_id, "tag_name": tag["name"], "channel": "telegram", **body.model_dump(), "created_at": now_utc(), "updated_at": now_utc()}
    result = await db.action_rules.insert_one(item)
    item["_id"] = result.inserted_id
    return serialize(item) | {"id": str(result.inserted_id)}


@app.patch("/api/rules/{rule_id}")
async def update_rule(rule_id: str, body: RuleUpdate, user: dict = Depends(current_user)):
    try:
        rule_oid = oid(rule_id)
    except ValueError:
        raise HTTPException(404, "Rule not found")
    data = body.model_dump(exclude_unset=True)
    if "tag_id" in data:
        try:
            tag = await get_db().tags.find_one({
                "_id": oid(data["tag_id"]),
                "organization_id": user["organization_id"],
                "archived": {"$ne": True},
            }) if data["tag_id"] else None
        except ValueError:
            tag = None
        if not tag:
            raise HTTPException(404, "Tag not found")
        data["tag_name"] = tag["name"]
    data["updated_at"] = now_utc()
    result = await get_db().action_rules.update_one(
        {"_id": rule_oid, "organization_id": user["organization_id"]},
        {"$set": data},
    )
    if not result.matched_count:
        raise HTTPException(404, "Rule not found")
    return serialize(await get_db().action_rules.find_one({"_id": rule_oid})) | {"id": rule_id}


@app.delete("/api/rules/{rule_id}")
async def delete_rule(rule_id: str, user: dict = Depends(current_user)):
    try:
        result = await get_db().action_rules.delete_one({"_id": oid(rule_id), "organization_id": user["organization_id"]})
    except ValueError:
        result = None
    if not result or result.deleted_count == 0:
        raise HTTPException(404, "Rule not found")
    return {"ok": True}


@app.get("/api/messages")
async def list_messages(status_filter: str | None = None, tag_id: str | None = None, search: str | None = None, limit: int = 100, user: dict = Depends(current_user)):
    query: dict[str, Any] = {"organization_id": user["organization_id"]}
    if status_filter in ["new", "done"]:
        query["status"] = status_filter
    if tag_id:
        query["tag_id"] = tag_id
    if search:
        query["$or"] = [{"summary": {"$regex": search, "$options": "i"}}, {"transcript": {"$regex": search, "$options": "i"}}, {"contact_name": {"$regex": search, "$options": "i"}}, {"caller_phone": {"$regex": search, "$options": "i"}}, {"tag_name": {"$regex": search, "$options": "i"}}]
    items = await get_db().messages.find(query).sort("created_at", -1).limit(min(max(limit, 1), 200)).to_list(length=None)
    return [serialize(item) | {"id": str(item["_id"])} for item in items]


@app.get("/api/messages/{message_id}")
async def get_message(message_id: str, user: dict = Depends(current_user)):
    try:
        item = await get_db().messages.find_one({"_id": oid(message_id), "organization_id": user["organization_id"]})
    except ValueError:
        item = None
    if not item:
        raise HTTPException(404, "Message not found")
    return serialize(item) | {"id": str(item["_id"])}


@app.patch("/api/messages/{message_id}")
async def update_message(message_id: str, body: MessageUpdate, user: dict = Depends(current_user)):
    db = get_db()
    try:
        message = await db.messages.find_one({"_id": oid(message_id), "organization_id": user["organization_id"]})
    except ValueError:
        message = None
    if not message:
        raise HTTPException(404, "Message not found")
    data = body.model_dump(exclude_unset=True)
    if "tag_id" in data:
        tag = await db.tags.find_one({"_id": oid(data["tag_id"]), "organization_id": user["organization_id"], "archived": {"$ne": True}})
        if not tag:
            raise HTTPException(404, "Tag not found")
        data.update({"tag_name": tag["name"], "tag_origin": "existing"})
    data["updated_at"] = now_utc()
    await db.messages.update_one({"_id": message["_id"]}, {"$set": data})
    updated = await db.messages.find_one({"_id": message["_id"]})
    return serialize(updated) | {"id": message_id}


@app.post("/api/messages/{message_id}/reply")
async def reply(message_id: str, body: ManualReply, user: dict = Depends(current_user)):
    db = get_db()
    try:
        message = await db.messages.find_one({"_id": oid(message_id), "organization_id": user["organization_id"]})
    except ValueError:
        message = None
    if not message:
        raise HTTPException(404, "Message not found")
    if message.get("source") != "telegram":
        raise HTTPException(409, "Replies are only available for messages received through Telegram")
    result = await send_telegram(message.get("caller_phone", ""), body.text)
    run = {"organization_id": user["organization_id"], "message_id": message_id, "channel": "telegram", "kind": "manual", "status": result["status"], "detail": result.get("detail"), "provider_id": result.get("provider_id"), "created_at": now_utc()}
    await db.action_runs.insert_one(run)
    if result["status"] == "failed":
        raise HTTPException(502, result.get("detail", "Could not send message"))
    await db.messages.update_one({"_id": message["_id"]}, {"$set": {"last_reply": {"channel": "telegram", "text": body.text, "status": result["status"], "sent_at": now_utc(), "provider_id": result.get("provider_id")}}})
    return {"status": result["status"], "channel": "telegram", "text": body.text}


@app.post("/api/messages/bulk-reply")
async def bulk_reply(body: BulkReply, user: dict = Depends(current_user)):
    db = get_db()
    messages = await db.messages.find({"_id": {"$in": [oid(item) for item in body.message_ids]}, "organization_id": user["organization_id"]}).to_list(length=100)
    if any(message.get("source") != "telegram" for message in messages):
        raise HTTPException(409, "Bulk replies are only available for messages received through Telegram")
    results = []
    for message in messages:
        result = await send_telegram(message.get("caller_phone", ""), body.text)
        await db.action_runs.insert_one({"organization_id": user["organization_id"], "message_id": str(message["_id"]), "channel": "telegram", "kind": "manual_bulk", "status": result["status"], "detail": result.get("detail"), "provider_id": result.get("provider_id"), "created_at": now_utc()})
        if result["status"] != "failed":
            await db.messages.update_one({"_id": message["_id"]}, {"$set": {"last_reply": {"channel": "telegram", "text": body.text, "status": result["status"], "sent_at": now_utc()}}})
        results.append({"message_id": str(message["_id"]), **result})
    return {"results": results}


@app.get("/api/action-runs")
async def action_runs(message_id: str | None = None, user: dict = Depends(current_user)):
    query: dict[str, Any] = {"organization_id": user["organization_id"]}
    if message_id:
        query["message_id"] = message_id
    runs = await get_db().action_runs.find(query).sort("created_at", -1).limit(100).to_list(length=None)
    return [serialize(run) | {"id": str(run["_id"])} for run in runs]


@app.get("/api/notifications")
async def notifications(unread_only: bool = False, user: dict = Depends(current_user)):
    query: dict[str, Any] = {"organization_id": user["organization_id"]}
    if unread_only:
        query["read"] = False
    items = await get_db().notifications.find(query).sort("created_at", -1).limit(100).to_list(length=None)
    return [serialize(item) | {"id": str(item["_id"])} for item in items]


@app.post("/api/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: str, body: NotificationRead, user: dict = Depends(current_user)):
    try:
        result = await get_db().notifications.update_one({"_id": oid(notification_id), "organization_id": user["organization_id"]}, {"$set": {"read": body.read}})
    except ValueError:
        result = None
    if not result or not result.matched_count:
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@app.post("/api/telegram/organization-code")
async def create_telegram_organization_code(user: dict = Depends(current_user)):
    if not settings.telegram_bot_token or not settings.telegram_bot_username or not settings.telegram_webhook_secret:
        raise HTTPException(503, "Telegram bot is not configured")
    code = secrets.token_urlsafe(18)
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    await get_db().telegram_organization_codes.update_one(
        {"organization_id": user["organization_id"]},
        {"$set": {"organization_id": user["organization_id"], "code_hash": code_hash, "updated_at": now_utc()}},
        upsert=True,
    )
    return {"code": code, "bot_url": f"https://t.me/{settings.telegram_bot_username}?start={code}"}


@app.post("/webhooks/telegram")
async def telegram_webhook(request: Request, background_tasks: BackgroundTasks):
    if not settings.telegram_bot_token or not settings.telegram_webhook_secret:
        raise HTTPException(503, "Telegram webhook is not configured")
    if not secrets.compare_digest(request.headers.get("X-Telegram-Bot-Api-Secret-Token", ""), settings.telegram_webhook_secret):
        raise HTTPException(403, "Invalid Telegram webhook secret")
    update = await request.json()
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return {"ok": True, "ignored": True}

    chat = message.get("chat") or {}
    if chat.get("type") != "private":
        return {"ok": True, "ignored": True}
    chat_id = str(chat.get("id", ""))
    text = message.get("text", "")
    if not chat_id:
        return {"ok": True, "ignored": True}
    db = get_db()
    subscriber = await db.telegram_subscribers.find_one({"chat_id": chat_id})
    command_parts = text.split(maxsplit=1) if text else []
    command = command_parts[0].split("@", 1)[0] if command_parts else ""
    if command == "/start":
        if subscriber and subscriber.get("state") == "active":
            await telegram.send_message(chat_id, f"You're already subscribed as {subscriber.get('name', 'user')}. Send a voice message.")
            return {"ok": True}

        start_payload = command_parts[1].strip() if len(command_parts) > 1 else ""
        pending_code_hash = hashlib.sha256(start_payload.encode()).hexdigest() if start_payload else None
        if pending_code_hash and not await db.telegram_organization_codes.find_one({"code_hash": pending_code_hash}):
            await telegram.send_message(chat_id, "This subscription link is invalid or expired. Ask your administrator for a new one.")
            return {"ok": True, "status": "invalid_organization_code"}

        if not subscriber:
            record = {"chat_id": chat_id, "state": "awaiting_name", "created_at": now_utc(), "updated_at": now_utc()}
            if pending_code_hash:
                record["pending_organization_code_hash"] = pending_code_hash
            try:
                await db.telegram_subscribers.insert_one(record)
            except DuplicateKeyError:
                subscriber = await db.telegram_subscribers.find_one({"chat_id": chat_id})
        else:
            set_fields = {"state": "awaiting_name", "updated_at": now_utc()}
            unset_fields = {"organization_id": "", "name": ""}
            if pending_code_hash:
                set_fields["pending_organization_code_hash"] = pending_code_hash
            else:
                unset_fields["pending_organization_code_hash"] = ""
            await db.telegram_subscribers.update_one(
                {"_id": subscriber["_id"]},
                {"$set": set_fields, "$unset": unset_fields},
            )
        await telegram.send_message(chat_id, "What should we call you? Please send your name.")
        return {"ok": True, "status": "awaiting_name"}

    if subscriber and subscriber.get("state") == "awaiting_name":
        name = text.strip()
        if not name or len(name) > 100:
            await telegram.send_message(chat_id, "Enter a name no longer than 100 characters.")
            return {"ok": True, "status": "awaiting_name"}
        pending_code_hash = subscriber.get("pending_organization_code_hash")
        if pending_code_hash:
            organization = await db.telegram_organization_codes.find_one({"code_hash": pending_code_hash})
            if not organization:
                await db.telegram_subscribers.update_one(
                    {"_id": subscriber["_id"]},
                    {"$set": {"name": name, "state": "awaiting_organization_code", "updated_at": now_utc()},
                     "$unset": {"pending_organization_code_hash": ""}},
                )
                await telegram.send_message(chat_id, "This link has expired. Enter a valid organization code or ask your administrator for a new link.")
                return {"ok": True, "status": "awaiting_organization_code"}
            org = await db.organizations.find_one({"_id": ObjectId(organization["organization_id"])})
            await db.telegram_subscribers.update_one(
                {"_id": subscriber["_id"]},
                {"$set": {"name": name, "organization_id": organization["organization_id"], "state": "active", "updated_at": now_utc()},
                 "$unset": {"pending_organization_code_hash": ""}},
            )
            await telegram.send_message(chat_id, f"Done, {name}! You're subscribed to {org.get('name', 'your organization')}. Send voice messages here.")
            return {"ok": True, "status": "active"}

        await db.telegram_subscribers.update_one(
            {"_id": subscriber["_id"]},
            {"$set": {"name": name, "state": "awaiting_organization_code", "updated_at": now_utc()}},
        )
        await telegram.send_message(chat_id, "Enter the organization code provided by your administrator.")
        return {"ok": True, "status": "awaiting_organization_code"}

    if subscriber and subscriber.get("state") == "awaiting_organization_code":
        code_hash = hashlib.sha256(text.strip().encode()).hexdigest()
        organization = await db.telegram_organization_codes.find_one({"code_hash": code_hash})
        if not organization:
            await telegram.send_message(chat_id, "Organization code not found. Check it and try again.")
            return {"ok": True, "status": "awaiting_organization_code"}
        org = await db.organizations.find_one({"_id": ObjectId(organization["organization_id"])})
        await db.telegram_subscribers.update_one(
            {"_id": subscriber["_id"]},
            {"$set": {"organization_id": organization["organization_id"], "state": "active", "updated_at": now_utc()}},
        )
        await telegram.send_message(chat_id, f"Done, {subscriber['name']}! You're subscribed to {org.get('name', 'your organization')}. Send voice messages here.")
        return {"ok": True, "status": "active"}

    audio = message.get("voice") or message.get("audio")
    if not audio:
        return {"ok": True, "ignored": True}
    if not subscriber or subscriber.get("state") != "active":
        if subscriber and subscriber.get("state") == "awaiting_name":
            prompt = "Please send your name first."
        elif subscriber and subscriber.get("state") == "awaiting_organization_code":
            prompt = "Please send your organization code first."
        else:
            prompt = "To subscribe, send /start."
        await telegram.send_message(chat_id, prompt)
        return {"ok": True, "ignored": "not_subscribed"}
    if int(audio.get("file_size", 0)) > telegram.MAX_TELEGRAM_AUDIO_BYTES:
        await telegram.send_message(chat_id, "The audio file exceeds the 20 MB limit.")
        return {"ok": True, "rejected": "file_too_large"}
    update_id = update.get("update_id")
    provider_call_id = f"telegram:{update_id}" if update_id is not None else f"telegram:{message.get('message_id')}"
    db = get_db()
    if await db.calls.find_one({"provider_call_id": provider_call_id}):
        return {"ok": True, "duplicate": True}
    attachment_name = audio.get("file_name") or ("telegram-voice.ogg" if "voice" in message else "telegram-audio")
    media_type = audio.get("mime_type") or ("audio/ogg" if "voice" in message else "audio/mpeg")
    call = {"provider_call_id": provider_call_id, "organization_id": subscriber["organization_id"], "caller_phone": chat_id, "contact_name": subscriber["name"], "status": "processing", "source": "telegram", "created_at": now_utc(), "updated_at": now_utc()}
    try:
        inserted = await db.calls.insert_one(call)
    except DuplicateKeyError:
        return {"ok": True, "duplicate": True}
    call["_id"] = inserted.inserted_id
    try:
        audio_bytes, file_path_name = await telegram.download_file(audio["file_id"])
    except Exception as error:
        await db.calls.update_one({"_id": call["_id"]}, {"$set": {"status": "failed", "processing_error": str(error)[:300], "updated_at": now_utc()}})
        await telegram.send_message(chat_id, "Could not download the audio file. Please send it again.")
        return {"ok": True, "failed": "download"}
    filename = attachment_name if "." in attachment_name else file_path_name
    background_tasks.add_task(process_recording, call, "", "", str(audio.get("duration", 0)), audio_bytes, filename, media_type)
    return {"ok": True, "status": "processing"}


@app.post("/api/push/subscribe", status_code=201)
async def push_subscribe(body: WebPushSubscription, user: dict = Depends(current_user)):
    await get_db().push_subscriptions.update_one({"organization_id": user["organization_id"], "subscription.endpoint": body.endpoint}, {"$set": {"organization_id": user["organization_id"], "subscription": body.model_dump(), "created_at": now_utc()}}, upsert=True)
    return {"ok": True}


@app.get("/api/push/public-key")
async def push_public_key():
    return {"public_key": settings.vapid_public_key}


@app.post("/api/demo/seed")
async def seed_demo(user: dict = Depends(current_user)):
    if not settings.demo_mode:
        raise HTTPException(404, "Not found")
    db = get_db()
    org_id = user["organization_id"]
    if await db.messages.count_documents({"organization_id": org_id}):
        return {"seeded": False, "message": "Demo messages have already been added"}
    tags = await db.tags.find({"organization_id": org_id, "archived": {"$ne": True}}).to_list(length=100)
    tag_by_name = {tag["name"]: tag for tag in tags}
    now = now_utc()
    samples = [
        {"contact_name": "Anna Petrova", "caller_phone": "+372 5555 4218", "summary": "No water in the apartment since morning", "transcript": "Hello. I live at 14 Koidu Street, apartment 23. There has been no cold water since this morning. It seems the neighbors are affected too. Could you tell me when it will be fixed?", "tag_name": "Water outage", "tag_origin": "existing", "confidence": .97, "language": "en", "minutes": 12},
        {"contact_name": "Unknown number", "caller_phone": "+372 5555 8706", "summary": "Plumber cannot access the water meter", "transcript": "Good morning. This is apartment 18. The plumber cannot access the water meter in the basement because the door is locked and we do not have a key. Who should we contact?", "tag_name": "Water meter access", "tag_origin": "suggested", "confidence": .78, "language": "en", "minutes": 36},
        {"contact_name": "Michael Sokolov", "caller_phone": "+372 5555 2155", "summary": "The entrance door closer is broken", "transcript": "I wanted to report that the entrance door has not been closing by itself for several days. It looks like the door closer is broken. This is the third entrance.", "tag_name": "Building maintenance", "tag_origin": "existing", "confidence": .93, "language": "en", "minutes": 61},
        {"contact_name": "Elena", "caller_phone": "+372 5555 6490", "summary": "Question about a parking permit", "transcript": "Hello, where can I get a new parking permit? My current one expires at the end of the month.", "tag_name": "Parking question", "tag_origin": "existing", "confidence": .96, "language": "en", "minutes": 900, "status": "done"},
        {"contact_name": "Unknown number", "caller_phone": "+372 5555 0932", "summary": "Loud noise from upstairs neighbors", "transcript": "Good evening. Music has been playing loudly in the apartment above mine for the second evening in a row, past eleven. Could you tell me whom I should contact?", "tag_name": "Neighbor noise", "tag_origin": "existing", "confidence": .74, "language": "en", "minutes": 1200},
    ]
    for index, sample in enumerate(samples):
        tag = tag_by_name.get(sample["tag_name"])
        if sample["tag_origin"] == "suggested" and not tag:
            tag = {"organization_id": org_id, "name": sample["tag_name"], "color": "#ab8bbd", "origin": "ai", "created_at": now}
            result = await db.tags.insert_one(tag)
            tag["_id"] = result.inserted_id
            tag_by_name[tag["name"]] = tag
        created = now.replace() - __import__("datetime").timedelta(minutes=sample["minutes"])
        item = {"organization_id": org_id, "contact_name": sample["contact_name"], "caller_phone": sample["caller_phone"], "summary": sample["summary"], "transcript": sample["transcript"], "tag_id": str(tag["_id"]) if tag else None, "tag_name": sample["tag_name"], "tag_origin": sample["tag_origin"], "confidence": sample["confidence"], "language": sample["language"], "status": sample.get("status", "new"), "duration_seconds": 38 + index * 13, "source": "demo", "created_at": created, "updated_at": created}
        await db.messages.insert_one(item)
    for item in samples[:2]:
        await notify(org_id, "New call message", item["summary"])
    return {"seeded": True, "messages": len(samples)}


@app.post("/webhooks/twilio/voice")
async def twilio_voice(request: Request):
    form = dict(await request.form())
    await validate_twilio(request, form)
    org = await get_db().phone_numbers.find_one({"number": form.get("To")})
    org_id = org["organization_id"] if org else None
    if not org_id and settings.demo_mode:
        default_org = await get_db().organizations.find_one({"phone_number": form.get("To")})
        org_id = str(default_org["_id"]) if default_org else None
    if not org_id:
        return Response("<Response><Say language=\"en-US\">We cannot take your call right now. Please try again later.</Say><Hangup/></Response>", media_type="application/xml")
    call_sid = form.get("CallSid", "")
    caller = form.get("From", "")
    now = now_utc()
    await get_db().calls.update_one({"provider_call_id": call_sid}, {"$setOnInsert": {"organization_id": org_id, "caller_phone": caller, "status": "recording", "source": "twilio", "created_at": now}, "$set": {"updated_at": now}}, upsert=True)
    url = settings.app_base_url.rstrip("/") + "/webhooks/twilio/recording"
    xml = f"""<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Please leave your message after the tone. Your message will be transcribed and sent to the office.</Say><Record maxLength="120" timeout="7" playBeep="true" trim="trim-silence" action="{settings.app_base_url.rstrip('/')}/webhooks/twilio/complete" method="POST" recordingStatusCallback="{url}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/></Response>"""
    return Response(xml, media_type="application/xml")


@app.post("/webhooks/twilio/complete")
async def twilio_complete(request: Request):
    form = dict(await request.form())
    await validate_twilio(request, form)
    call_sid = form.get("CallSid", "")
    await get_db().calls.update_one({"provider_call_id": call_sid, "status": "recording"}, {"$set": {"status": "recorded", "updated_at": now_utc()}})
    return Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>", media_type="application/xml")


@app.post("/api/calls/simulate", status_code=201)
async def simulate_call(
    audio: UploadFile = File(...),
    caller_phone: str = Form(...),
    duration_seconds: float = Form(...),
    user: dict = Depends(current_user),
):
    if not re.fullmatch(r"\+[1-9]\d{7,14}", caller_phone):
        raise HTTPException(422, "Enter the caller's phone number in international format, for example +37255551234")
    if not 0 < duration_seconds <= 120:
        raise HTTPException(422, "Recording duration must be between 1 and 120 seconds")

    media_type = (audio.content_type or "").split(";", 1)[0].lower()
    file_details = {
        "audio/webm": ("simulated-call.webm", "audio/webm"),
        "audio/mp4": ("simulated-call.mp4", "audio/mp4"),
        "audio/mpeg": ("simulated-call.mp3", "audio/mpeg"),
        "audio/wav": ("simulated-call.wav", "audio/wav"),
        "audio/x-wav": ("simulated-call.wav", "audio/wav"),
        "audio/ogg": ("simulated-call.ogg", "audio/ogg"),
    }
    if media_type not in file_details:
        raise HTTPException(415, "Supported audio formats are WebM, MP4, MP3, WAV, and OGG")
    audio_bytes = await audio.read(25 * 1024 * 1024 + 1)
    await audio.close()
    if not audio_bytes:
        raise HTTPException(422, "The audio recording is empty")
    if len(audio_bytes) > 25 * 1024 * 1024:
        raise HTTPException(413, "The recording must not exceed 25 MB")

    now = now_utc()
    call = {
        "provider_call_id": f"SIM{secrets.token_hex(16)}",
        "organization_id": user["organization_id"],
        "caller_phone": caller_phone,
        "status": "processing",
        "source": "simulated",
        "created_at": now,
        "updated_at": now,
    }
    result = await get_db().calls.insert_one(call)
    call["_id"] = result.inserted_id
    filename, content_type = file_details[media_type]
    await process_recording(
        call, "", "", str(int(duration_seconds)),
        audio_bytes=audio_bytes,
        audio_filename=filename,
        audio_content_type=content_type,
    )
    completed_call = await get_db().calls.find_one({"_id": call["_id"]})
    if completed_call.get("status") != "processed":
        raise HTTPException(502, "Could not process the recording. Check your transcription settings and try again.")
    message = await get_db().messages.find_one({"_id": ObjectId(completed_call["message_id"])})
    return serialize(message) | {"id": str(message["_id"])}


@app.post("/webhooks/twilio/recording")
async def twilio_recording(request: Request, background_tasks: BackgroundTasks):
    form = dict(await request.form())
    await validate_twilio(request, form)
    call_sid = form.get("CallSid", "")
    call = await get_db().calls.find_one({"provider_call_id": call_sid})
    if not call:
        return {"ok": True, "ignored": True}
    recording_sid = form.get("RecordingSid", "")
    if call.get("status") in {"processing", "processed"} and (not recording_sid or call.get("recording_sid") == recording_sid):
        return {"ok": True, "duplicate": True}
    claimed = await get_db().calls.update_one({"_id": call["_id"], "status": {"$nin": ["processing", "processed"]}}, {"$set": {"status": "processing", "recording_sid": recording_sid, "updated_at": now_utc()}})
    if not claimed.modified_count:
        return {"ok": True, "duplicate": True}
    background_tasks.add_task(process_recording, call, form.get("RecordingUrl", "") + ".mp3", recording_sid, form.get("RecordingDuration", "0"))
    return {"ok": True, "status": "processing"}


async def process_recording(
    call: dict,
    recording_url: str,
    recording_sid: str,
    recording_duration: str,
    audio_bytes: bytes | None = None,
    audio_filename: str = "",
    audio_content_type: str = "",
):
    db = get_db()
    try:
        organization = await db.organizations.find_one({"_id": oid(call["organization_id"])})
        possible_languages = organization.get("languages", ["ru", "en", "et"]) if organization else ["ru", "en", "et"]
        if audio_bytes is None:
            transcript, language = await transcribe(recording_url, possible_languages)
        else:
            transcript, language = await transcribe_audio(audio_bytes, audio_filename, audio_content_type, possible_languages)
        if not transcript:
            transcript = "Could not transcribe the message. Check your OpenAI connection and try the call again."
        tags = await db.tags.find({"organization_id": call["organization_id"], "archived": {"$ne": True}}).to_list(length=300)
        result = await classify(transcript, tags)
        tag = next((item for item in tags if str(item["_id"]) == result.get("tag_id")), None)
        source = call.get("source", "phone")
        message = {"organization_id": call["organization_id"], "call_id": str(call["_id"]), "contact_name": call.get("contact_name", "Unknown number"), "caller_phone": call["caller_phone"], "summary": result["summary"], "transcript": transcript, "tag_id": result.get("tag_id"), "tag_name": result["tag_name"], "tag_origin": result.get("tag_origin", "existing" if tag else "suggested"), "confidence": result["confidence"], "language": result.get("language") or language or "", "status": "new", "duration_seconds": int(float(recording_duration or 0)), "source": "simulated" if source == "simulated" else source, "created_at": now_utc(), "updated_at": now_utc()}
        inserted = await db.messages.insert_one(message)
        message["_id"] = inserted.inserted_id
        await db.calls.update_one({"_id": call["_id"]}, {"$set": {"status": "processed", "recording_sid": recording_sid, "message_id": str(inserted.inserted_id), "duration_seconds": message["duration_seconds"], "updated_at": now_utc()}})
        await notify(call["organization_id"], "New Telegram message" if source == "telegram" else "New call message", message["summary"], str(inserted.inserted_id))
        await run_actions(message, call)
    except Exception as error:
        logging.exception("Recording processing failed")
        current = await db.calls.find_one({"_id": call["_id"]}, {"message_id": 1})
        if not (current and current.get("message_id")):
            await db.calls.update_one({"_id": call["_id"]}, {"$set": {"status": "failed", "processing_error": str(error)[:300], "updated_at": now_utc()}})
    finally:
        # Keep only the transcript in the application; remove the provider-side media copy too.
        if recording_sid:
            await delete_recording(recording_sid)


@app.get("/api/admin/stats")
async def stats(user: dict = Depends(current_user)):
    db = get_db()
    org = user["organization_id"]
    total = await db.messages.count_documents({"organization_id": org})
    new = await db.messages.count_documents({"organization_id": org, "status": "new"})
    unread = await db.notifications.count_documents({"organization_id": org, "read": False})
    return {"total": total, "new": new, "unread_notifications": unread}

