from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from pymongo import ASCENDING, DESCENDING, AsyncMongoClient

from .config import settings

client: AsyncMongoClient | None = None
db = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global client, db
    client = AsyncMongoClient(settings.mongodb_url)
    db = client[settings.mongodb_database]
    await db.users.create_index("email", unique=True)
    await db.telegram_subscribers.create_index("chat_id", unique=True)
    await db.telegram_subscribers.create_index([("organization_id", ASCENDING), ("state", ASCENDING)])
    await db.telegram_organization_codes.create_index("organization_id", unique=True)
    await db.telegram_organization_codes.create_index("code_hash", unique=True)
    old_indexes = await db.users.index_information()
    if "telegram_chat_id_1" in old_indexes:
        await db.users.drop_index("telegram_chat_id_1")
    previous_links = await db.users.find({"telegram_chat_id": {"$exists": True}}).to_list(length=None)
    for linked_user in previous_links:
        await db.telegram_subscribers.update_one(
            {"chat_id": str(linked_user["telegram_chat_id"])},
            {"$setOnInsert": {"chat_id": str(linked_user["telegram_chat_id"]), "name": linked_user.get("name", "Telegram"), "organization_id": linked_user["organization_id"], "state": "active", "created_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        await db.users.update_one(
            {"_id": linked_user["_id"]},
            {"$unset": {"telegram_chat_id": "", "telegram_username": "", "telegram_pairing_code": "", "telegram_pairing_expires_at": ""}},
        )
    await db.action_rules.update_many({"min_confidence": {"$exists": True}}, {"$unset": {"min_confidence": ""}})
    await db.messages.create_index([("organization_id", ASCENDING), ("created_at", DESCENDING)])
    await db.calls.create_index("provider_call_id", unique=True, sparse=True)
    await db.notifications.create_index([("organization_id", ASCENDING), ("created_at", DESCENDING)])
    await db.assistant_chats.create_index([("user_id", ASCENDING), ("organization_id", ASCENDING), ("updated_at", DESCENDING)])
    await db.phone_numbers.create_index("organization_id", unique=True)
    await db.phone_numbers.create_index("number", unique=True)
    yield
    await client.close()


def get_db():
    if db is None:
        raise RuntimeError("Database is not connected")
    return db
