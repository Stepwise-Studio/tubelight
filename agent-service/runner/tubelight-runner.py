#!/usr/bin/env python3
"""Tubelight runner: lets your teammates work on this computer. Python 3.10+, standard library only.

    python3 tubelight-runner.py pair <CODE> <URL>   link this computer (code from the app: Profile → Computers)
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

VERSION = "1"
CONF = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "tubelight"
CONF_FILE = CONF / "runner.json"
BOXES = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "tubelight" / "boxes"
MAX_OUT = 8000
IMAGE, NET, EGRESS, PROXY = "tubelight-sandbox", "tl-sandbox", "tl-egress", "tl-egress-proxy"
TOOLCHAINS = [".local/bin", ".nvm", ".cargo/bin", ".rustup", ".bun/bin", ".deno/bin", ".pyenv", ".volta", ".local/share/pnpm"]


def load() -> dict:
    return json.loads(CONF_FILE.read_text()) if CONF_FILE.exists() else {}


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
    if not a.get("path"):
        return "Shared folders:\n" + "\n".join(str(f) for f in folders(c))
    d = inside(c, a["path"])
    if not d.is_dir():
        return f"Not a folder: {d}"
    rows = []
    for e in sorted(d.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))[:300]:
        rows.append(f"{e.name}/" if e.is_dir() else f"{e.name}  ({e.stat().st_size:,} bytes)")
    return f"{d}:\n" + ("\n".join(rows) or "(empty)")


def fs_read(c: dict, a: dict) -> str:
    p = inside(c, a["path"])
    if not p.is_file():
        return f"No such file: {p}"
    data = p.read_bytes()[:400_000]
    if b"\0" in data[:4096]:
        return f"{p} is a binary file ({p.stat().st_size:,} bytes)."
    return truncate(data.decode(errors="replace"), 16000)


def fs_write(c: dict, a: dict) -> str:
    p = inside(c, a["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(a.get("content", ""))
    return f"Wrote {len(a.get('content', ''))} chars to {p}"


def shell(c: dict, a: dict) -> str:
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


OPS = {"fs_list": fs_list, "fs_read": fs_read, "fs_write": fs_write, "shell": shell,
       "box_start": box_start, "box_exec": lambda c, a: box_exec_raw(box_dir(a["key"]).name, a["cmd"], int(a["timeout"])),
       "box_read": box_read, "box_write": box_write, "box_close": box_close}


# ------------------------------------------------------------------ the loop
def handle(c: dict, job: dict) -> None:
    try:
        out, ok = OPS[job["op"]](c, job.get("args") or {}), True
    except Exception as e:
        out, ok = f"{type(e).__name__}: {e}", False
    print(f"{time.strftime('%H:%M:%S')} {job['op']} {'ok' if ok else 'failed'}", flush=True)
    for _ in range(3):
        try:
            api(c, "/runner/result", {"id": job["id"], "ok": ok, "out": out})
            return
        except Exception:
            time.sleep(2)


def run() -> None:
    c = load()
    if not c.get("token"):
        sys.exit("Not paired yet. Get a code in the app (Profile → Computers), then: tubelight-runner.py pair <CODE> <URL>")
    docker = docker_ok()
    if docker:
        threading.Thread(target=lambda: _quiet(setup, c), daemon=True).start()
    print(f"Tubelight runner on {c['url']}. Shared: {', '.join(map(str, folders(c))) or 'nothing yet'}. "
          f"Sandboxes: {'yes' if docker else 'no (Docker not available)'}. Ctrl+C stops all access.", flush=True)
    wait = 2
    while True:
        c = load()  # `allow` / `disallow` apply without a restart
        info = {"folders": [str(f) for f in folders(c)], "docker": docker, "shell": bool(shutil.which("bwrap")),
                "version": VERSION, "os": f"{platform.system()} {platform.release()}"}
        try:
            status, job = api(c, "/runner/poll", info, timeout=60)
            if status == 401:
                sys.exit("This computer was removed in the app. Pair it again to use it.")
            if status == 200 and job:
                threading.Thread(target=handle, args=(c, job), daemon=True).start()
            wait = 2
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
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
    subprocess.run(["systemctl", "--user", "daemon-reload"])
    subprocess.run(["systemctl", "--user", "enable", "--now", "tubelight-runner"])
    print("Running in the background. Stop: systemctl --user stop tubelight-runner  Logs: journalctl --user -u tubelight-runner -f")


def main() -> None:
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
        p = str(Path(os.path.realpath(os.path.expanduser(a[1]))))
        if cmd == "allow" and (not Path(p).is_dir() or p in ("/", str(Path.home()))):
            sys.exit("Share a specific folder (not / or your whole home folder).")
        fs = [f for f in c.get("folders", []) if f != p] + ([p] if cmd == "allow" else [])
        save({**c, "folders": fs})
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
    elif cmd == "unpair":
        save({k: v for k, v in c.items() if k not in ("token", "id")})
        print("Unpaired. Also remove it in the app (Profile → Computers).")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
