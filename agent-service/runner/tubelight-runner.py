#!/usr/bin/env python3
"""Tubelight runner: lets your teammates work on this computer. Python 3.10+, standard library only (the window
needs GTK 4 + libadwaita, which Ubuntu has; the .deb from <server>/desktop installs everything).

    python3 tubelight-runner.py app                 open the window: link with a QR code, share folders, see activity
    python3 tubelight-runner.py pair <CODE> <URL>   link without the window (code from the app: Profile → Computers)
    python3 tubelight-runner.py allow <folder>      share a folder for Cowork (and `disallow <folder>`)
    python3 tubelight-runner.py status              what's shared and where it's linked
    python3 tubelight-runner.py install             keep it running in the background (systemd user service)
    python3 tubelight-runner.py run                 run in the foreground (Ctrl+C stops all access)
    python3 tubelight-runner.py unpair              forget the link (also remove it in the app)

What teammates can do here, and only while this runs:
- Cowork: list and read files in the folders you shared; write files and run commands there after you approve each
  one in the app. Commands run under bubblewrap: the disk read-only, /home hidden except your shared folders (and a
  few toolchain folders, read-only), no Docker socket, no session sockets.
- Sandboxes: builders' code runs in a locked-down Docker container like on the server (no capabilities, read-only
  system, its own network whose only way out is a proxy that refuses your home network), if Docker is installed.
It connects out to your Tubelight server; nothing listens on this computer.
"""
import base64
import io
import json
import os
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "17"  # 17: websites in your own browser (open, read whole pages), posts/sends only after a yes; 16: the hotkey (say it, it's done), windows moved/resized between monitors (a shell extension), looks 3x faster, keys lent to the right app, text fields read again, says when an app didn't react; 15: folders kept in sync with the Vault; 14: fetches a missing part; 13: using apps (read windows, click, type, keys, open apps); 12: one monitor's screenshot; 11: GNOME apps are closable; 10: screenshots, closing apps; 9: live apps; 8: the window updates on open; 7: long jobs, status; 6: files both ways; 5: updates itself; 3: full access from its chat; 4: admin commands with a password typed on the phone
HERE = Path(__file__).resolve().parent
SERVER = (HERE / "server.txt").read_text().strip() if (HERE / "server.txt").exists() else ""  # set by the .deb
CONF = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "tubelight"
CONF_FILE = CONF / "runner.json"
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "tubelight"
BOXES = CACHE / "boxes"
STATE = CACHE / "state.json"  # what the service is doing, for the window
MAX_OUT = 8000
IMAGE, NET, EGRESS, PROXY = "tubelight-sandbox", "tl-sandbox", "tl-egress", "tl-egress-proxy"
TOOLCHAINS = [".local/bin", ".nvm", ".cargo/bin", ".rustup", ".bun/bin", ".deno/bin", ".pyenv", ".volta", ".local/share/pnpm"]


def load() -> dict:
    c = json.loads(CONF_FILE.read_text()) if CONF_FILE.exists() else {}
    return {"url": SERVER, **c} if SERVER and not c.get("url") else c


_jobs: list[dict] = []


def note(**fields) -> None:
    """Tell the window what's happening (last contact, recent jobs)."""
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        old = json.loads(STATE.read_text()) if STATE.exists() else {}
        STATE.write_text(json.dumps({**old, **fields, "jobs": _jobs[-20:]}))
    except Exception:
        pass


# Updates: newer runner files land in ~/.local/share/tubelight (no sudo needed); whichever copy is newest runs.
UPDATES = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "tubelight"
PARTS = ("tubelight-runner.py", "tubelight_window.py", "qrcodegen.py", "snoofy.py", "snoofy-shell.js",
         "snoofy-shell.json", "tubelight_voice.py")


def version_of(text: str) -> int:
    m = re.search(r'^VERSION = "(\d+)"', text, re.M)
    return int(m[1]) if m else 0


def hand_off() -> None:
    """Run the downloaded copy instead of this one if it's newer (the .deb's files in /opt can't be updated)."""
    mine, newer = Path(__file__).resolve(), UPDATES / "tubelight-runner.py"
    if newer.exists() and newer.resolve() != mine and version_of(newer.read_text()) > int(VERSION.split()[0]):
        os.execv(sys.executable, [sys.executable, str(newer), *sys.argv[1:]])


def update(c: dict) -> bool:
    """Fetch the server's runner; if it's newer, keep it in UPDATES. True when there's a newer one to switch to."""
    try:
        files = {name: fetch(c, name) for name in PARTS}
    except Exception:
        return False
    if version_of(files["tubelight-runner.py"].decode(errors="replace")) <= int(VERSION.split()[0]):
        return False
    UPDATES.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (UPDATES / name).write_bytes(data)
    (UPDATES / "server.txt").write_text(c["url"])
    return True


def save(c: dict) -> None:
    CONF.mkdir(parents=True, exist_ok=True)
    CONF_FILE.write_text(json.dumps(c, indent=2))
    CONF_FILE.chmod(0o600)


