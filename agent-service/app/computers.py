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
    "qrcodegen.py": ROOT / "runner" / "qrcodegen.py",
    "tubelight_window.py": ROOT / "runner" / "tubelight_window.py",
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
    return await _create(owner_exp[0], name, os_name)


# QR linking (the desktop app): the computer asks for a request and shows it as a QR; the phone scans it and claims
# it for its account; the computer then shows that account's email and the person confirms there. Both sides agree,
# so a photo of someone's screen links nothing: the computer would show a stranger's email.
_requests: dict[str, dict[str, Any]] = {}
_events: dict[str, asyncio.Event] = {}


def _bump(rid: str) -> None:
    _events.setdefault(rid, asyncio.Event()).set()


def hello(name: str, os_name: str) -> dict[str, Any]:
    now = time.time()
    for k, r in list(_requests.items()):
        if r["exp"] < now - 60:
            _requests.pop(k, None)
            _events.pop(k, None)
    rid = secrets.token_urlsafe(18)
    _requests[rid] = {"name": name[:60] or "Computer", "os": os_name[:40], "exp": now + CODE_TTL, "state": "waiting"}
    return {"request": rid, "expires_in": CODE_TTL, "link": f"tubelight://link?r={rid}"}


def _live(rid: str) -> dict[str, Any]:
    r = _requests.get(rid)
    if not r or (r["exp"] < time.time() and r["state"] != "linked"):
        raise LookupError("This code expired. A new one is on the computer.")
    return r


def request_info(rid: str, owner_id: str | None = None) -> dict[str, Any]:
    r = _live(rid)
    mine = r.get("owner") in (None, owner_id)
    return {"name": r["name"], "os": r["os"], "state": r["state"] if mine else "taken", "id": r.get("id") if mine else None,
            "teammate_id": r.get("teammate_id") if mine else None}


def scan(rid: str, owner_id: str, email: str) -> dict[str, Any]:
    r = _live(rid)
    if r["state"] != "waiting" and r.get("owner") != owner_id:
        raise PermissionError("Someone else already scanned this code.")
    if r["state"] == "waiting":
        r.update(state="scanned", owner=owner_id, email=email or "your account")
        _bump(rid)
    return request_info(rid, owner_id)


async def link_status(rid: str, wait_s: float = 20) -> dict[str, Any]:
    """The computer waits here for its code to be scanned (long poll)."""
    try:
        r = _live(rid)
    except LookupError:
        return {"state": "expired"}
    if r["state"] == "waiting":
        ev = _events.setdefault(rid, asyncio.Event())
        ev.clear()
        try:
            await asyncio.wait_for(ev.wait(), wait_s)
        except TimeoutError:
            pass
    r = _requests.get(rid) or {"state": "expired"}
    return {"state": r["state"], **({"email": r["email"]} if r.get("email") else {})}


async def confirm(rid: str, approve: bool) -> dict[str, Any]:
    r = _live(rid)
    if r["state"] != "scanned":
        raise PermissionError("Scan the code with your phone first.")
    if not approve:
        r.update(state="waiting", owner=None, email=None)  # back to the QR, for the right phone
        _bump(rid)
        return {"state": "waiting"}
    made = await _create(r["owner"], r["name"], r["os"])
    r.update(state="linked", id=made["id"], teammate_id=(await row(r["owner"], made["id"]) or {}).get("teammate_id"))
    _bump(rid)
    return {"state": "linked", **made}


OPERATOR = """You are {name}, {owner}'s own {os} computer, talking with them from their phone. Through your tools you
have full access to this computer as {owner}'s user account: any file, any folder, any command (the shell is bash; ~ is
their home folder).

How you work:
- Look before you act: list folders and read files to find things, check what's installed, then do the task.
- Do the whole job in as few commands as you can (each command or file change waits for their OK unless they turned
  that off), and say in one line what each one does before you run it.
- Never delete, overwrite or move anything you didn't create without saying exactly what will be lost. No sudo: if a
  task needs it, tell them the command to run themselves.
- Report what actually happened from the command output. If something failed, say so and what you'd try next.
- Keep replies short: they read them on a phone."""


