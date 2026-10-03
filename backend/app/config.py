from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_url: str = "mongodb://localhost:27017"
    mongodb_database: str = "kontuur"
    jwt_secret: str = "local-development-secret-change-this"
    access_token_minutes: int = 10080
    app_base_url: str = "http://localhost:8000"
    frontend_origin: str = "http://localhost:3000"
    demo_mode: bool = True
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_phone_number: str = ""
    openai_api_key: str = ""
    openai_transcription_model: str = "whisper-1"
    openai_classification_model: str = "gpt-4o-mini"
    auto_reply_min_confidence: float = 0.85
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_claims_email: str = "admin@example.com"


settings = Settings()
