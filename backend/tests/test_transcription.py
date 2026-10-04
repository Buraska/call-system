from types import SimpleNamespace

import pytest

from app import services


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("possible_languages", "expected_prompt"),
    [
        ([], None),
        (["ru", "et"], "The audio may be spoken in Russian, Estonian."),
    ],
)
async def test_transcribe_audio_passes_possible_languages_as_prompt(monkeypatch, possible_languages, expected_prompt):
    captured = {}

    class Transcriptions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(text=" привет ", language="ru")

    class Client:
        def __init__(self, api_key):
            self.audio = SimpleNamespace(transcriptions=Transcriptions())

    monkeypatch.setattr(services, "AsyncOpenAI", Client)
    monkeypatch.setattr(services.settings, "openai_api_key", "test-key")

    result = await services.transcribe_audio(b"audio", "call.mp3", "audio/mpeg", possible_languages)

    assert result == ("привет", "ru")
    assert captured.get("prompt") == expected_prompt
    assert "language" not in captured
