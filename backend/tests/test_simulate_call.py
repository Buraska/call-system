import json
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest
from bson import ObjectId
import pytest_asyncio


from app import main
from app.services import notify as dispatch_notifications


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        self.rows.sort(key=lambda row: row.get(key), reverse=direction < 0)
        return self

    def limit(self, count):
        self.rows = self.rows[:count]
        return self

    async def to_list(self, length=None):
        return deepcopy(self.rows[:length] if length is not None else self.rows)

class Collection:
    def __init__(self):
        self.rows = []

    async def insert_one(self, row):
        stored = deepcopy(row)
        stored.setdefault("_id", ObjectId())
        self.rows.append(stored)
        return SimpleNamespace(inserted_id=stored["_id"])

    async def find_one(self, query, projection=None):
        return deepcopy(next((row for row in self.rows if matches(row, query)), None))

    def find(self, query):
        return Cursor([row for row in self.rows if matches(row, query)])

    async def update_one(self, query, update, upsert=False):
        row = next((item for item in self.rows if matches(item, query)), None)
        if row is None:
            if not upsert:
                return SimpleNamespace(matched_count=0, modified_count=0)
            row = {key: value for key, value in query.items() if not isinstance(value, dict)}
            row.update(deepcopy(update.get("$setOnInsert", {})))
            row.update(deepcopy(update.get("$set", {})))
            row.setdefault("_id", ObjectId())
            self.rows.append(row)
            return SimpleNamespace(matched_count=0, modified_count=0, upserted_id=row["_id"])
        row.update(deepcopy(update.get("$set", {})))
        for key in update.get("$unset", {}):
            row.pop(key, None)
        return SimpleNamespace(matched_count=1, modified_count=1)


def matches(row, query):
    for key, expected in query.items():
        actual = row.get(key)
        if isinstance(expected, dict):
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$exists" in expected and (key in row) != expected["$exists"]:
                return False
        elif actual != expected:
            return False
    return True


class Database:
    def __init__(self):
        for name in ("calls", "messages", "tags", "action_rules", "action_runs", "notifications", "users", "organizations", "telegram_subscribers", "telegram_organization_codes", "assistant_chats"):
            setattr(self, name, Collection())




async def classify(transcript, tags):
    return {"summary": "No water", "tag_id": str(tags[0]["_id"]), "tag_name": "Water", "tag_origin": "existing", "confidence": 0.95, "language": "en"}


async def notify(*args, **kwargs):
    return None


async def send_message(channel, to, text):
    return {"status": "sent", "provider_id": "mock-provider"}


@pytest_asyncio.fixture
async def harness(monkeypatch):
    from app import security, services

    db = Database()
    db.transcription_languages = []
    async def mock_transcribe_audio(content, filename, content_type, possible_languages=None):
        assert content == b"recording"
        db.transcription_languages.append(possible_languages)
        return "There is no water in my apartment", "en"
    monkeypatch.setattr(main, "get_db", lambda: db)
    monkeypatch.setattr(services, "get_db", lambda: db)
    monkeypatch.setattr(security, "get_db", lambda: db)
    monkeypatch.setattr(main, "transcribe_audio", mock_transcribe_audio)
    monkeypatch.setattr(main, "classify", classify)
    monkeypatch.setattr(main, "notify", notify)
    monkeypatch.setattr(services, "notify", notify)
    monkeypatch.setattr(services, "send_message", send_message)
    organization_id = str(ObjectId())
    await db.organizations.insert_one({"_id": ObjectId(organization_id), "name": "Test organization"})
    tag_id = str(ObjectId())
    await db.tags.insert_one({"_id": ObjectId(tag_id), "organization_id": organization_id, "name": "Water", "archived": False})
    await db.action_rules.insert_one({"_id": ObjectId(), "organization_id": organization_id, "tag_id": tag_id, "enabled": True, "min_confidence": 0.8, "channel": "sms", "message_template": "We received your report"})
    user = {"_id": ObjectId(), "organization_id": organization_id, "role": "admin"}
    await db.users.insert_one(user)
    token = main.create_access_token(user)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")
    yield db, client, token, organization_id, tag_id
    await client.aclose()