def api(c: dict, path: str, body: dict | None = None, timeout: float = 40) -> tuple[int, dict | None]:
    req = urllib.request.Request(c["url"].rstrip("/") + path, data=json.dumps(body or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": f"tubelight-runner/{VERSION}",
                                          **({"Authorization": f"Bearer {c['token']}"} if c.get("token") else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, None


def truncate(s: str, n: int = MAX_OUT) -> str:
    return s if len(s) <= n else s[: n // 2] + f"\n[... {len(s) - n} chars trimmed ...]\n" + s[-n // 2 :]


# ------------------------------------------------------------------ shared folders
def folders(c: dict) -> list[Path]:
    return [Path(f) for f in c.get("folders", []) if Path(f).is_dir()]


def full(c: dict, a: dict) -> bool:
    """Its own chat in the app asks for full access; this computer allows it unless switched off here."""
    if not a.get("full"):
        return False
    if not c.get("full_access", True):
        raise PermissionError("Full access is off on this computer (Tubelight window → Full access from its chat).")
    return True


def anywhere(path: str) -> Path:
    return Path(os.path.realpath(os.path.expanduser(path or "~")))


def inside(c: dict, path: str) -> Path:
    """The real path, if it's inside a shared folder (relative paths start at the first one)."""
    shared = folders(c)
    if not shared:
        raise PermissionError("No folders are shared on this computer. Run: tubelight-runner.py allow <folder>")
    p = Path(os.path.expanduser(path or str(shared[0])))
    real = Path(os.path.realpath(p if p.is_absolute() else shared[0] / p))
    if not any(real == f or f in real.parents for f in shared):
        raise PermissionError(f"{path} is outside the shared folders ({', '.join(map(str, shared))}).")
    return real


def fs_list(c: dict, a: dict) -> str:
    if not a.get("path") and not full(c, a):
        return "Shared folders:\n" + "\n".join(str(f) for f in folders(c))
    d = anywhere(a.get("path", "")) if full(c, a) else inside(c, a["path"])
    if not d.is_dir():
        return f"Not a folder: {d}"
    rows = []
    for e in sorted(d.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))[:300]:
        rows.append(f"{e.name}/" if e.is_dir() else f"{e.name}  ({e.stat().st_size:,} bytes)")
    return f"{d}:\n" + ("\n".join(rows) or "(empty)")


def fs_read(c: dict, a: dict) -> str:
    p = anywhere(a["path"]) if full(c, a) else inside(c, a["path"])
    if not p.is_file():
        return f"No such file: {p}"
    data = p.read_bytes()[:400_000]
    if b"\0" in data[:4096]:
        return f"{p} is a binary file ({p.stat().st_size:,} bytes)."
    return truncate(data.decode(errors="replace"), 16000)


def fs_write(c: dict, a: dict) -> str:
    p = anywhere(a["path"]) if full(c, a) else inside(c, a["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(a.get("content", ""))
    return f"Wrote {len(a.get('content', ''))} chars to {p}"


MAX_FILE = 25 * 1024 * 1024  # the phone side's attachment limit


def fs_get(c: dict, a: dict) -> dict:
    """A file's bytes for the phone (full access only)."""
    p = anywhere(a["path"]) if full(c, a) else inside(c, a["path"])
    if not p.is_file():
        raise FileNotFoundError(f"No such file: {p}")
    if p.stat().st_size > MAX_FILE:
        raise ValueError(f"{p.name} is {p.stat().st_size / 1e6:.0f} MB; the phone takes files up to 25 MB.")
    return {"name": p.name, "size": p.stat().st_size, "b64": base64.b64encode(p.read_bytes()).decode()}


def fs_put(c: dict, a: dict) -> str:
    """A file from the phone, saved under the folder given (full access only); never overwrites."""
    folder = anywhere(a.get("folder") or "~/Downloads/Tubelight") if full(c, a) else inside(c, a.get("folder") or "")
    folder.mkdir(parents=True, exist_ok=True)
    name = Path(a["name"]).name or "file"
    p, n = folder / name, 1
    while p.exists():
        p, n = folder / f"{Path(name).stem} ({n}){Path(name).suffix}", n + 1
    p.write_bytes(base64.b64decode(a["b64"]))
    return str(p)


# Folders kept in sync with the phone's Vault (one way: this computer → the vault). The server asks for a folder's
# listing now and then and for the files it doesn't have; the files go straight to it, in pieces (the tunnel takes
# up to 100 MB a request).
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", ".cache", ".Trash"}
PIECE = 48 * 1024 * 1024


def sync_root(c: dict, path: str) -> Path:
    """Anywhere in the home folder with full access on (the default), otherwise inside the shared folders."""
    p = anywhere(path) if c.get("full_access", True) else inside(c, path)
    if not p.is_dir():
        raise FileNotFoundError(f"No such folder: {p}")
    return p


def sync_dirs(c: dict, a: dict) -> dict:
    """The folders inside one, for picking what to sync from the phone."""
    if not a.get("path") and not c.get("full_access", True):
        return {"path": "", "dirs": [str(f) for f in folders(c)]}
    p = sync_root(c, a.get("path") or "~")
    dirs = sorted((e.name for e in p.iterdir() if e.is_dir() and not e.name.startswith(".")), key=str.lower)
    return {"path": str(p), "parent": str(p.parent) if p != Path.home() and p != p.parent else "", "dirs": dirs[:500]}


def sync_scan(c: dict, a: dict) -> list:
    """Every file under the folder: [relative path, size, mtime]. Hidden files and build folders are left out."""
    root, out = sync_root(c, a["path"]), []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x not in SKIP_DIRS]
        for f in files:
            if f.startswith(".") or f.endswith((".part", ".crdownload", "~")):
                continue
            p = Path(d) / f
            try:
                st = p.stat()
            except OSError:
                continue
            out.append([str(p.relative_to(root)), st.st_size, int(st.st_mtime)])
            if len(out) >= 20000:
                return out
    return out


def sync_push(c: dict, a: dict) -> dict:
    """Sends the files asked for to the server, each in pieces."""
    root, sent, failed = sync_root(c, a["path"]), 0, []
    for rel in a.get("files", []):
        p = root / rel
        try:
            st = p.stat()
            with p.open("rb") as f:
                off = 0
                while True:
                    piece = f.read(PIECE)
                    end = off + len(piece) >= st.st_size
                    q = urllib.parse.urlencode({"p": rel, "m": int(st.st_mtime), "off": off, "end": int(end)})
                    req = urllib.request.Request(f"{c['url'].rstrip('/')}/runner/sync/{a['sid']}?{q}", data=piece, method="POST",
                                                 headers={"Content-Type": "application/octet-stream", "User-Agent": f"tubelight-runner/{VERSION}",
                                                          "Authorization": f"Bearer {c['token']}"})
                    with urllib.request.urlopen(req, timeout=600) as r:
                        r.read()
                    off += len(piece)
                    if end:
                        break
            sent += 1
        except Exception as e:
            failed.append(f"{rel}: {e}"[:200])
    return {"sent": sent, "failed": failed[:20]}


# Long jobs: started detached (they outlive the 10-minute limit and a runner restart), logged to a file, and reported
# to the computer's chat when they end.
JOBS = CACHE / "jobs"


def job_start(c: dict, a: dict) -> dict:
    if not full(c, a):
        raise PermissionError("Long jobs run from the computer's own chat.")
    JOBS.mkdir(parents=True, exist_ok=True)
    jid = os.urandom(4).hex()
    log = JOBS / f"{jid}.log"
    cwd = anywhere(a.get("cwd") or "~")
    with open(log, "wb") as out:
        p = subprocess.Popen(["bash", "-lc", a["cmd"]], cwd=cwd if cwd.is_dir() else Path.home(), stdout=out,
                             stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    threading.Thread(target=_report, args=(jid, a.get("title") or a["cmd"][:60], p, log, time.time()), daemon=True).start()
    return {"id": jid, "log": str(log)}


def _report(jid: str, title: str, p: subprocess.Popen, log: Path, began: float) -> None:
    code = p.wait()
    tail = log.read_text(errors="replace")[-2500:] if log.exists() else ""
    for _ in range(20):  # the server may be restarting: keep trying for ~10 minutes
        try:
            if api(load(), "/runner/done", {"id": jid, "title": title, "exit": code, "seconds": int(time.time() - began),
                                            "tail": tail})[0] == 200:
                return
        except Exception:
            pass
        time.sleep(30)


def stats() -> dict:
    """What the status strip in the computer's chat shows: battery, disk, memory, load."""
    out: dict = {}
    try:
        du = shutil.disk_usage("/")
        out["disk"] = round(du.used / du.total * 100)
        mem = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines() if ":" in line)
        total, avail = int(mem["MemTotal"].split()[0]), int(mem["MemAvailable"].split()[0])
        out["mem"] = round((total - avail) / total * 100)
        out["load"] = round(os.getloadavg()[0] / (os.cpu_count() or 1) * 100)
        for b in sorted(Path("/sys/class/power_supply").glob("BAT*")):
            out["battery"] = int((b / "capacity").read_text().strip())
            out["charging"] = (b / "status").read_text().strip() in ("Charging", "Full", "Not charging")  # plugged in
            break
    except Exception:
        pass
    return out


NICE = {"chrome": "Chrome", "chromium": "Chromium", "firefox": "Firefox", "code": "VS Code", "Isolated Web Co": "Firefox",
        "gnome-shell": "GNOME Shell", "Xwayland": "Xwayland", "java": "Java", "node": "Node.js", "python3": "Python",
        "docker": "Docker", "dockerd": "Docker", "containerd": "Docker", "Web Content": "Firefox", "WebExtensions": "Firefox",
        "Privileged Cont": "Firefox", "RDD Process": "Firefox", "Socket Process": "Firefox", "Utility Process": "Firefox",
        "chatgpt": "ChatGPT", "claude-desktop": "Claude", "nautilus": "Files", "gnome-terminal-": "Terminal", "ptyxis": "Terminal",
        "baobab": "Disk Usage", "zen": "Zen Browser", "postgres": "PostgreSQL", "next-server": "Next.js", "snapd": "Snap", "claude": "Claude Code",
        "gnome-calculato": "Calculator", "gnome-calendar": "Calendar", "gnome-text-edit": "Text Editor",
        "gnome-system-mo": "System Monitor", "gnome-control-c": "Settings", "org.gnome.Nautilus": "Files"}


def _procs() -> dict:
    page = os.sysconf("SC_PAGE_SIZE")
    out = {}
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            st = (d / "stat").read_text()
            comm = st[st.index("(") + 1:st.rindex(")")]
            if len(comm) >= 15 and comm not in NICE:  # the kernel cuts names at 15 characters: the program's own
                argv0 = (d / "cmdline").read_bytes().split(b"\0")[0].decode(errors="replace")
                comm = re.split(r"[ (:]", Path(argv0).name.lstrip(".").removesuffix("-wrapped"))[0] or comm
            f = st[st.rindex(")") + 2:].split()
            out[d.name] = (comm, int(f[11]) + int(f[12]), int(f[21]) * page, d.stat().st_uid)  # utime+stime, RSS, owner
        except (OSError, ValueError, IndexError):
            continue
    return out


def live(c: dict, a: dict) -> dict:
    """What the computer's info sheet shows, refreshed every couple of seconds: stats and the apps using memory and CPU."""
    first, t0 = _procs(), time.monotonic()
    time.sleep(0.5)
    second, dt = _procs(), time.monotonic() - t0
    hz, cpus = os.sysconf("SC_CLK_TCK"), os.cpu_count() or 1
    apps: dict = {}
    for pid, (comm, ticks, rss, uid) in second.items():
        prev = first.get(pid)
        cpu = (ticks - prev[1]) / hz / dt * 100 / cpus if prev else 0.0
        name = NICE.get(comm, comm)
        g = apps.setdefault(name, {"name": name, "mem": 0, "cpu": 0.0, "procs": 0, "mine": False, "self": False})
        g["mem"] += rss
        g["cpu"] += cpu
        g["procs"] += 1
        g["mine"] |= uid == os.getuid()
        g["self"] |= int(pid) == os.getpid()
    total = int(Path("/proc/meminfo").read_text().split("MemTotal:")[1].split()[0]) * 1024
    top = sorted(apps.values(), key=lambda g: -g["mem"])[:12]
    return {"stats": stats(), "mem_total": total, "cpu_total": round(sum(g["cpu"] for g in apps.values()), 1),
            "apps": [{"name": g["name"], "mem": g["mem"], "cpu": round(g["cpu"], 1), "procs": g["procs"],
                      "closable": g["mine"] and not g["self"] and _closable(g["name"])} for g in top]}


# The desktop and its plumbing: closing these logs you out or breaks sound, search, the clipboard.
KEEP = ("GNOME Shell", "Xwayland", "systemd", "dbus", "pipewire", "wireplumber", "gnome-shell", "gnome-session",
        "gnome-keyring", "gsd-", "gvfs", "xdg-",
        "at-spi", "evolution-", "tracker-", "localsearch", "ibus", "gdm", "gjs", "snapd", "Docker", "PostgreSQL", "kworker")


def _closable(name: str) -> bool:
    return not name.startswith(KEEP)


def quit_app(c: dict, a: dict) -> str:
    """Close every process of one app (as grouped in `live`): politely first, then force if asked or still running."""
    if not full(c, a):
        raise PermissionError("Closing apps needs full access.")
    name = a["name"]
    if not _closable(name):
        raise PermissionError(f"{name} is part of the desktop; closing it would break the session.")
    me = os.getuid()
    pids = [int(p) for p, (comm, _t, _r, uid) in _procs().items() if NICE.get(comm, comm) == name and uid == me and int(p) != os.getpid()]
    if not pids:
        return f"{name} isn't running."
    for sig in (signal.SIGKILL,) if a.get("force") else (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        for _ in range(30):  # up to 3 s for it to save and quit
            pids = [p for p in pids if Path(f"/proc/{p}").exists()]
            if not pids:
                return f"Closed {name}."
            time.sleep(0.1)
    return f"{name} is still running ({len(pids)} processes didn't stop)."


def screenshot(c: dict, a: dict) -> dict:
    """The whole screen as PNG, through the desktop's screenshot portal (Wayland allows nothing else). GNOME asks
    for the "screenshot" permission once: the Tubelight window's switch grants it."""
    if not full(c, a):
        raise PermissionError("Screenshots need full access.")
    from gi.repository import Gio, GLib
    ctx = GLib.MainContext.new()
    ctx.push_thread_default()
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        token = f"tl{int(time.time() * 1000)}"
        path = f"/org/freedesktop/portal/desktop/request/{bus.get_unique_name()[1:].replace('.', '_')}/{token}"
        loop, out = GLib.MainLoop.new(ctx, False), {}

        def done(_c, _s, _o, _i, _sig, params):
            out["code"], res = params.unpack()
            out["uri"] = res.get("uri")
            loop.quit()
        sub = bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response",
                                   path, None, 0, done)
        bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                      "org.freedesktop.portal.Screenshot", "Screenshot",
                      GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token),
                                                     "interactive": GLib.Variant("b", False)})), None, 0, -1, None)
        timer = GLib.timeout_source_new_seconds(20)
        timer.set_callback(lambda *_: loop.quit())
        timer.attach(ctx)
        loop.run()
        bus.signal_unsubscribe(sub)
    finally:
        ctx.pop_thread_default()
    if out.get("code") != 0 or not out.get("uri"):
        raise PermissionError("The desktop refused the screenshot. Turn on “Let your phone take screenshots” in Tubelight on this computer.")
    p = Path(urllib.parse.unquote(urllib.parse.urlparse(out["uri"]).path))
    data = p.read_bytes()
    p.unlink(missing_ok=True)  # it went to the phone; don't fill Pictures/Screenshots
    screens, name = monitors(), "Screenshot.png"
    want = str(a.get("monitor") or "").strip().lower()
    if want and len(screens) > 1:
        pick = next((m for i, m in enumerate(screens, 1) if want in (str(i), m["connector"].lower(), m["name"].lower())
                     or want in m["name"].lower()), None)
        if not pick:
            raise ValueError(f"No monitor {a['monitor']!r}; there are: " + ", ".join(f"{i} {m['name']}" for i, m in enumerate(screens, 1)))
        data, name = _crop(data, screens, pick), f"Screenshot {pick['name']}.png"
    return {"name": name, "size": len(data), "b64": base64.b64encode(data).decode(),
            "monitors": [f"{i} {m['name']}" for i, m in enumerate(screens, 1)]}


