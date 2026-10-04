from datetime import datetime, timezone
import re
from typing import Any, Literal
from pydantic import BaseModel, EmailStr, Field, field_validator


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class RegisterRequest(BaseModel):
    organization_name: str = Field(min_length=2, max_length=120)
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    phone: str = ""


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class OrganizationSettings(BaseModel):
    organization_name: str | None = Field(default=None, min_length=2, max_length=120)
    phone_number: str | None = None
    forwarding_mode: Literal["busy_or_no_answer", "always"] | None = None
    languages: list[Literal["ru", "en", "et"]] | None = None
    auto_reply_min_confidence: float | None = Field(default=None, ge=0, le=1)

    @field_validator("phone_number")
    @classmethod
    def validate_phone_number(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.replace(" ", "").replace("-", "")
        if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized):
            raise ValueError("Введите номер в международном формате, например +37255551234")
        return normalized


class TagCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    color: str = "#75ac8a"


class TagUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    merge_into: str | None = None


class RuleCreate(BaseModel):
    tag_id: str
    channel: Literal["sms", "whatsapp", "telegram", "webhook"]
    message_template: str = Field(min_length=1, max_length=1000)
    enabled: bool = True
    webhook_url: str | None = None

    @field_validator("webhook_url")
    @classmethod
    def validate_webhook(cls, value: str | None) -> str | None:
        if value and not value.startswith("https://"):
            raise ValueError("Webhook URL must use HTTPS")
        return value


class RuleUpdate(BaseModel):
    tag_id: str | None = None
    channel: Literal["sms", "whatsapp", "telegram", "webhook"] | None = None
    message_template: str | None = Field(default=None, min_length=1, max_length=1000)
    enabled: bool | None = None
    webhook_url: str | None = None

    @field_validator("webhook_url")
    @classmethod
    def validate_webhook(cls, value: str | None) -> str | None:
        if value and not value.startswith("https://"):
            raise ValueError("Webhook URL must use HTTPS")
        return value

class MessageUpdate(BaseModel):
    tag_id: str | None = None
    status: Literal["new", "done"] | None = None
    contact_name: str | None = Field(default=None, max_length=120)


class ManualReply(BaseModel):
    channel: Literal["sms", "whatsapp", "telegram"]
    text: str = Field(min_length=1, max_length=1000)


class BulkReply(BaseModel):
    message_ids: list[str] = Field(min_length=1, max_length=100)
    channel: Literal["sms", "whatsapp", "telegram"]
    text: str = Field(min_length=1, max_length=1000)


class NotificationRead(BaseModel):
    read: bool = True


class WebPushSubscription(BaseModel):
    endpoint: str
    keys: dict[str, str]


Json = dict[str, Any]