@pytest.mark.asyncio
async def test_simulated_upload_processes_call_and_dispatches_eligible_action(harness):
    db, client, token, _, _ = harness
    response = await client.post("/api/calls/simulate", headers={"Authorization": f"Bearer {token}"}, data={"caller_phone": "+37255551234", "duration_seconds": "32"}, files={"audio": ("call.webm", b"recording", "audio/webm")})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["caller_phone"] == "+37255551234"
    assert body["transcript"] == "There is no water in my apartment"
    assert body["summary"] == "No water"
    assert body["source"] == "simulated"
    assert body["duration_seconds"] == 32
    call = db.calls.rows[0]
    assert call["status"] == "processed"
    assert call["message_id"] == body["id"]
    assert len(db.messages.rows) == 1
    assert db.action_runs.rows[0]["status"] == "sent"
    assert db.messages.rows[0]["auto_reply"]["text"] == "We received your report"


@pytest.mark.asyncio
async def test_saved_possible_languages_are_used_for_transcription(harness):
    db, client, token, _, _ = harness
    headers = {"Authorization": f"Bearer {token}"}
    settings_response = await client.patch("/api/organization", headers=headers, json={"languages": ["et"]})
    assert settings_response.status_code == 200
    assert settings_response.json()["languages"] == ["et"]

    response = await client.post("/api/calls/simulate", headers=headers, data={"caller_phone": "+37255551234", "duration_seconds": "32"}, files={"audio": ("call.webm", b"recording", "audio/webm")})
    assert response.status_code == 201, response.text
    assert db.transcription_languages == [["et"]]

@pytest.mark.asyncio
async def test_simulated_upload_requires_authentication(harness):
    _, client, *_ = harness
    response = await client.post("/api/calls/simulate", data={"caller_phone": "+37255551234", "duration_seconds": "32"}, files={"audio": ("call.webm", b"recording", "audio/webm")})
    assert response.status_code == 401


@pytest.mark.parametrize(("phone", "duration", "mime", "payload", "status"), [
    ("5551234", "30", "audio/webm", b"recording", 422),
    ("+37255551234", "0", "audio/webm", b"recording", 422),
    ("+37255551234", "121", "audio/webm", b"recording", 422),
    ("+37255551234", "30", "text/plain", b"recording", 415),
    ("+37255551234", "30", "audio/webm", b"", 422),
])
@pytest.mark.asyncio
async def test_simulated_upload_rejects_invalid_inputs(harness, phone, duration, mime, payload, status):
    _, client, token, *_ = harness
    response = await client.post("/api/calls/simulate", headers={"Authorization": f"Bearer {token}"}, data={"caller_phone": phone, "duration_seconds": duration}, files={"audio": ("call.bin", payload, mime)})
    assert response.status_code == status


@pytest.mark.asyncio
async def test_organization_confidence_threshold_gates_every_action(harness):
    db, client, token, organization_id, tag_id = harness
    db.action_rules.rows[0]["min_confidence"] = 0.8
    await db.action_rules.insert_one({"organization_id": organization_id, "tag_id": tag_id, "enabled": True, "min_confidence": 0.1, "channel": "telegram", "message_template": "A second action"})
    response = await client.patch("/api/organization", headers={"Authorization": f"Bearer {token}"}, json={"auto_reply_min_confidence": 0.99})
    assert response.status_code == 200
    assert response.json()["auto_reply_min_confidence"] == 0.99

    response = await client.post("/api/calls/simulate", headers={"Authorization": f"Bearer {token}"}, data={"caller_phone": "+37255551234", "duration_seconds": "32"}, files={"audio": ("call.webm", b"recording", "audio/webm")})

    assert response.status_code == 201
    assert db.action_runs.rows == []
    assert "auto_reply" not in db.messages.rows[0]