async def _teammate(owner_id: str, cid: str, name: str, os_name: str) -> str:
    """The computer's own chat: a teammate whose avatar_shape `device:<id>` ties it to this computer."""
    from . import db

    taken = {t["handle"] for t in await db.select("teammates", {"owner_id": f"eq.{owner_id}", "select": "handle"})}
    base = re.sub(r"[^a-z0-9_-]", "", name.lower().replace(" ", "-"))[:20] or "computer"
    handle = next(h for h in [base, *(f"{base[:18]}-{i}" for i in range(2, 99))] if h not in taken)
    profile = await db.one("profiles", {"id": f"eq.{owner_id}"})
    owner = (profile or {}).get("display_name") or "the user"
    row = await db.insert("teammates", {
        "owner_id": owner_id, "name": name, "handle": handle, "role": "Your computer",
        "bio": f"Your {os_name or 'computer'}, linked with Tubelight. Ask it to find files, run commands or set things up there.",
        "system_prompt": OPERATOR.format(name=name, owner=owner, os=os_name or ""), "model": config.DEFAULT_MODEL,
        "allowed_toolkits": [], "avatar_shape": f"device:{cid}", "color": "#64748b",
    })
    return row["id"]


def device_of(tm: dict[str, Any]) -> str | None:
    """The computer a teammate stands for (its own chat), if it is one."""
    shape = tm.get("avatar_shape") or ""
    return shape.removeprefix("device:") if shape.startswith("device:") else None


async def row(owner_id: str, cid: str) -> dict[str, Any] | None:
    item = await memory.store.aget(_ns(owner_id), cid)
    return item.value if item else None


async def set_ask(owner_id: str, cid: str, ask: bool) -> None:
    r = await row(owner_id, cid)
    if r:
        await memory.store.aput(_ns(owner_id), cid, {**r, "ask": ask}, index=False)


async def _create(owner_id: str, name: str, os_name: str) -> dict[str, str]:
    cid, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
    name = name[:60] or "Computer"
    row = {"id": cid, "name": name, "os": os_name[:40], "token": _hash(token), "created_at": time.time(),
           "teammate_id": await _teammate(owner_id, cid, name, os_name[:40])}
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
            "shell": bool(seen.get("shell")), "full": bool(seen.get("full")), "version": seen.get("version"),
            "teammate_id": row.get("teammate_id"), "ask": row.get("ask", True), "stats": seen.get("stats") or {}}


async def listing(owner_id: str) -> list[dict[str, Any]]:
    rows = [r.value for r in await memory.store.asearch(_ns(owner_id), limit=20)]
    for r in rows:
        if not r.get("teammate_id"):  # linked before computers had their own chat
            r["teammate_id"] = await _teammate(owner_id, r["id"], r["name"], r.get("os") or "")
            await memory.store.aput(_ns(owner_id), r["id"], r, index=False)
    return [_public(r) for r in rows]


async def remove(owner_id: str, cid: str) -> None:
    item = await memory.store.aget(_ns(owner_id), cid)
    if item:
        await memory.store.adelete(("computer_tokens",), item.value["token"])
        await memory.store.adelete(_ns(owner_id), cid)
        if item.value.get("teammate_id"):  # its chat goes with it
            from . import db
            await db.delete("teammates", {"id": f"eq.{item.value['teammate_id']}", "owner_id": f"eq.{owner_id}"})
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


# ------------------------------------------------------------------ admin (sudo) passwords
# Typed on an approval card, kept here (memory only) until that approved command runs, then handed to the computer
# with the job and forgotten. ponytail: one process; keyed by owner + exact command, 2 minutes.
_passwords: dict[tuple[str, str], tuple[str, float]] = {}


def stash_password(owner_id: str, cmd: str, secret: str) -> None:
    now = time.time()
    for k, (_, exp) in list(_passwords.items()):
        if exp < now:
            _passwords.pop(k, None)
    _passwords[(owner_id, cmd)] = (secret, now + 120)


def take_password(owner_id: str, cmd: str) -> str | None:
    secret, exp = _passwords.pop((owner_id, cmd), (None, 0.0))
    return secret if exp >= time.time() else None


