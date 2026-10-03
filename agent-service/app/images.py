"""Image generation for teammates on Cloudflare Workers AI (free daily neurons). The user picks the model in Profile;
if it fails or stalls, FLUX.1 schnell makes the picture instead. Stored like an attachment, shown under the reply."""
import base64

import httpx

from . import config, files, memory, usage

# Neurons per 1024x1024 image, from Cloudflare's pricing (Oct 2026):
# FLUX.1 schnell 4.8/512 tile + 9.6/step (4 tiles, 8 steps); FLUX.2 klein 4B 26.05/output 512 tile (4 tiles);
# Lucid Origin 636/512 tile + 12/step (4 tiles, 20 steps).
MODELS = {
    "flux-1-schnell": {"name": "FLUX.1 schnell", "model": "@cf/black-forest-labs/flux-1-schnell", "neurons": 96,
                       "about": "Fastest, most images a day"},
    "flux-2-klein-4b": {"name": "FLUX.2 klein", "model": "@cf/black-forest-labs/flux-2-klein-4b", "neurons": 104,
                        "about": "Newer FLUX: better text and prompt following"},
    "lucid-origin": {"name": "Leonardo Lucid Origin", "model": "@cf/leonardo/lucid-origin", "neurons": 2784,
                     "about": "Most photo-real, only a few a day"},
}
DEFAULT = "flux-1-schnell"
FALLBACK = "flux-1-schnell"


def available() -> bool:
    return bool(config.env("CF_ACCOUNT_ID") and config.env("CF_API_TOKEN"))


async def choice(owner_id: str) -> str:
    item = await memory.store.aget(("prefs", owner_id), "images")
    m = (item.value if item else {}).get("model")
    return m if m in MODELS else DEFAULT


async def set_choice(owner_id: str, model: str) -> str:
    if model not in MODELS:
        raise ValueError("Unknown image model.")
    await memory.store.aput(("prefs", owner_id), "images", {"model": model}, index=False)
    return model


async def _run(key: str, prompt: str) -> bytes:
    url = f"https://api.cloudflare.com/client/v4/accounts/{config.env('CF_ACCOUNT_ID')}/ai/run/{MODELS[key]['model']}"
    auth = {"Authorization": f"Bearer {config.env('CF_API_TOKEN')}"}
    async with httpx.AsyncClient(timeout=60) as c:
        if key == "flux-2-klein-4b":  # FLUX.2 takes a multipart form
            r = await c.post(url, headers=auth, files={"prompt": (None, prompt), "width": (None, "1024"), "height": (None, "1024")})
        elif key == "lucid-origin":
            r = await c.post(url, headers=auth, json={"prompt": prompt, "width": 1024, "height": 1024, "num_steps": 20})
        else:
            r = await c.post(url, headers=auth, json={"prompt": prompt, "steps": 8})
    image = (r.json().get("result") or {}).get("image") if r.status_code == 200 else None
    if not image:
        raise RuntimeError(f"The image service said no ({r.status_code}): {r.text[:200]}")
    usage.record("cloudflare", key, 200, r.headers)
    return base64.b64decode(image)


async def generate(owner_id: str, prompt: str) -> dict:
    key, prompt = await choice(owner_id), prompt[:2000]
    try:
        data = await _run(key, prompt)
    except Exception:
        if key == FALLBACK:
            raise
        key, data = FALLBACK, await _run(FALLBACK, prompt)
    return {**await files.upload(owner_id, "image.jpg", data), "width": 1024, "height": 1024, "model": MODELS[key]["name"]}