@pytest.mark.asyncio
async def test_global_confidence_threshold_includes_exact_boundary(harness):
    _, client, token, _, _ = harness
    response = await client.patch("/api/organization", headers={"Authorization": f"Bearer {token}"}, json={"auto_reply_min_confidence": 0.95})
    assert response.status_code == 200

    response = await client.post("/api/calls/simulate", headers={"Authorization": f"Bearer {token}"}, data={"caller_phone": "+37255551234", "duration_seconds": "32"}, files={"audio": ("call.webm", b"recording", "audio/webm")})

    assert response.status_code == 201
    assert response.json()["auto_reply"]["text"] == "We received your report"

@pytest.mark.asyncio
async def test_telegram_audio_webhook_processes_audio_and_deduplicates(harness, monkeypatch):
    db, client, _, organization_id, _ = harness
    from app.config import settings

    await db.telegram_subscribers.insert_one({"chat_id": "777", "name": "Alex", "organization_id": organization_id, "state": "active"})
    monkeypatch.setattr(settings, "telegram_bot_token", "test-token")
    monkeypatch.setattr(settings, "telegram_webhook_secret", "test-secret")
    downloaded = []

    async def download_file(file_id):
        downloaded.append(file_id)
        return b"recording", "voice.ogg"

    async def send_message(chat_id, text):
        return {"status": "sent", "provider_id": "telegram-message"}

    monkeypatch.setattr(main.telegram, "download_file", download_file)
    monkeypatch.setattr(main.telegram, "send_message", send_message)
    update = {
        "update_id": 1234,
        "message": {
            "message_id": 8,
            "chat": {"id": 777, "type": "private"},
            "from": {"first_name": "Alex"},
            "voice": {"file_id": "telegram-file", "duration": 14, "mime_type": "audio/ogg"},
        },
    }
    headers = {"X-Telegram-Bot-Api-Secret-Token": "test-secret"}
    first = await client.post("/webhooks/telegram", headers=headers, json=update)
    duplicate = await client.post("/webhooks/telegram", headers=headers, json=update)

    assert first.status_code == 200
    assert first.json()["status"] == "processing"
    assert duplicate.json()["duplicate"] is True
    assert downloaded == ["telegram-file"]
    assert db.messages.rows[0]["source"] == "telegram"
    assert db.messages.rows[0]["contact_name"] == "Alex"
    assert db.messages.rows[0]["duration_seconds"] == 14
    assert db.calls.rows[0]["status"] == "processed"


