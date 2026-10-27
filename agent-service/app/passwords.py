"""Saved sign-ins for Tubelight's browser: so a teammate can sign the user back in when a site logs them out, without
the password ever reaching a model, a chat, a log or memory.

- Saved only by the user: they sign in themselves on the Sign in screen (or Take over in the live view), and the app
  asks "Save it to Tubelight?". The browser kept what they typed in that tab's memory for 10 minutes (`captured`).
- Kept encrypted (Fernet) in the store; the key is a file on the server's own disk, never in the database, so a copy
  of the database alone reads nothing.
- Filled by the server straight into the page (browser.fill_login), only when the tab is on that very site; the
  teammate gets "signed in" or what went wrong. Each fill asks the user first (an approval card), once per site for
  GRANT_S; runs they set up to work alone (automations, follow-ups) don't ask, like browsing itself.
"""
import os
import time
from datetime import UTC, datetime

from cryptography.fernet import Fernet

from . import config

KEY = config.WORKSPACES.parent / "secrets" / "passwords.key"
GRANT_S = 20 * 60
_fernet: list[Fernet] = []
_ok: dict[tuple[str, str], float] = {}  # (owner, site) -> until: a fill they approved covers the next steps of that sign-in


def _f() -> Fernet:
    if not _fernet:
        if not KEY.exists():
            KEY.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(Fernet.generate_key())
        _fernet.append(Fernet(KEY.read_bytes().strip()))
    return _fernet[0]


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("passwords", owner_id)


async def save(owner_id: str, site: str, username: str, secret: str) -> None:
    from . import memory
    await memory.store.aput(_ns(owner_id), site, {
        "site": site, "username": username, "secret": _f().encrypt(secret.encode()).decode(),
        "saved_at": datetime.now(UTC).isoformat(), "used_at": ""}, index=False)


async def sites(owner_id: str) -> list[dict]:
    """What's saved, never the passwords: site, username, when saved, when last used."""
    from . import memory
    items = await memory.store.asearch(_ns(owner_id), limit=500)
    return sorted(({k: v for k, v in i.value.items() if k != "secret"} for i in items), key=lambda r: r["site"])


async def get(owner_id: str, site: str) -> tuple[str, str] | None:
    from . import memory
    item = await memory.store.aget(_ns(owner_id), site)
    if not item:
        return None
    await memory.store.aput(_ns(owner_id), site, {**item.value, "used_at": datetime.now(UTC).isoformat()}, index=False)
    return item.value["username"], _f().decrypt(item.value["secret"].encode()).decode()


async def forget(owner_id: str, site: str) -> None:
    from . import memory
    await memory.store.adelete(_ns(owner_id), site)
    _ok.pop((owner_id, site), None)


def allow(owner_id: str, site: str) -> None:
    _ok[(owner_id, site)] = time.time() + GRANT_S


def allowed(owner_id: str, site: str) -> bool:
    return _ok.get((owner_id, site), 0) > time.time()
