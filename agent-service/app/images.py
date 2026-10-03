"""Image generation for teammates: FLUX.1 schnell on Cloudflare Workers AI (free daily allowance, ~2 s an image).
The picture is stored like an attachment and shows in the teammate's reply."""
import base64

import httpx

from . import config, files, usage

MODEL = "@cf/black-forest-labs/flux-1-schnell"
# Cloudflare bills 4.8 neurons per 512x512 tile and 9.6 per step: a 1024x1024 image at 8 steps is 4*4.8 + 8*9.6.
NEURONS = 96


def available() -> bool:
    return bool(config.env("CF_ACCOUNT_ID") and config.env("CF_API_TOKEN"))


async def generate(owner_id: str, prompt: str) -> dict:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"https://api.cloudflare.com/client/v4/accounts/{config.env('CF_ACCOUNT_ID')}/ai/run/{MODEL}",
                         headers={"Authorization": f"Bearer {config.env('CF_API_TOKEN')}"},
                         json={"prompt": prompt[:2000], "steps": 8})
    if r.status_code != 200 or not (r.json().get("result") or {}).get("image"):
        raise RuntimeError(f"The image service said no ({r.status_code}): {r.text[:200]}")
    usage.record("cloudflare", "flux-1-schnell", 200, r.headers)
    data = base64.b64decode(r.json()["result"]["image"])
    return {**await files.upload(owner_id, "image.jpg", data), "width": 1024, "height": 1024}