@pytest.mark.asyncio
async def test_telegram_webhook_rejects_invalid_secret(harness, monkeypatch):
    _, client, *_ = harness
    from app.config import settings

    monkeypatch.setattr(settings, "telegram_bot_token", "test-token")
    monkeypatch.setattr(settings, "telegram_webhook_secret", "test-secret")
    response = await client.post("/webhooks/telegram", headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"}, json={})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_telegram_start_link_prefills_organization_code_and_keeps_manual_flow(harness, monkeypatch):
    db, client, token, organization_id, _ = harness
    from app.config import settings

    monkeypatch.setattr(settings, "telegram_bot_token", "test-token")
    monkeypatch.setattr(settings, "telegram_bot_username", "test_bot")
    monkeypatch.setattr(settings, "telegram_webhook_secret", "test-secret")
    sent = []

    async def send_message(chat_id, text):
        sent.append((str(chat_id), text))
        return {"status": "sent", "provider_id": "telegram-message"}

    monkeypatch.setattr(main.telegram, "send_message", send_message)
    headers = {"X-Telegram-Bot-Api-Secret-Token": "test-secret"}
    app_headers = {"Authorization": f"Bearer {token}"}
    code_response = await client.post("/api/telegram/organization-code", headers=app_headers)
    assert code_response.status_code == 200
    organization_code = code_response.json()["code"]
    assert code_response.json()["bot_url"] == f"https://t.me/test_bot?start={organization_code}"
    stored_code = db.telegram_organization_codes.rows[0]["code_hash"]
    assert stored_code != organization_code

    async def send_text(update_id, text, chat_id=777):
        return await client.post(
            "/webhooks/telegram",
            headers=headers,
            json={"update_id": update_id, "message": {"text": text, "chat": {"id": chat_id, "type": "private"}}},
        )

    started = await send_text(1, f"/start {organization_code}")
    named = await send_text(2, "Mila")
    assert started.json()["status"] == "awaiting_name"
    assert named.json()["status"] == "active"
    linked_subscriber = next(row for row in db.telegram_subscribers.rows if row["chat_id"] == "777")
    assert linked_subscriber["name"] == "Mila"
    assert linked_subscriber["organization_id"] == organization_id
    assert linked_subscriber["state"] == "active"
    assert "pending_organization_code_hash" not in linked_subscriber

    manual_started = await send_text(3, "/start", chat_id=778)
    manual_named = await send_text(4, "Noah", chat_id=778)
    manual_subscribed = await send_text(5, organization_code, chat_id=778)
    assert manual_started.json()["status"] == "awaiting_name"
    assert manual_named.json()["status"] == "awaiting_organization_code"
    assert manual_subscribed.json()["status"] == "active"
    manual_subscriber = next(row for row in db.telegram_subscribers.rows if row["chat_id"] == "778")
    assert manual_subscriber["name"] == "Noah"
    assert manual_subscriber["organization_id"] == organization_id
    assert "telegram_chat_id" not in db.users.rows[0]
    assert len(sent) == 5

@pytest.mark.asyncio
async def test_telegram_notifications_only_target_active_subscribers_in_the_organization(harness, monkeypatch):
    db, _, _, organization_id, _ = harness
    from app import services

    monkeypatch.setattr(services, "get_db", lambda: db)
    await db.telegram_subscribers.insert_one({"chat_id": "111", "name": "Linked", "organization_id": organization_id, "state": "active"})
    await db.telegram_subscribers.insert_one({"chat_id": "222", "name": "Other", "organization_id": str(ObjectId()), "state": "active"})
    await db.telegram_subscribers.insert_one({"chat_id": "333", "name": "Pending", "organization_id": organization_id, "state": "awaiting_name"})
    sent = []

    async def send_message(chat_id, text):
        sent.append((str(chat_id), text))
        return {"status": "sent", "provider_id": "telegram-message"}

    monkeypatch.setattr(services.telegram, "send_message", send_message)
    await dispatch_notifications(organization_id, "New request", "Water leak", "message-1")

    assert sent == [("111", "New request\nWater leak")]
    assert db.notifications.rows[0]["message_id"] == "message-1"


def assistant_tool_call(name, arguments, call_id):
    call = SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))
    call.model_dump = lambda exclude_none=True: {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }
    return call


def assistant_response(content=None, tool_calls=None):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls))])


def mock_assistant_model(monkeypatch, responses, captured):
    from app import assistant

    async def create(**kwargs):
        captured.append(kwargs)
        return responses.pop(0)

    class Client:
        def __init__(self, api_key):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))

    monkeypatch.setattr(assistant, "AsyncOpenAI", Client)
    return assistant


