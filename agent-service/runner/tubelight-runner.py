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
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "8"  # 8: the window updates on open; 7: long jobs, status; 6: files both ways; 5: updates itself; 3: full access from its chat; 4: admin commands with a password typed on the phone
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
PARTS = ("tubelight-runner.py", "tubelight_window.py", "qrcodegen.py")


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


OPS = {"fs_list": fs_list, "fs_read": fs_read, "fs_write": fs_write, "shell": shell, "fs_get": fs_get, "fs_put": fs_put, "job_start": job_start,
       "box_start": box_start, "box_exec": lambda c, a: box_exec_raw(box_dir(a["key"]).name, a["cmd"], int(a["timeout"])),
       "box_read": box_read, "box_write": box_write, "box_close": box_close}


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
        if not c.get("token") or c.get("paused"):
            note(online=False, paused=bool(c.get("paused")))
            time.sleep(3)
            continue
        info = {"folders": [str(f) for f in folders(c)], "docker": docker, "shell": bool(shutil.which("bwrap")),
                "full": c.get("full_access", True), "stats": stats(),
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
