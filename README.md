# Kontuur MVP

An app for handling calls forwarded when an employee is busy or unavailable. The phone provider records a voicemail; the server receives it, creates a transcript, selects an existing tag or suggests a new one, and runs only a preconfigured action.

## MVP features

- Registration and sign-in; one organization per account, with organization-level data isolation.
- Incoming calls through the Twilio Voice webhook and voice recordings up to 120 seconds.
- OpenAI Whisper transcription in Russian, English, and Estonian. Audio is held in backend memory, sent for transcription, and not stored in MongoDB.
- OpenAI classification using existing tags. If no tag fits, the model suggests one; suggestions do not create rules or trigger automatic replies. Staff can approve a suggestion to add it to the tag list.
- Summaries, search, filters, manual tag changes, and processing status.
- Automatic tag actions send replies only through Telegram; all rules share a confidence threshold and retain an attempt log.
- Manual and bulk Telegram replies are available only for messages received through Telegram. Phone-network calls remain inbound records.
- Notifications, periodic updates in an open tab, and Web Push when VAPID is configured.
- Installable PWA on supported devices.
- On mobile screens, sections are available through the menu button; the panel closes after a section is selected.
- The app interface is English-only. Speech transcription supports Russian, English, and Estonian.

## Quick start in demo mode

Requirements: Python 3.12, Node.js 20+, and Docker.

Python 3.12 is recommended because the pinned `pydantic-core` has a compatible wheel; Python 3.14 may attempt a source build that requires Visual C++ Build Tools.

1. Start MongoDB from the project root:

   ```powershell
   docker compose up -d mongo
   ```

2. Set up the backend:

   ```powershell
   cd backend
   py -3.12 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   Copy-Item .env.example .env
   uvicorn app.main:app --reload --port 8000
   ```

3. In another terminal, from the project root, install and start the frontend:

   ```powershell
   npm install
   npm run dev
   ```

4. Open <http://localhost:3000> and create an account. Demo mode adds sample records; replies to phone calls are not sent. Backend OpenAPI documentation is at <http://localhost:8000/docs>.

To test without placing a real phone call, open Settings → General and select Record a test call. This tests recording processing but does not send an automatic reply. To test replies, send a voice message through the Telegram bot; an enabled rule may send a message to the original Telegram chat.

The inbox initially opens the Unanswered tab, followed by All. Select all selects the messages shown in the current list. Add action opens the action settings; the selected tag is filled in automatically. The confidence threshold shared by all rules is configured in Settings → General.

## Tests

Frontend user-flow tests:

```powershell
npm test
```

Backend tests (activate the backend virtual environment using Python 3.12 first):

```powershell
cd backend
pip install -r requirements-dev.txt
pytest
```

## Telephony and transcription setup

Set the following values in `backend/.env`:

```dotenv
DEMO_MODE=false
JWT_SECRET=<long random secret>
APP_BASE_URL=https://api.example.ee
FRONTEND_ORIGIN=https://app.example.ee
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
OPENAI_API_KEY=...
```

An administrator can configure Whisper transcription hints in Settings → General → Whisper transcription languages. The selected languages are passed as context; Whisper still detects the language automatically. Leave the list empty for automatic detection without a hint.

Configure each Twilio number to use the Voice webhook `https://api.example.ee/webhooks/twilio/voice` with the POST method. Make the backend callbacks publicly accessible over HTTPS. Assign a separate inbound number to each organization in Phone and notifications; a number cannot be routed to multiple organizations.

Users forward their number to the service number when busy or unanswered. USSD codes vary between Telia, Elisa, and Tele2, so the app provides a general checklist rather than promising a universal code. Check number and call-forwarding availability for the specific carrier plan.

## Telegram

- The Telegram bot accepts private voice and audio messages, sends the audio to the backend for transcription, and processes the message using the usual rules. Files are not stored; the limit is 20 MB. Subscribers can use an invitation link: after `/start`, the bot asks for their name and automatically links them to the organization. Telegram users do not need an app account. Using `/start` without a link still allows manual code entry.
- An administrator creates an invitation link in Settings → General using Create Telegram subscription link and sends it to subscribers. The link passes the code to the bot automatically. A code can be reused; creating a new code deactivates old links for new subscriptions. Existing subscribers remain active.
- Replies to Telegram messages are sent to the original chat. All Telegram subscribers with an active code for the organization receive its notifications.

Create a bot with `@BotFather` and set these values in the backend `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_BOT_USERNAME=<bot username without @>
TELEGRAM_WEBHOOK_SECRET=<random string of 1–256 characters from a-z, A-Z, 0-9, _ or ->
OPENAI_API_KEY=<OpenAI transcription key>
```

Configure the Telegram webhook at `https://api.example.ee/webhooks/telegram`, passing `TELEGRAM_WEBHOOK_SECRET` as the `secret_token` parameter to the Bot API `setWebhook` method. The backend must be publicly available to Telegram over HTTPS with a valid certificate. Restart the backend after changing `.env`.

Audio is downloaded from Telegram to the backend through the Bot API and held only in temporary memory. The transcript and message are saved to the organization selected by the invitation link or manually entered code.

## Reply delivery

- Telegram is the only outbound messaging channel. Automatic rules and manual replies are sent to the original Telegram chat for the message.
- Replies are available only for messages received through Telegram. Phone calls are accepted and processed, but cannot be replied to through Telegram.
- On backend startup, legacy SMS, WhatsApp, and webhook rules are converted to disabled Telegram rules. Review their text and enable the rules you need manually.
- An automatic reply is sent only when an enabled tag rule exists and classification confidence meets the organization's threshold.

## Push notifications

For push notifications when the app is closed, generate VAPID keys with `npx web-push generate-vapid-keys` and add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_CLAIMS_EMAIL` to the backend `.env`. Push requires HTTPS (except on localhost). Users then enable notifications in the app. Without VAPID, the notification list and updates in an open tab remain available.

## Main MongoDB collections

`organizations`, `users`, `phone_numbers`, `calls`, `messages`, `tags`, `action_rules`, `action_runs`, `notifications`, `push_subscriptions`.

Messages store transcripts and metadata, not audio. For production, configure MongoDB access controls and backups, rate limits for registration and authentication, JWT secret rotation, recording-size limits, external API spending limits, and transcript retention.

## Current MVP limitations

- Real Twilio, OpenAI, Telegram, and VAPID credentials are required for telephony, transcription, outbound Telegram messages, and push notifications.
- Audio recordings are transferred between Twilio and OpenAI. Before piloting in Estonia, review caller disclosures, the legal basis for processing, and data processing agreements.
- The caller greeting is currently in English; localize it before launch if needed.