@pytest.mark.asyncio
async def test_assistant_automatically_updates_message_sends_reply_and_creates_context_rule(harness, monkeypatch):
    db, client, token, organization_id, tag_id = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(settings, "openai_agent_model", "gpt-6-luna")
    message_id = ObjectId()
    await db.messages.insert_one({
        "_id": message_id, "organization_id": organization_id, "caller_phone": "+37255550001",
        "summary": "Water leak", "transcript": "There is a leak", "tag_id": tag_id,
        "tag_name": "Water", "status": "new", "created_at": main.now_utc(),
    })
    sent = []

    async def send_message(channel, to, text):
        sent.append((channel, to, text))
        return {"status": "sent", "provider_id": "assistant-reply"}

    monkeypatch.setattr(assistant, "send_message", send_message)
    captured = []
    mock_assistant_model(monkeypatch, [
        assistant_response(tool_calls=[
            assistant_tool_call("update_message", {"status": "done", "tag_id": None, "contact_name": None}, "call-1"),
            assistant_tool_call("send_reply", {"channel": "sms", "text": "We received your report."}, "call-2"),
            assistant_tool_call("create_rule", {"channel": "sms", "message_template": "Received: {{summary}}", "enabled": True, "webhook_url": None}, "call-3"),
        ]),
        assistant_response("Updated the message, sent the reply, and created the rule."),
    ], captured)

    created = await client.post("/api/assistant/chats", headers={"Authorization": f"Bearer {token}"}, json={})
    response = await client.post(
        f"/api/assistant/chats/{created.json()['id']}/messages",
        headers={"Authorization": f"Bearer {token}"},
        json={"content": "Mark this as processed, reply, and make a rule.", "context_message_id": str(message_id)},
    )

    assert response.status_code == 200, response.text
    stored_message = await db.messages.find_one({"_id": message_id})
    assert stored_message["status"] == "done"
    assert stored_message["last_reply"]["text"] == "We received your report."
    assert sent == [("sms", "+37255550001", "We received your report.")]
    assert len(db.action_runs.rows) == 1
    created_rule = next(rule for rule in db.action_rules.rows if rule["message_template"] == "Received: {{summary}}")
    assert created_rule["organization_id"] == organization_id
    assert created_rule["tag_id"] == tag_id
    assistant_message = response.json()["messages"][-1]
    assert [action["status"] for action in assistant_message["actions"]] == ["completed", "sent", "completed"]
    assert captured[0]["model"] == "gpt-6-luna"
    assert captured[0]["reasoning_effort"] == "none"
    assert captured[0]["max_completion_tokens"] == 500


@pytest.mark.asyncio
async def test_assistant_history_is_private_and_context_does_not_cross_selected_messages(harness, monkeypatch):
    db, client, token, organization_id, tag_id = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    selected_a, selected_b = ObjectId(), ObjectId()
    for message_id, transcript in ((selected_a, "Private transcript A"), (selected_b, "Private transcript B")):
        await db.messages.insert_one({
            "_id": message_id, "organization_id": organization_id, "caller_phone": "+37255550002",
            "summary": transcript, "transcript": transcript, "tag_id": tag_id,
            "tag_name": "Water", "status": "new", "created_at": main.now_utc(),
        })
    captured = []
    mock_assistant_model(monkeypatch, [assistant_response("First"), assistant_response("Second")], captured)
    headers = {"Authorization": f"Bearer {token}"}
    created = await client.post("/api/assistant/chats", headers=headers, json={})
    chat_id = created.json()["id"]
    first = await client.post(f"/api/assistant/chats/{chat_id}/messages", headers=headers, json={"content": "Remember this from A", "context_message_id": str(selected_a)})
    second = await client.post(f"/api/assistant/chats/{chat_id}/messages", headers=headers, json={"content": "Summarize this message", "context_message_id": str(selected_b)})
    assert first.status_code == second.status_code == 200
    second_prompt = json.dumps(captured[1]["messages"], ensure_ascii=False)
    assert "Private transcript B" in second_prompt
    assert "Private transcript A" not in second_prompt
    assert "Remember this from A" not in second_prompt

    other_user = {"_id": ObjectId(), "organization_id": organization_id, "role": "admin"}
    await db.users.insert_one(other_user)
    other_token = main.create_access_token(other_user)
    other_headers = {"Authorization": f"Bearer {other_token}"}
    assert (await client.get("/api/assistant/chats", headers=other_headers)).json() == []
    assert (await client.get(f"/api/assistant/chats/{chat_id}", headers=other_headers)).status_code == 404


@pytest.mark.asyncio
async def test_assistant_voice_upload_rejects_unsupported_and_empty_audio(harness, monkeypatch):
    db, client, token, *_ = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")

    async def should_not_transcribe(*args, **kwargs):
        pytest.fail("invalid audio must be rejected before provider use")

    monkeypatch.setattr(assistant, "transcribe_audio", should_not_transcribe)
    headers = {"Authorization": f"Bearer {token}"}
    unsupported = await client.post("/api/assistant/transcribe", headers=headers, files={"audio": ("note.txt", b"not audio", "text/plain")})
    empty = await client.post("/api/assistant/transcribe", headers=headers, files={"audio": ("note.webm", b"", "audio/webm")})
    unauthenticated = await client.post("/api/assistant/transcribe", files={"audio": ("note.webm", b"audio", "audio/webm")})

    assert unsupported.status_code == 415
    assert empty.status_code == 422
    assert unauthenticated.status_code == 401