# ------------------------------------------------------------------ using apps (snoofy: AT-SPI + keys)
def _driver(c: dict, a: dict):
    if not full(c, a):
        raise PermissionError("Using apps needs full access.")
    if not c.get("use_apps"):
        raise PermissionError("Using apps is off on this computer. Turn on “Let teammates use your apps” in Tubelight there.")
    here = Path(__file__).resolve().parent
    if (here / "snoofy" / "snoofy.py").exists():  # run from the Tubelight repo, where Snoofy has its own folder
        here = here / "snoofy"
    for part in ("snoofy.py", "snoofy-shell.js", "snoofy-shell.json"):
        if not (here / part).exists():  # updated from a runner that didn't know this part yet
            (here / part).write_bytes(fetch(c, part))
    sys.path.insert(0, str(here))
    import snoofy
    if not _windows_checked:  # window control: the shell extension, put in place once (it loads at the next log-in)
        _windows_checked.append(True)
        try:
            snoofy.install_windows()
        except Exception as e:  # never in the way of using apps; the state shows in ui_windows
            print(f"window control: {e}", file=sys.stderr)
    return snoofy


_windows_checked: list = []


def ui_apps(c: dict, a: dict) -> list:
    return _driver(c, a).apps()


def _step(text: str) -> None:
    """Tells the hotkey's card what the worker is doing (when a hotkey session is waiting on it)."""
    tv = sys.modules.get("tubelight_voice")
    if tv and hasattr(tv, "step"):
        tv.step(text[:60])


