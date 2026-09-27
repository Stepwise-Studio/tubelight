"""Live voice: the session token carries the teammate's persona and the one run_task tool."""
from app import live

from .conftest import teammate


async def test_live_session_locks_the_teammate_persona(api, env, monkeypatch):
    fdb, _ = env
    cal = teammate(fdb, "calendy", "scheduler", system_prompt="You schedule meetings.", allowed_toolkits=["GOOGLECALENDAR"])
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    minted = {}

    async def fake_mint(setup):
        minted.update(setup)
        return "auth_tokens/abc"

    monkeypatch.setattr(live, "mint", fake_mint)
    r = await api.post("/voice/live", json={"thread_id": f"dm:{cal['id']}"})
    assert r.status_code == 200, r.text
    assert r.json()["token"] == "auth_tokens/abc"
    system = minted["systemInstruction"]["parts"][0]["text"]
    assert "You are Calendy" in system and "You schedule meetings." in system and "run_task" in system
    assert [f["name"] for f in minted["tools"][0]["functionDeclarations"]] == ["switch_to_text", "run_task"]
    assert minted["generationConfig"]["responseModalities"] == ["AUDIO"]


async def test_voice_transcript_lands_in_the_chat(api, env):
    fdb, _ = env
    cal = teammate(fdb, "calendy", "scheduler")
    r = await api.post("/voice/transcript", json={"thread_id": f"dm:{cal['id']}", "turns": [
        {"role": "user", "text": "hey, am I free at 7?"}, {"role": "teammate", "text": "Yes, your evening is clear."}, {"role": "user", "text": " "}]})
    assert r.status_code == 200
    rows = fdb.rows("messages")
    assert [(m["sender_type"], m["text"]) for m in rows] == [("user", "hey, am I free at 7?"), ("teammate", "Yes, your evening is clear.")]
    assert rows[1]["teammate_id"] == cal["id"] and rows[1]["meta"] == {"voice": True}


async def test_voice_task_message_is_flagged_hidden(api, env):
    fdb, fake = env
    from .conftest import ai
    cal = teammate(fdb, "calendy", "scheduler")
    fake.script = [ai("Your evening is clear.")]
    r = await api.post(f"/threads/dm:{cal['id']}/messages", json={"text": "Check my calendar for tonight", "voice_task": True})
    assert r.status_code == 200
    assert fdb.rows("messages", sender_type="user")[0]["meta"] == {"voice_task": True}


async def test_dictation_token_is_transcription_only(api, env, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    minted = {}

    async def fake_mint(setup):
        minted.update(setup)
        return "auth_tokens/d"

    monkeypatch.setattr(live, "mint", fake_mint)
    r = await api.post("/voice/dictate")
    assert r.json()["token"] == "auth_tokens/d"
    assert minted == {"model": "models/gemini-3.5-transcribe-live", "inputAudioTranscription": {}}