@pytest.mark.asyncio
async def test_assistant_accepts_suggested_category_before_creating_its_rule(harness, monkeypatch):
    db, client, token, organization_id, _ = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    suggested_id = ObjectId()
    await db.messages.insert_one({
        "_id": suggested_id, "organization_id": organization_id, "caller_phone": "+37255550003",
        "summary": "Broken entry door", "transcript": "The front door is broken",
        "tag_id": None, "tag_name": "Entry door", "tag_origin": "suggested", "status": "new",
        "created_at": main.now_utc(),
    })
    captured = []
    mock_assistant_model(monkeypatch, [
        assistant_response(tool_calls=[
            assistant_tool_call("accept_suggested_tag", {}, "accept-tag"),
            assistant_tool_call("create_rule", {"channel": "sms", "message_template": "We received: {{summary}}", "enabled": True, "webhook_url": None}, "create-rule"),
        ]),
        assistant_response("Accepted the category and created its rule."),
    ], captured)
    headers = {"Authorization": f"Bearer {token}"}
    created = await client.post("/api/assistant/chats", headers=headers, json={})
    response = await client.post(
        f"/api/assistant/chats/{created.json()['id']}/messages",
        headers=headers,
        json={"content": "Accept this category and create an SMS rule.", "context_message_id": str(suggested_id)},
    )

    assert response.status_code == 200, response.text
    saved_message = await db.messages.find_one({"_id": suggested_id})
    assert saved_message["tag_id"]
    assert saved_message["tag_origin"] == "existing"
    assert any(rule["tag_id"] == saved_message["tag_id"] and rule["message_template"] == "We received: {{summary}}" for rule in db.action_rules.rows)
    assert [action["status"] for action in response.json()["messages"][-1]["actions"]] == ["completed", "completed"]


@pytest.mark.asyncio
async def test_assistant_cannot_change_another_category_or_organization(harness, monkeypatch):
    db, client, token, organization_id, tag_id = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    selected_id = ObjectId()
    await db.messages.insert_one({
        "_id": selected_id, "organization_id": organization_id, "caller_phone": "+37255550004",
        "summary": "Water leak", "transcript": "Water leak", "tag_id": tag_id,
        "tag_name": "Water", "tag_origin": "existing", "status": "new", "created_at": main.now_utc(),
    })
    other_tag_id = ObjectId()
    await db.tags.insert_one({"_id": other_tag_id, "organization_id": organization_id, "name": "Repairs", "archived": False})
    foreign_tag_id, foreign_org_id = ObjectId(), str(ObjectId())
    await db.tags.insert_one({"_id": foreign_tag_id, "organization_id": foreign_org_id, "name": "Private", "archived": False})
    other_rule_id = ObjectId()
    await db.action_rules.insert_one({
        "_id": other_rule_id, "organization_id": organization_id, "tag_id": str(other_tag_id),
        "channel": "sms", "message_template": "Existing rule", "enabled": True,
    })
    captured = []
    mock_assistant_model(monkeypatch, [
        assistant_response(tool_calls=[
            assistant_tool_call("update_message", {"status": None, "tag_id": str(foreign_tag_id), "contact_name": None}, "foreign-tag"),
            assistant_tool_call("update_rule", {"rule_id": str(other_rule_id), "channel": None, "message_template": None, "enabled": False, "webhook_url": None}, "other-category-rule"),
        ]),
        assistant_response("Those actions were rejected because they are outside this message's context."),
    ], captured)
    headers = {"Authorization": f"Bearer {token}"}
    created = await client.post("/api/assistant/chats", headers=headers, json={})
    response = await client.post(
        f"/api/assistant/chats/{created.json()['id']}/messages",
        headers=headers,
        json={"content": "Try to change the selected category and unrelated rule.", "context_message_id": str(selected_id)},
    )

    assert response.status_code == 200, response.text
    selected = await db.messages.find_one({"_id": selected_id})
    other_rule = await db.action_rules.find_one({"_id": other_rule_id})
    assert selected["tag_id"] == tag_id
    assert other_rule["enabled"] is True
    assert [action["status"] for action in response.json()["messages"][-1]["actions"]] == ["failed", "failed"]