def ui_look(c: dict, a: dict) -> dict:
    d = _driver(c, a)
    _step(f"Looking at {a['app']}")
    snap = d.observe(a["app"], a.get("window") or "")
    return {"snapshot": snap["snapshot"], "app": snap["app"], "text": d.text(snap)}


def _with_text(d, r: dict) -> dict:
    out = {k: v for k, v in r.items() if k not in ("elements",)}
    if "elements" in r:
        out["text"] = d.text(r)
    return out


def ui_act(c: dict, a: dict) -> dict:
    d = _driver(c, a)
    e = d.element(a["snapshot"], a["element"])
    if str(a["action"]).upper() in ("CLICK", "DOUBLE_CLICK") and d.risky(e["name"]) and not a.get("confirmed"):
        return {"status": "needs_ok", "step": f"press “{e['name']}”", "typed": d.typed(a["snapshot"])}
    verb = {"TYPE": "Typing into", "REPLACE": "Typing into", "FOCUS": "Going to", "READ": "Reading",
            "SCROLL_TO": "Scrolling to"}.get(str(a["action"]).upper(), "Clicking")
    _step(f"{verb} “{e['name'][:40]}”" if e["name"] else f"{verb} {e['role']}")
    return _with_text(d, d.act(a["snapshot"], a["element"], a["action"], str(a.get("value") or "")))