# ------------------------------------------------------------------ the runner's side
async def poll(cid: str, info: dict[str, Any]) -> dict[str, Any] | None:
    _seen[cid] = {"at": time.time(), "folders": [str(f) for f in info.get("folders") or []][:20],
                  "docker": bool(info.get("docker")), "shell": bool(info.get("shell")), "full": bool(info.get("full")),
                  "stats": {k: v for k, v in (info.get("stats") or {}).items() if k in ("disk", "mem", "load", "battery", "charging")},
                  "version": str(info.get("version") or "")[:20], "os": str(info.get("os") or "")[:40]}
    wait = max(0.0, min(float(info.get("wait", POLL_S)), POLL_S))  # 0 on the runner's first poll: online at once
    try:
        return await asyncio.wait_for(_q(cid).get(), wait) if wait else _q(cid).get_nowait()
    except asyncio.QueueEmpty:
        return None
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
    seen = _seen.get(cid) or {}
    if time.time() - seen.get("at", 0) > ONLINE_S:
        raise RuntimeError("The computer is offline (the Tubelight runner isn't running there).")
    version = int(seen.get("version") or 0) if str(seen.get("version") or "0").isdigit() else 0
    needs = [(args.get("full"), 3, "full access from its chat"), (args.get("sudo"), 4, "admin commands"),
             (op in ("fs_get", "fs_put"), 6, "sending files"), (op == "job_start", 7, "long jobs"),
             (op == "live", 9, "live app usage")]
    missing = next((what for wanted, v, what in needs if wanted and version < v), None)
    if missing:  # it updates itself within 6 hours; restarting Tubelight on it updates it now
        raise RuntimeError(f"Tubelight on this computer is too old for {missing}. It updates itself within a few hours; "
                           "to update now, open Tubelight on the computer (or restart it).")
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


# ------------------------------------------------------------------ the desktop app (.deb, built here)
def _ar(members: list[tuple[str, bytes]]) -> bytes:
    out = [b"!<arch>\n"]
    for name, data in members:
        out.append(f"{name:<16}{int(time.time()):<12}0     0     100644  {len(data):<10}`\n".encode())
        out.append(data + (b"\n" if len(data) % 2 else b""))
    return b"".join(out)


