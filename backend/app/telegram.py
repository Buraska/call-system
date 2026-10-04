import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)
TELEGRAM_API = "https://api.telegram.org"
MAX_TELEGRAM_AUDIO_BYTES = 20 * 1024 * 1024


def configured() -> bool:
    return bool(settings.telegram_bot_token)


async def call_api(method: str, payload: dict | None = None) -> dict:
    if not configured():
        raise RuntimeError("Telegram bot is not configured")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(f"{TELEGRAM_API}/bot{settings.telegram_bot_token}/{method}", json=payload or {})
        response.raise_for_status()
        result = response.json()
    if not result.get("ok"):
        raise RuntimeError(result.get("description", "Telegram API request failed"))
    return result["result"]


async def send_message(chat_id: str | int, text: str) -> dict:
    try:
        result = await call_api("sendMessage", {"chat_id": chat_id, "text": text[:4096]})
        return {"status": "sent", "provider_id": str(result["message_id"])}
    except Exception as error:
        logger.exception("Telegram message send failed")
        return {"status": "failed", "detail": str(error)[:300]}


async def download_file(file_id: str) -> tuple[bytes, str]:
    metadata = await call_api("getFile", {"file_id": file_id})
    if int(metadata.get("file_size", 0)) > MAX_TELEGRAM_AUDIO_BYTES:
        raise ValueError("Telegram audio exceeds the 20 MB download limit")
    file_path = metadata.get("file_path")
    if not file_path:
        raise ValueError("Telegram did not return an audio file path")
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(f"{TELEGRAM_API}/file/bot{settings.telegram_bot_token}/{file_path}")
        response.raise_for_status()
        content = response.content
    if not content or len(content) > MAX_TELEGRAM_AUDIO_BYTES:
        raise ValueError("Telegram audio is empty or exceeds the 20 MB download limit")
    return content, file_path.rsplit("/", 1)[-1]