def ui_keys(c: dict, a: dict) -> dict:
    d = _driver(c, a)
    sent = next((k for k in a["keys"] if re.match(r"^(ctrl|control|meta|super|cmd|mod)\+(enter|return)$", str(k).strip(), re.I)), None)
    if sent and not a.get("confirmed"):
        return {"status": "needs_ok", "step": f"press {sent}", "typed": []}
    _step("Pressing " + ", ".join(map(str, a["keys"]))[:40])
    return _with_text(d, d.keys(list(a["keys"]), a.get("app") or ""))


def ui_open(c: dict, a: dict) -> dict:
    d = _driver(c, a)
    r = d.open_url(a["url"], a.get("new_tab", True) is not False, a.get("browser") or "")
    return {"snapshot": r["snapshot"], "app": r["app"], "text": d.text(r)}


def ui_page(c: dict, a: dict) -> dict:
    return _driver(c, a).page(a.get("browser") or "")


def ui_windows(c: dict, a: dict) -> dict:
    d = _driver(c, a)
    if d.windows_state()["state"] != "ready":
        return {"state": d.windows_state()}
    return d.windows()


def ui_place(c: dict, a: dict) -> dict:
    return _driver(c, a).place(a["window"], a.get("monitor"), a.get("where") or "", a.get("size") or "",
                               a.get("state") or "", bool(a.get("focus")))


def ui_launch(c: dict, a: dict) -> dict:
    d = _driver(c, a)
    return _with_text(d, d.launch(a["app"]))


def monitors() -> list:
    """The screens as GNOME lays them out, left to right: name, connector and their place on the desktop."""
    try:
        from gi.repository import Gio
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        _serial, mons, logical, _props = bus.call_sync(
            "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig",
            "GetCurrentState", None, None, 0, 5000, None).unpack()
    except Exception:
        return []
    info = {}
    for (conn, _v, _p, _s), modes, props in mons:
        mode = next((m for m in modes if m[6].get("is-current")), None)
        if mode:
            info[conn] = (props.get("display-name") or conn, mode[1], mode[2])
    out = []
    for x, y, scale, _t, _primary, owners, _props in logical:
        conn = owners[0][0]
        if conn in info:
            label, w, h = info[conn]
            out.append({"name": label, "connector": conn, "x": x, "y": y, "w": round(w / scale), "h": round(h / scale)})
    return sorted(out, key=lambda m: (m["x"], m["y"]))


def _crop(png: bytes, screens: list, m: dict) -> bytes:
    """Cut one monitor out of the whole-desktop screenshot (the image may be scaled against the layout)."""
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf, GLib
    loader = GdkPixbuf.PixbufLoader.new_with_type("png")
    loader.write(png)
    loader.close()
    pix = loader.get_pixbuf()
    left, top = min(s["x"] for s in screens), min(s["y"] for s in screens)
    k = pix.get_width() / (max(s["x"] + s["w"] for s in screens) - left)
    x, y = round((m["x"] - left) * k), round((m["y"] - top) * k)
    w, h = min(round(m["w"] * k), pix.get_width() - x), min(round(m["h"] * k), pix.get_height() - y)
    ok, buf = pix.new_subpixbuf(x, y, w, h).save_to_bufferv("png", [], [])
    if not ok:
        raise GLib.Error("Couldn't cut that monitor out of the screenshot.")
    return bytes(buf)