def _tgz(files: dict[str, tuple[bytes, int]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        dirs = sorted({str(Path(p).parents[i]) for p in files for i in range(len(Path(p).parts) - 1)} - {"."})
        for d in dirs:
            info = tarfile.TarInfo(f"./{d}")
            info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, int(time.time())
            tar.addfile(info)
        for path, (data, mode) in files.items():
            info = tarfile.TarInfo(f"./{path}")
            info.size, info.mode, info.mtime = len(data), mode, int(time.time())
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def desktop_deb() -> tuple[str, bytes]:
    """Tubelight for desktop (Ubuntu/Debian): the runner, its window (GTK 4) and a user service, linked to this
    server. Built on request so the address inside is always this one."""
    runner = ROOT / "runner"
    version = f"1.0.{int(max(p.stat().st_mtime for p in runner.iterdir() if p.is_file()))}"
    opt = "opt/tubelight"
    data = {
        f"{opt}/tubelight-runner.py": ((runner / "tubelight-runner.py").read_bytes(), 0o755),
        f"{opt}/qrcodegen.py": ((runner / "qrcodegen.py").read_bytes(), 0o644),
        f"{opt}/tubelight_window.py": ((runner / "tubelight_window.py").read_bytes(), 0o644),
        f"{opt}/server.txt": (config.PUBLIC_URL.encode(), 0o644),
        "usr/share/icons/hicolor/256x256/apps/tubelight.png": ((runner / "tubelight.png").read_bytes(), 0o644),
        "usr/share/applications/studio.stepwise.Tubelight.desktop": ((
            "[Desktop Entry]\nType=Application\nName=Tubelight\nComment=Let your teammates work on this computer\n"
            f"Exec=/usr/bin/python3 /{opt}/tubelight-runner.py app\nIcon=tubelight\nTerminal=false\n"
            "Categories=Utility;Network;\nStartupWMClass=studio.stepwise.Tubelight\n").encode(), 0o644),
        "usr/lib/systemd/user/tubelight-runner.service": ((
            "[Unit]\nDescription=Tubelight runner\nAfter=network-online.target\n\n[Service]\n"
            f"ExecStart=/usr/bin/python3 /{opt}/tubelight-runner.py run\nRestart=always\nRestartSec=5\n\n"
            "[Install]\nWantedBy=default.target\n").encode(), 0o644),
    }
    control = {
        "control": ((
            f"Package: tubelight-desktop\nVersion: {version}\nArchitecture: all\nMaintainer: Tubelight <hello@stepwise.studio>\n"
            "Depends: python3 (>= 3.10), python3-gi, gir1.2-gtk-4.0, gir1.2-adw-1, bubblewrap\nRecommends: docker.io, zenity\n"
            "Section: utils\nPriority: optional\nDescription: Let your Tubelight teammates work on this computer\n"
            " Link this computer to your Tubelight app with a QR code. Teammates can then read the folders you share,\n"
            " and change files or run commands there after you approve each step on your phone.\n").encode(), 0o644),
        "postinst": (b"#!/bin/sh\nset -e\nsystemctl --global enable tubelight-runner.service >/dev/null 2>&1 || true\n"
                     b"gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true\n", 0o755),
        "prerm": (b"#!/bin/sh\nsystemctl --global disable tubelight-runner.service >/dev/null 2>&1 || true\n", 0o755),
    }
    deb = _ar([("debian-binary", b"2.0\n"), ("control.tar.gz", _tgz(control)), ("data.tar.gz", _tgz(data))])
    return f"tubelight-desktop_{version}_all.deb", deb


# ------------------------------------------------------------------ commands that only look
# Read-only commands run without asking (the chat would otherwise ask before every `ls`). Deliberately strict:
# every part of a pipeline or chain must start with a known read-only command, with no writing redirects, no command
# substitution, and the per-command flags that change things refused. Anything else asks, as before.
READ_ONLY = {
    "ls", "cat", "head", "tail", "wc", "du", "df", "free", "uptime", "uname", "whoami", "id", "hostname", "date", "cal",
    "ps", "pgrep", "lsblk", "lscpu", "lsusb", "lspci", "lsof", "stat", "file", "which", "whereis", "type", "echo",
    "printf", "tree", "dpkg-query", "apt-cache", "snap", "flatpak", "systemctl", "journalctl", "sensors", "upower",
    "nproc", "realpath", "basename", "dirname", "pwd", "cd", "grep", "egrep", "rg", "sort", "uniq", "cut", "tr", "column",
    "numfmt", "find", "locate", "top", "ip", "ss", "free", "lsmod", "xdg-user-dir", "test", "[", "true", "md5sum",
    "sha256sum", "diff", "cmp", "less", "more", "nl", "fold", "fmt", "env", "printenv", "dpkg", "apt", "gsettings", "wpctl",
    "wl-paste",
}
_SUB_OK = {  # commands that also change things: only these subcommands/forms are looking
    "snap": {"list", "info", "find", "version", "changes"},
    "flatpak": {"list", "info", "search", "remotes", "history"},
    "systemctl": {"status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "list-timers", "--user"},
    "apt": {"list", "show", "policy", "search"},
    "dpkg": {"-l", "-L", "-s", "--list", "--listfiles", "--status", "-S", "--search", "--get-selections"},
    "ip": {"addr", "a", "route", "r", "link", "-br", "-4", "-6", "-s"},
    "gsettings": {"get", "list-keys", "list-schemas", "list-recursively"},
    "wpctl": {"status", "get-volume", "inspect"},
}


def read_only(cmd: str) -> bool:
    # A $( ... ) that only looks is fine (upower -i $(upower -e | grep BAT)): check what's inside, then the rest.
    while (m := re.search(r"\$\(([^()]*)\)", cmd)):
        if not read_only(m.group(1)):
            return False
        cmd = cmd[:m.start()] + "X" + cmd[m.end():]
    if "`" in cmd or "$(" in cmd or "<(" in cmd or ">(" in cmd:
        return False
    try:  # quote-aware: a | inside 'a|b' is part of a word, not a pipe
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        tokens = list(lex)
    except ValueError:
        return False
    parts: list[list[str]] = [[]]
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ("|", "||", "&&", ";", "&", ";;", "|&"):
            parts.append([])
        elif t in (">", ">>", ">|", "&>", "&>>"):
            target = tokens[i + 1] if i + 1 < len(tokens) else ""
            if target != "/dev/null":
                return False  # writing a file
            if parts[-1] and parts[-1][-1].isdigit():
                parts[-1].pop()  # the 2 of 2>/dev/null
            i += 1
        elif t == ">&":
            if parts[-1] and parts[-1][-1].isdigit():
                parts[-1].pop()  # 2>&1
            i += 1
        elif t in ("<", "<<", "<<<"):
            i += 1
        else:
            parts[-1].append(t)
        i += 1
    for words in parts:
        if not words:
            continue
        head = words[0]
        if "=" in head or head not in READ_ONLY:
            return False
        if head in _SUB_OK and not any(w in _SUB_OK[head] for w in words[1:2] + (words[1:3] if head == "systemctl" else [])):
            return False
        if head == "systemctl" and any(w in {"start", "stop", "restart", "enable", "disable", "mask", "kill", "reload",
                                             "suspend", "poweroff", "reboot", "hibernate"} for w in words):
            return False
        if head == "find" and any(w in {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls"} for w in words):
            return False
        if head == "journalctl" and any(w.startswith(("--vacuum", "--rotate", "--flush")) for w in words):
            return False
        if head == "env" and len(words) > 1:
            return False  # `env X=1 cmd` runs cmd
    return True


# Light actions: change something trivial and visible on the computer (lock, open, volume, play/pause, a note on its
# screen). Asking first would just be a second tap, so they run straight away, like the read-only ones.
LIGHT = [
    r"loginctl lock-session",
    r"xdg-open \S+(\s+\S+)?",
    r"gtk-launch [\w.\-]+(\s+\S+)?",
    r"notify-send( -\w+( \S+)?)* (\"[^\"]*\"|'[^']*'|\S+)( (\"[^\"]*\"|'[^']*'|\S+))?",
    r"wpctl set-(volume|mute) @DEFAULT_AUDIO_SINK@ [\d.%+\-]+|wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle",
    r"gdbus call --session --dest org\.mpris\.MediaPlayer2\.[\w.\-]+ --object-path /org/mpris/MediaPlayer2 --method "
    r"org\.mpris\.MediaPlayer2\.Player\.(PlayPause|Play|Pause|Next|Previous|Stop)",
    r"gdbus call --session --dest org\.freedesktop\.DBus --object-path /org/freedesktop/DBus --method org\.freedesktop\.DBus\.ListNames",
    r"wl-copy (\"[^\"]*\"|'[^']*')",
]


def light(cmd: str) -> bool:
    c = cmd.strip()
    return not re.search(r"[;&|`$<>]", c.replace("@DEFAULT_AUDIO_SINK@", "")) and any(re.fullmatch(p, c) for p in LIGHT)


# Slash commands in a computer's chat: the app lists them when the message starts with "/", the service hands the
# teammate the instructions (graph.preamble). {arg} is whatever follows the command.
SLASH: dict[str, tuple[str, str]] = {
    "status": ("Battery, CPU, memory, disk, uptime",
               "Report this computer's state now in one compact Stats drawing: battery % and whether charging (upower), "
               "CPU load (uptime), memory used/total (free --si), disk used/free (df -h --si /), uptime. One command."),
    "big": ("The largest apps and folders",
            "Find what takes the most space: the 10 largest installed apps (dpkg-query sizes are KiB; include snaps) "
            "and the 10 largest folders in home (du -sh --si ~/* ~/.[!.]* 2>/dev/null | sort -h | tail -10). "
            "Two short lists, every row, in GB/MB."),
    "clean": ("Free up space safely",
              "Find what can be cleaned safely: the apt cache, old snap revisions, ~/.cache, the Trash, journal logs. "
              "Show a preview with each size first. Then propose cleanup commands one by one (admin where needed). "
              "Never touch documents, photos, projects or Downloads."),
    "update": ("Check for system updates",
               "Check for updates (apt list --upgradable, snap refresh --list) and show them grouped. If they want to "
               "update, run it as one admin command (sudo=true)."),
    "find": ("Find a file by name",
             "Find files whose name is like '{arg}' in their home, newest first, with size and date: "
             "find ~ -iname '*{arg}*' -not -path '*/.*' -printf '%TY-%Tm-%Td %s %p\\n' 2>/dev/null | sort -r | head -20. "
             "If nothing has that name, say so and suggest a shorter name."),
    "top": ("What's using CPU and memory",
            "Show what's using the most CPU and memory right now (ps aux --sort=-%cpu | head -8 and --sort=-%mem), as a "
            "short list of apps, not processes where you can tell. Offer to quit a heavy one (that asks)."),
    "send": ("Send a file to this phone",
             "Send the file they mean ('{arg}') to the chat with computer_send_file: find it first if the path isn't "
             "exact (newest match in their home), and say which one you sent."),
    "open": ("Open an app, file or link",
             "Open '{arg}' on the computer: a link or file with xdg-open, an app with gtk-launch <desktop id> (find the "
             "id in /usr/share/applications or ~/.local/share/applications, or via `snap list`/`flatpak list`)."),
    "lock": ("Lock the screen", "Lock the screen now: loginctl lock-session."),
    "sleep": ("Put it to sleep", "Suspend the computer: systemctl suspend. Say it will be offline until it's woken."),
}


def slash(text: str) -> str | None:
    """The instructions for a message that is a slash command, or None."""
    m = re.match(r"\s*/(\w+)\s*(.*)", text or "", re.S)
    if not m or m.group(1).lower() not in SLASH:
        return None
    arg = m.group(2).strip().replace("'", "")[:200]
    return f"They used the slash command /{m.group(1).lower()}{(' ' + arg) if arg else ''}: " + \
        SLASH[m.group(1).lower()][1].replace("{arg}", arg or "what they named")


async def job_done(owner_id: str, cid: str, job: dict[str, Any]) -> None:
    """A long job on the computer ended: say so in its chat (and on the phone)."""
    from . import db, push

    r = await row(owner_id, cid)
    if not r or not r.get("teammate_id"):
        return
    tm = await db.one("teammates", {"id": f"eq.{r['teammate_id']}"})
    secs = int(job.get("seconds") or 0)
    took = f"{secs // 3600} h {secs % 3600 // 60} min" if secs >= 3600 else f"{max(1, secs // 60)} min"
    code = job.get("exit")
    ok = code == 0
    title = str(job.get("title") or "A job")[:120]
    tail = str(job.get("tail") or "").strip()[-1500:]
    text = (f"{'Finished' if ok else 'Stopped with an error'}: **{title}** after {took}"
            f"{'' if ok else f' (exit code {code})'}."
            + (f"\n\n```\n{tail}\n```" if tail else ""))
    thread = f"dm:{r['teammate_id']}"
    await db.insert("messages", {"thread_id": thread, "owner_id": owner_id, "sender_type": "teammate",
                                 "teammate_id": r["teammate_id"], "text": text, "kind": "text", "proactive": True,
                                 "meta": {"job": job.get("id")}})
    await push.notify(owner_id, r["name"], f"{'Finished' if ok else 'Failed'}: {title}", thread, kind="alert", teammate=tm)


# ------------------------------------------------------------------ computers lent to projects
async def project_computers(owner_id: str, project_id: str) -> list[str]:
    item = await memory.store.aget(("computer_projects", owner_id), project_id)
    return list((item.value if item else {}).get("computers") or [])


async def set_project_computers(owner_id: str, project_id: str, ids: list[str]) -> list[str]:
    mine = {r["id"] for r in await listing(owner_id)}
    keep = [i for i in dict.fromkeys(ids) if i in mine][:1]  # ponytail: one computer per project for now
    await memory.store.aput(("computer_projects", owner_id), project_id, {"computers": keep}, index=False)
    return keep


async def for_project(owner_id: str, project_id: str) -> dict[str, Any] | None:
    """The computer this project's teammates may use (online or not: its tools say when it's offline)."""
    ids = await project_computers(owner_id, project_id)
    if not ids:
        return None
    return next((c for c in await listing(owner_id) if c["id"] == ids[0]), None)
