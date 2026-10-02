"""Your own computers as a place teammates can work (the runner: agent-service/runner/tubelight-runner.py).

Pairing: the app asks for a one-time code (10 minutes) and shows the command to run on the computer, which trades
the code for a device token. The runner then long-polls /runner/poll (it dials out through the public URL, so the
computer opens no ports) and answers jobs one by one.

The computer decides what it allows, never the app: the folders it shares for Cowork (`allow <folder>` on the
machine) and whether it can run sandboxes (Docker there). It reports both on every poll. Cowork commands run under
bubblewrap with the disk read-only and home hidden except the shared folders; writes and commands need the user's
approval like any action. Where builders' sandboxes run is the user's choice (`code_on`): the home server, the
computer, or auto (the server, the computer when the server can't).

ponytail: jobs and online state live in this process (one service process); a second would need a shared queue.
"""
import asyncio
import base64
import hashlib
import io
import logging
import re
import secrets
import shlex
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from . import config, memory

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
FILES = {  # what the runner downloads: itself, and what it needs to build sandboxes like the server's
    "tubelight-runner.py": ROOT / "runner" / "tubelight-runner.py",
    "sandbox.Dockerfile": ROOT / "sandbox" / "Dockerfile",
    "squid.conf": ROOT / "deploy" / "squid.conf",
}
POLL_S = 25
ONLINE_S = POLL_S + 20
CODE_TTL = 600

_codes: dict[str, tuple[str, float]] = {}  # code -> (owner, expires)
_queues: dict[str, asyncio.Queue] = {}  # computer id -> jobs
_waiting: dict[str, tuple[str, asyncio.Future]] = {}  # job id -> (computer, result)
_seen: dict[str, dict[str, Any]] = {}  # computer id -> {at, folders, docker, version, os}


def _ns(owner_id: str) -> tuple[str, ...]:
    return ("computers", owner_id)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _q(cid: str) -> asyncio.Queue:
    return _queues.setdefault(cid, asyncio.Queue())


# ------------------------------------------------------------------ pairing and listing
def pair_code(owner_id: str) -> dict[str, Any]:
    now = time.time()
    for k, (_, exp) in list(_codes.items()):
        if exp < now:
            _codes.pop(k, None)
    code = "-".join("".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(4)) for _ in range(2))
    _codes[code] = (owner_id, now + CODE_TTL)
    url = config.PUBLIC_URL
    return {
        "code": code, "expires_in": CODE_TTL,
        "command": f"curl -fsSL {url}/runner/tubelight-runner.py -o ~/tubelight-runner.py && "
                   f"python3 ~/tubelight-runner.py pair {code} {url}",
    }


async def claim(code: str, name: str, os_name: str) -> dict[str, str]:
    owner_exp = _codes.pop(code.strip().upper(), None)
    if not owner_exp or owner_exp[1] < time.time():
        raise PermissionError("That code is wrong or expired. Get a new one in the app (Profile → Computers).")
    owner_id = owner_exp[0]
    cid, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
    row = {"id": cid, "name": name[:60] or "Computer", "os": os_name[:40], "token": _hash(token),
           "created_at": time.time()}
    await memory.store.aput(_ns(owner_id), cid, row, index=False)
    await memory.store.aput(("computer_tokens",), _hash(token), {"owner": owner_id, "id": cid}, index=False)
    return {"id": cid, "token": token}


async def by_token(token: str) -> tuple[str, str] | None:
    item = await memory.store.aget(("computer_tokens",), _hash(token))
    return (item.value["owner"], item.value["id"]) if item else None


def _public(row: dict[str, Any]) -> dict[str, Any]:
    seen = _seen.get(row["id"]) or {}
    online = time.time() - seen.get("at", 0) < ONLINE_S
    return {"id": row["id"], "name": row["name"], "os": seen.get("os") or row.get("os"), "online": online,
            "last_seen": seen.get("at"), "folders": seen.get("folders") or [], "docker": bool(seen.get("docker")),
            "shell": bool(seen.get("shell")), "version": seen.get("version")}


async def listing(owner_id: str) -> list[dict[str, Any]]:
    rows = await memory.store.asearch(_ns(owner_id), limit=20)
    return [_public(r.value) for r in rows]


async def remove(owner_id: str, cid: str) -> None:
    item = await memory.store.aget(_ns(owner_id), cid)
    if item:
        await memory.store.adelete(("computer_tokens",), item.value["token"])
        await memory.store.adelete(_ns(owner_id), cid)
    _seen.pop(cid, None)
    q = _queues.pop(cid, None)
    while q and not q.empty():
        job = q.get_nowait()
        _, fut = _waiting.pop(job["id"], (None, None))
        if fut and not fut.done():
            fut.set_exception(RuntimeError("That computer was removed."))


async def prefs(owner_id: str) -> dict[str, Any]:
    item = await memory.store.aget(("prefs", owner_id), "computer")
    p = item.value if item else {}
    return {"code_on": p.get("code_on", "auto"), "cowork": bool(p.get("cowork", True))}