def run_as_user(a: dict) -> str:
    """Full access: the command runs as this user, in their real environment (opens apps, sees every file)."""
    timeout = max(1, min(int(a.get("timeout") or 120), 600))
    cwd = anywhere(a.get("cwd") or "~")
    # Admin commands: the password typed on the phone goes to sudo on stdin (never argv, never logged), once.
    argv = ["sudo", "-S", "-k", "-p", "", "bash", "-lc", a["cmd"]] if a.get("sudo") else ["bash", "-lc", a["cmd"]]
    feed = {"input": a.get("password", "") + "\n"} if a.get("sudo") else {"stdin": subprocess.DEVNULL}
    try:
        r = subprocess.run(argv, cwd=cwd if cwd.is_dir() else Path.home(), capture_output=True,
                           text=True, errors="replace", timeout=timeout, **feed)
        out = (r.stdout + r.stderr).strip() + f"\n[exit code {r.returncode}]"
    except subprocess.TimeoutExpired as e:
        out = f"{(e.stdout or b'').decode(errors='replace') if isinstance(e.stdout, bytes) else e.stdout or ''}\n[timed out after {timeout}s]"
    return truncate(out.strip())


def shell(c: dict, a: dict) -> str:
    if full(c, a):
        return run_as_user(a)
    if not shutil.which("bwrap"):
        raise RuntimeError("Commands need bubblewrap on this computer (e.g. sudo apt install bubblewrap).")
    cwd = inside(c, a.get("cwd") or "")
    home = Path.home()
    args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/home"]
    if not str(home).startswith("/home/"):
        args += ["--tmpfs", str(home)]
    for hide in ("/media", "/mnt", "/run/media", "/run/user", "/root"):
        if os.path.isdir(hide):
            args += ["--tmpfs", hide]
    for sock in ("/run/docker.sock", "/run/podman/podman.sock"):
        if os.path.exists(sock):
            args += ["--ro-bind", "/dev/null", sock]
    for t in TOOLCHAINS:
        if (home / t).exists():
            args += ["--ro-bind", str(home / t), str(home / t)]
    for f in folders(c):
        args += ["--bind", str(f), str(f)]
    timeout = max(1, min(int(a.get("timeout") or 120), 600))
    env = {"PATH": ":".join([*(str(home / t) for t in (".local/bin", ".cargo/bin", ".bun/bin", ".deno/bin")),
                             "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]),
           "HOME": "/tmp", "LANG": os.environ.get("LANG", "C.UTF-8"), "TERM": "dumb", "CI": "1"}
    args += ["--clearenv", *sum((["--setenv", k, v] for k, v in env.items()), []),
             "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--chdir", str(cwd),
             "timeout", str(timeout), "bash", "-c", a["cmd"]]
    r = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout + 15)
    out = (r.stdout + r.stderr).strip()
    if r.returncode == 124:
        out += f"\n[timed out after {timeout}s]"
    return truncate(f"{out}\n[exit code {r.returncode}]".strip())


# ------------------------------------------------------------------ sandboxes (Docker)
def docker_ok() -> bool:
    try:
        return shutil.which("docker") is not None and subprocess.run(
            ["docker", "info"], capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


def sh(*cmd: str, timeout: float = 600, input: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), capture_output=True, timeout=timeout, input=input)


def setup(c: dict) -> None:
    """Networks, the egress proxy and the sandbox image, the same as the server's (idempotent)."""
    if sh("docker", "network", "inspect", NET).returncode:
        sh("docker", "network", "create", "--internal", NET)
    if sh("docker", "network", "inspect", EGRESS).returncode:
        sh("docker", "network", "create", EGRESS)
    if sh("docker", "inspect", PROXY).returncode:
        conf = CONF / "squid.conf"
        conf.write_bytes(fetch(c, "squid.conf"))
        sh("docker", "run", "-d", "--name", PROXY, "--restart", "unless-stopped", "--network", EGRESS, "--memory", "128m",
           "-v", f"{conf}:/etc/squid/squid.conf:ro", "ubuntu/squid:latest")
        sh("docker", "network", "connect", NET, PROXY)
    if sh("docker", "image", "inspect", IMAGE).returncode:
        print("Building the sandbox image (first time only, a few minutes)...", flush=True)
        r = sh("docker", "build", "-t", IMAGE, "-", input=fetch(c, "sandbox.Dockerfile"), timeout=1800)
        if r.returncode:
            raise RuntimeError(r.stderr.decode(errors="replace")[-500:])


def fetch(c: dict, name: str) -> bytes:
    with urllib.request.urlopen(c["url"].rstrip("/") + f"/runner/{name}", timeout=60) as r:
        return r.read()


def box_dir(key: str) -> Path:
    if not key.replace("-", "").isalnum():
        raise ValueError("bad sandbox key")
    return BOXES / key


def box_exec_raw(key: str, cmd: str, timeout: int) -> str:
    r = sh("docker", "exec", "-w", "/workspace", f"tl-{key}", "bash", "-c", f"timeout {timeout} bash -lc {shlex.quote(cmd)}",
           timeout=timeout + 30)
    out = (r.stdout + r.stderr).decode(errors="replace").strip()
    if r.returncode == 124:
        out += f"\n[timed out after {timeout}s]"
    return truncate(f"{out}\n[exit code {r.returncode}]".strip())


def box_start(c: dict, a: dict) -> str:
    setup(c)
    d = box_dir(a["key"])
    d.mkdir(parents=True, exist_ok=True)
    if a.get("tar"):
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(a["tar"])), mode="r:gz") as tar:
            tar.extractall(d, filter="data")
    sh("docker", "rm", "-f", f"tl-{a['key']}")
    uid = f"{os.getuid()}:{os.getgid()}"
    proxy = f"http://{PROXY}:3128"
    env = {"HOME": "/tmp", "CI": "1", "npm_config_cache": "/tmp/.npm", "PIP_CACHE_DIR": "/tmp/.pip",
           **{k: proxy for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")},
           "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1"}
    r = sh("docker", "run", "-d", "--name", f"tl-{a['key']}", "--cpus", "1", "--memory", "768m", "--pids-limit", "256",
           "--user", uid, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
           "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--network", NET, "-w", "/workspace",
           "-v", f"{d}:/workspace", *sum((["-e", f"{k}={v}"] for k, v in env.items()), []), IMAGE, "sleep", "600")
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors="replace")[-500:])
    if any(d.iterdir()) and not (d / ".git").exists():
        box_exec_raw(a["key"], "git init -q && git add -A && git commit -qm 'Repo as downloaded' --no-gpg-sign", 120)
    return "ok"


