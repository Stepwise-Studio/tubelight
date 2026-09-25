"""Voice mode on Groq's free tier: Whisper for speech-to-text, Orpheus for expressive text-to-speech."""
import hashlib
import re

import httpx
from fastapi import HTTPException

from . import config

BASE = "https://api.groq.com/openai/v1"
STT_MODEL = "whisper-large-v3-turbo"
TTS_MODEL = "canopylabs/orpheus-v1-english"
VOICES = [v.strip() for v in config.env("TTS_VOICES", "autumn,diana,hannah,austin,daniel,troy").split(",") if v.strip()]

INSTRUCTION = (
    "\n\n[Voice mode: the user is talking to you out loud and will hear your reply spoken. Answer like a person in "
    "conversation: short sentences, no Markdown, no lists, no code. If code or a long answer is needed, say you've "
    "put it in the chat and summarise. You may add a vocal cue in brackets where it's natural, e.g. [cheerful], "
    "[sigh], [laughs], but sparingly.]"
)


def _key() -> str:
    key = config.env("GROQ_API_KEY")
    if not key:
        raise HTTPException(503, "Voice needs a Groq API key in agent-service/.env.")
    return key


def voice_for(teammate_id: str | None) -> str:
    """Each teammate keeps the same voice: a stable pick from the list."""
    if not teammate_id:
        return VOICES[0]
    return VOICES[int(hashlib.sha1(teammate_id.encode()).hexdigest(), 16) % len(VOICES)]


def speakable(text: str) -> str:
    text = re.sub(r"```.*?```", " I've put the code in the chat. ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links and images: keep the label
    text = re.sub(r"^\s*(#+|[-*+]|\d+\.)\s+", "", text, flags=re.M)
    text = re.sub(r"[*_~>|#]", "", text)
    return re.sub(r"\s+", " ", text).strip()[:3000]


def parts(text: str) -> list[str]:
    """Sentence groups to speak one after another: a short first part so playback starts fast, then ~250 chars each."""
    out: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", speakable(text)):
        limit = 120 if len(out) <= 1 else 250
        if out and len(out[-1]) + len(sentence) < limit:
            out[-1] += " " + sentence
        else:
            out.append(sentence)
    return [p for p in out if p.strip()]


async def transcribe(audio: bytes, filename: str) -> str:
    if not audio:
        raise HTTPException(400, "No audio was recorded.")
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{BASE}/audio/transcriptions", headers={"Authorization": f"Bearer {_key()}"},
                         files={"file": (filename, audio)}, data={"model": STT_MODEL, "response_format": "verbose_json"})
    if r.status_code != 200:
        raise HTTPException(502, "Couldn't transcribe that. Try again.")
    return heard(r.json())


# Whisper invents these from silence and room noise.
PHANTOMS = {"thank you", "thanks for watching", "thank you for watching", "you", "bye", "okay", "so", "oh", "hmm", "uh", "um"}


def heard(result: dict) -> str:
    """The words actually spoken: segments Whisper itself flags as probably-not-speech are dropped, then known phantoms."""
    segments = result.get("segments")
    text = " ".join(s.get("text", "") for s in segments if s.get("no_speech_prob", 0) < 0.6) if segments else result.get("text", "")
    text = " ".join(text.split())
    return "" if re.sub(r"[^a-z ]", "", text.lower()).strip() in PHANTOMS else text


async def speak(text: str, teammate_id: str | None) -> bytes:
    words = speakable(text)[:1000]
    if not words:
        raise HTTPException(400, "Nothing to say.")
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{BASE}/audio/speech", headers={"Authorization": f"Bearer {_key()}"},
                         json={"model": TTS_MODEL, "input": words, "voice": voice_for(teammate_id), "response_format": "wav"})
    if r.status_code != 200:
        detail = r.json().get("error", {}) if r.headers.get("content-type", "").startswith("application/json") else {}
        if detail.get("code") == "model_terms_required":
            raise HTTPException(503, "Voice replies need a one-time step: accept the Orpheus terms in the Groq console.")
        raise HTTPException(502, "Couldn't generate the spoken reply.")
    return r.content