async def set_prefs(owner_id: str, code_on: str | None = None, cowork: bool | None = None) -> dict[str, Any]:
    p = await prefs(owner_id)
    if code_on in ("server", "computer", "auto"):
        p["code_on"] = code_on
    if cowork is not None:
        p["cowork"] = cowork
    await memory.store.aput(("prefs", owner_id), "computer", p, index=False)
    return p


async def for_run(owner_id: str) -> dict[str, Any] | None:
    """The computer teammates can use in this run (the most recently seen online one), with the user's choices."""
    try:
        online = [c for c in await listing(owner_id) if c["online"]]
    except Exception as e:
        log.warning("computers unavailable: %s", e)
        return None
    if not online:
        return None
    return {**max(online, key=lambda c: c["last_seen"] or 0), **await prefs(owner_id)}


# ------------------------------------------------------------------ the runner's side
async def poll(cid: str, info: dict[str, Any]) -> dict[str, Any] | None:
    _seen[cid] = {"at": time.time(), "folders": [str(f) for f in info.get("folders") or []][:20],
                  "docker": bool(info.get("docker")), "shell": bool(info.get("shell")),
                  "version": str(info.get("version") or "")[:20], "os": str(info.get("os") or "")[:40]}
    try:
        return await asyncio.wait_for(_q(cid).get(), POLL_S)
    except TimeoutError:
        return None


def result(cid: str, job_id: str, ok: bool, out: Any) -> None:
    owner, fut = _waiting.get(job_id, (None, None))
    if owner != cid:  # only the computer the job went to can answer it
        return
    _waiting.pop(job_id, None)
    if fut and not fut.done():
        fut.set_result(out) if ok else fut.set_exception(RuntimeError(str(out)[:2000]))


async def call(cid: str, op: str, args: dict[str, Any], timeout_s: float = 150) -> Any:
    """Run one job on the computer and wait for its answer."""
    if time.time() - (_seen.get(cid) or {}).get("at", 0) > ONLINE_S:
        raise RuntimeError("The computer is offline (the Tubelight runner isn't running there).")
    job = {"id": str(uuid.uuid4()), "op": op, "args": args}
    fut = asyncio.get_running_loop().create_future()
    _waiting[job["id"]] = (cid, fut)
    await _q(cid).put(job)
    try:
        return await asyncio.wait_for(fut, timeout_s)
    except TimeoutError:
        raise RuntimeError("The computer didn't answer in time.") from None
    finally:
        _waiting.pop(job["id"], None)


# ------------------------------------------------------------------ a builder's sandbox on the computer
GIT_PUSH = re.compile(r"\bgit\b[^;&|]*\bpush\b")


class Box:
    """Same surface as sandbox.Sandbox, run in Docker on the user's computer (the runner mirrors the server's
    lockdown: its own internal network whose only exit is a proxy that refuses private addresses)."""

    def __init__(self, cid: str, run_id: str, teammate_id: str, repo_url: str | None, owner_id: str):
        self.cid, self.repo_url, self.owner_id = cid, repo_url, owner_id
        self.key = f"{run_id[:8]}-{teammate_id[:8]}"
        self.started = False

    async def _ready(self) -> None:
        if self.started:
            return
        from . import repo

        tar_b64 = ""
        target = repo.parse(self.repo_url)
        if target:
            with tempfile.TemporaryDirectory() as d:
                try:
                    info = await repo.repo_info(self.owner_id, *target)
                    await repo.download(self.owner_id, target[0], target[1], info.get("default_branch") or "main", Path(d))
                    buf = io.BytesIO()
                    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
                        tar.add(d, arcname=".")
                    tar_b64 = base64.b64encode(buf.getvalue()).decode()
                except Exception as e:
                    log.warning("computer sandbox repo download failed: %s", e)
        await call(self.cid, "box_start", {"key": self.key, "tar": tar_b64}, 900)
        self.started = True

    async def run_shell(self, cmd: str, timeout_s: int = 120) -> str:
        if GIT_PUSH.search(cmd):
            return "git push is blocked in run_shell. Use the git_push tool, which asks the user for approval."
        await self._ready()
        t = max(1, min(timeout_s, 600))
        return await call(self.cid, "box_exec", {"key": self.key, "cmd": cmd, "timeout": t}, t + 30)

    async def read_file(self, path: str) -> str:
        await self._ready()
        return await call(self.cid, "box_read", {"key": self.key, "path": path})

    async def write_file(self, path: str, content: str) -> str:
        await self._ready()
        return await call(self.cid, "box_write", {"key": self.key, "path": path, "content": content})

    async def git_push(self, branch: str) -> str:
        await self._ready()
        auth = ""
        if config.GITHUB_TOKEN:
            basic = base64.b64encode(f"x-access-token:{config.GITHUB_TOKEN}".encode()).decode()
            auth = f"-c http.extraheader={shlex.quote('AUTHORIZATION: basic ' + basic)} "
        return await call(self.cid, "box_exec", {"key": self.key, "cmd": f"git {auth}push origin HEAD:{shlex.quote(branch)}",
                                                 "timeout": 120}, 150)

    async def close(self) -> str:
        if not self.started:
            return ""
        try:
            return await call(self.cid, "box_close", {"key": self.key}, 60)
        except Exception as e:
            log.warning("computer sandbox close failed: %s", e)
            return ""