def box_path(a: dict) -> Path:
    d = box_dir(a["key"]).resolve()
    p = (d / a["path"].removeprefix("/workspace/").lstrip("/")).resolve()
    if not p.is_relative_to(d):
        raise PermissionError("Paths must stay inside /workspace.")
    return p


def box_read(c: dict, a: dict) -> str:
    p = box_path(a)
    return truncate(p.read_text(errors="replace")) if p.is_file() else f"No such file: {a['path']}"


def box_write(c: dict, a: dict) -> str:
    p = box_path(a)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(a.get("content", ""))
    return f"Wrote {len(a.get('content', ''))} chars to {a['path']}"


def box_close(c: dict, a: dict) -> str:
    diff = ""
    try:
        diff = box_exec_raw(a["key"], "git status --short 2>/dev/null; git diff 2>/dev/null", 30)
    finally:
        sh("docker", "rm", "-f", f"tl-{a['key']}")
        shutil.rmtree(box_dir(a["key"]), ignore_errors=True)
    return diff


OPS = {"fs_list": fs_list, "fs_read": fs_read, "fs_write": fs_write, "shell": shell, "fs_get": fs_get, "fs_put": fs_put, "job_start": job_start, "live": live,
       "quit_app": quit_app, "screenshot": screenshot,
       "ui_apps": ui_apps, "ui_look": ui_look, "ui_act": ui_act, "ui_keys": ui_keys, "ui_launch": ui_launch, "ui_open": ui_open, "ui_page": ui_page, "ui_windows": ui_windows, "ui_place": ui_place,
       "box_start": box_start, "box_exec": lambda c, a: box_exec_raw(box_dir(a["key"]).name, a["cmd"], int(a["timeout"])),
       "box_read": box_read, "box_write": box_write, "box_close": box_close,
       "sync_dirs": sync_dirs, "sync_scan": sync_scan, "sync_push": sync_push}


# ------------------------------------------------------------------ the loop
def handle(c: dict, job: dict) -> None:
    try:
        out, ok = OPS[job["op"]](c, job.get("args") or {}), True
    except Exception as e:
        out, ok = f"{type(e).__name__}: {e}", False
    print(f"{time.strftime('%H:%M:%S')} {job['op']} {'ok' if ok else 'failed'}", flush=True)
    a = job.get("args") or {}
    _jobs.append({"at": time.time(), "op": job["op"], "ok": ok, "what": str(a.get("cmd") or a.get("path") or "")[:120]})
    note()
    for _ in range(3):
        try:
            api(c, "/runner/result", {"id": job["id"], "ok": ok, "out": out})
            return
        except Exception:
            time.sleep(2)


_voice: list = []


def start_voice(c: dict) -> None:
    """The hotkey (Snoofy's pill + Gemini Live): once using apps is on. It checks the switch again on every press."""
    here = Path(__file__).resolve().parent
    if not (here / "tubelight_voice.py").exists():
        (here / "tubelight_voice.py").write_bytes(fetch(c, "tubelight_voice.py"))
    sys.path.insert(0, str(here))
    import tubelight_voice
    tubelight_voice.Voice(load, api, lambda: _driver(load(), {"full": True})).start()