@pytest.mark.asyncio
async def test_assistant_voice_transcription_uses_organization_languages(harness, monkeypatch):
    db, client, token, _, _ = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    db.organizations.rows[0]["languages"] = ["et"]
    transcriptions = []

    async def transcribe_audio(payload, filename, content_type, possible_languages):
        transcriptions.append((payload, filename, content_type, possible_languages))
        return "Vee lekib", "et"

    monkeypatch.setattr(assistant, "transcribe_audio", transcribe_audio)
    response = await client.post(
        "/api/assistant/transcribe",
        headers={"Authorization": f"Bearer {token}"},
        files={"audio": ("voice.webm", b"actual-recording-bytes", "audio/webm;codecs=opus")},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"text": "Vee lekib", "language": "et"}
    assert transcriptions == [(b"actual-recording-bytes", "voice.webm", "audio/webm", ["et"])]


@pytest.mark.asyncio
async def test_assistant_provider_error_does_not_fall_back_to_another_model(harness, monkeypatch):
    db, client, token, *_ = harness
    from app import assistant
    from app.config import settings

    monkeypatch.setattr(assistant, "get_db", lambda: db)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(settings, "openai_agent_model", "gpt-6-luna")
    requested_models = []

    async def fail_request(**kwargs):
        requested_models.append(kwargs["model"])
        raise RuntimeError("model unavailable")

    class Client:
        def __init__(self, api_key):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=fail_request))

    monkeypatch.setattr(assistant, "AsyncOpenAI", Client)
    headers = {"Authorization": f"Bearer {token}"}
    created = await client.post("/api/assistant/chats", headers=headers, json={})
    response = await client.post(
        f"/api/assistant/chats/{created.json()['id']}/messages",
        headers=headers,
        json={"content": "Hello", "context_message_id": None},
    )

    assert response.status_code == 502
    assert requested_models == ["gpt-6-luna"]
@pytest.mark.asyncio
async def test_rule_edit_updates_owned_tag_and_rejects_foreign_tag(harness):
    db, client, token, organization_id, _ = harness
    headers = {"Authorization": f"Bearer {token}"}
    rule_id = str(db.action_rules.rows[0]["_id"])
    tag_id = str(ObjectId())
    await db.tags.insert_one({
        "_id": ObjectId(tag_id),
        "organization_id": organization_id,
        "name": "Repairs",
        "archived": False,
    })

    response = await client.patch(
        f"/api/rules/{rule_id}",
        headers=headers,
        json={
            "tag_id": tag_id,
            "channel": "webhook",
            "message_template": "Call update: {{summary}}",
            "webhook_url": "https://example.ee/calls",
            "enabled": False,
        },
    )

    assert response.status_code == 200
    assert response.json()["tag_id"] == tag_id
    assert response.json()["tag_name"] == "Repairs"
    assert response.json()["channel"] == "webhook"
    assert response.json()["message_template"] == "Call update: {{summary}}"
    assert response.json()["webhook_url"] == "https://example.ee/calls"
    assert response.json()["enabled"] is False

    foreign_tag_id = str(ObjectId())
    await db.tags.insert_one({
        "_id": ObjectId(foreign_tag_id),
        "organization_id": str(ObjectId()),
        "name": "Private",
        "archived": False,
    })
    response = await client.patch(
        f"/api/rules/{rule_id}",
        headers=headers,
        json={"tag_id": foreign_tag_id},
    )

    assert response.status_code == 404
    saved_rule = await db.action_rules.find_one({"_id": ObjectId(rule_id)})
    assert saved_rule["tag_id"] == tag_id
