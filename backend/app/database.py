from contextlib import asynccontextmanager

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
    await db.messages.create_index([("organization_id", ASCENDING), ("created_at", DESCENDING)])
    await db.calls.create_index("provider_call_id", unique=True, sparse=True)
    await db.notifications.create_index([("organization_id", ASCENDING), ("created_at", DESCENDING)])
    await db.phone_numbers.create_index("organization_id", unique=True)
    await db.phone_numbers.create_index("number", unique=True)
    yield
    await client.close()


def get_db():
    if db is None:
        raise RuntimeError("Database is not connected")
    return db