def run() -> None:
    docker = docker_ok()
    if docker:
        threading.Thread(target=lambda: _quiet(setup, load()), daemon=True).start()
    print(f"Tubelight runner {VERSION}. Sandboxes: {'yes' if docker else 'no (Docker not available)'}. Ctrl+C stops all access.", flush=True)
    wait, first = 2, True
    me = Path(__file__).resolve()
    born = me.stat().st_mtime
    checked = 0.0
    while True:
        if me.stat().st_mtime != born:  # updated (a new .deb): start over on the new code
            print("Updated; restarting.", flush=True)
            os.execv(sys.executable, [sys.executable, str(me), "run"])
        if time.time() - checked > 6 * 3600 and load().get("url"):
            checked = time.time()
            if update(load()):
                print("Downloaded a newer runner; switching to it.", flush=True)
                os.execv(sys.executable, [sys.executable, str(UPDATES / "tubelight-runner.py"), "run"])
        c = load()  # linking, sharing and pausing (from the window or the CLI) apply without a restart
        if c.get("token") and c.get("use_apps") and not _voice:
            _voice.append(True)
            try:
                start_voice(c)
            except Exception as e:  # no GStreamer or Soup here: everything else works without the hotkey
                print(f"voice: off ({e})", flush=True)
        if not c.get("token") or c.get("paused"):
            note(online=False, paused=bool(c.get("paused")))
            time.sleep(3)
            continue
        info = {"folders": [str(f) for f in folders(c)], "docker": docker, "shell": bool(shutil.which("bwrap")),
                "full": c.get("full_access", True), "apps": bool(c.get("use_apps")), "stats": stats(),
                "version": VERSION, "os": f"{platform.system()} {platform.release()}", **({"wait": 0} if first else {})}
        try:
            status, job = api(c, "/runner/poll", info, timeout=60)
            first = False
            if status == 401:
                print("This computer was removed in the app; unlinking.", flush=True)
                save({k: v for k, v in load().items() if k not in ("token", "id")})
                continue
            note(online=True, seen=time.time(), error=None, paused=False)
            if status == 200 and job:
                threading.Thread(target=handle, args=(c, job), daemon=True).start()
            wait = 2
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            note(online=False, error=str(e)[:200])
            print(f"Can't reach the server ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
            wait = min(wait * 2, 60)


def _quiet(f, *a) -> None:
    try:
        f(*a)
    except Exception as e:
        print(f"Sandbox setup failed: {e}", flush=True)


def install() -> None:
    if platform.system() != "Linux" or not shutil.which("systemctl"):
        sys.exit("Background install is for Linux with systemd. Elsewhere, keep `tubelight-runner.py run` open.")
    unit = Path.home() / ".config/systemd/user/tubelight-runner.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text(f"[Unit]\nDescription=Tubelight runner\nAfter=network-online.target\n\n[Service]\n"
                    f"ExecStart={sys.executable} {Path(__file__).resolve()} run\nRestart=always\nRestartSec=5\n\n"
                    "[Install]\nWantedBy=default.target\n")
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "tubelight-runner"], capture_output=True)
    print("Running in the background. Stop: systemctl --user stop tubelight-runner  Logs: journalctl --user -u tubelight-runner -f")


def share(path: str, on: bool) -> list[str]:
    c = load()
    p = str(Path(os.path.realpath(os.path.expanduser(path))))
    if on and (not Path(p).is_dir() or p in ("/", str(Path.home()))):
        raise ValueError("Share a specific folder (not / or your whole home folder).")
    fs = [f for f in c.get("folders", []) if f != p] + ([p] if on else [])
    save({**c, "folders": fs})
    return fs


def ensure_service() -> None:
    """The background part runs as a user service (installed by the .deb, or by `install`)."""
    if not shutil.which("systemctl"):
        return
    if subprocess.run(["systemctl", "--user", "cat", "tubelight-runner"], capture_output=True).returncode:
        install()
    else:
        subprocess.run(["systemctl", "--user", "enable", "--now", "tubelight-runner"], capture_output=True)


GUI_SRC = HERE / "tubelight_window.py"


def gui() -> None:
    c = load()
    if c.get("url") and update(c):  # opening the window updates: the service restarts on the new code, and so does this
        subprocess.run(["systemctl", "--user", "restart", "tubelight-runner"], capture_output=True)
        os.execv(sys.executable, [sys.executable, str(UPDATES / "tubelight-runner.py"), "app"])
    sys.path.insert(0, str(HERE))
    import importlib.util
    spec = importlib.util.spec_from_file_location("tubelight_window", GUI_SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ensure_service()
    mod.main(sys.modules[__name__])


def main() -> None:
    hand_off()
    a = sys.argv[1:]
    cmd = a[0] if a else "status"
    c = load()
    if cmd == "pair" and len(a) >= 3:
        c = {"url": a[2].rstrip("/"), "folders": c.get("folders", [])}
        status, r = api(c, "/runner/claim", {"code": a[1], "name": socket.gethostname(), "os": platform.system()})
        if status != 200 or not r:
            sys.exit((r or {}).get("detail") or f"Pairing failed ({status}).")
        save({**c, **r})
        print("Paired. Share a folder for Cowork:  python3 tubelight-runner.py allow ~/some/folder\n"
              "Then start it:                    python3 tubelight-runner.py install   (or: run)")
    elif cmd in ("allow", "disallow") and len(a) >= 2:
        try:
            fs = share(a[1], cmd == "allow")
        except ValueError as e:
            sys.exit(str(e))
        print("Shared folders:\n" + ("\n".join(fs) or "(none)"))
    elif cmd == "status":
        print(f"Linked to: {c.get('url') or 'nothing (run pair)'}\nShared folders:\n" +
              ("\n".join(c.get("folders", [])) or "(none)") + f"\nSandboxes: {'yes' if docker_ok() else 'no'}"
              f"\nCommands: {'yes' if shutil.which('bwrap') else 'no (install bubblewrap)'}")
    elif cmd == "run":
        try:
            run()
        except KeyboardInterrupt:
            print("\nStopped. Teammates can't reach this computer now.")
    elif cmd == "install":
        install()
    elif cmd == "app":
        gui()
    elif cmd == "unpair":
        save({k: v for k, v in c.items() if k not in ("token", "id")})
        print("Unpaired. Also remove it in the app (Profile → Computers).")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
