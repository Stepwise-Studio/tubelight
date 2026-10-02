"""Docker sandbox: one container per teammate per run, sharing a per-run workdir.

The container runs `sleep 600` as PID 1, so it dies by itself after the 10-minute wall timeout.
Workdir <WORKSPACES>/<run_id> survives approval pauses and is deleted when the run ends.

Locked down: an unprivileged user, every Linux capability dropped, no privilege escalation, a read-only system
(only /workspace and /tmp are writable), CPU/memory/process limits. On the home server it sits on an internal
network whose only way out is the egress proxy (deploy/squid.conf): the web yes, the home network no. The project's
repo arrives through the user's GitHub connection (no token in the box) as a fresh git baseline, so the run's
changes show up as a diff.
"""
import asyncio
import base64
import logging
import os
import re
import shlex
import shutil
from pathlib import Path

from . import config

log = logging.getLogger(__name__)
MAX_OUT = 8000
WALL_S = 600
GIT_PUSH = re.compile(r"\bgit\b[^;&|]*\bpush\b")


def truncate(s: str, n: int = MAX_OUT) -> str:
    return s if len(s) <= n else s[: n // 2] + f"\n[... {len(s) - n} chars trimmed ...]\n" + s[-n // 2 :]


def _docker():
    import docker

    return docker.from_env()


def available() -> bool:
    try:
        return bool(_docker().ping())
    except Exception:
        return False


def workdir(run_id: str) -> Path:
    return config.WORKSPACES / run_id


class Sandbox:
    def __init__(self, run_id: str, teammate_id: str, repo_url: str | None, owner_id: str | None = None):
        self.run_id, self.teammate_id, self.repo_url, self.owner_id = run_id, teammate_id, repo_url, owner_id
        self.dir = workdir(run_id)
        self.container = None

    async def _ready(self) -> None:
        """Start the box on first use, with the project's repo in it."""
        if self.container is not None:
            return
        from . import repo

        self.dir.mkdir(parents=True, exist_ok=True)
        target = repo.parse(self.repo_url)
        if target and self.owner_id and not any(self.dir.iterdir()):
            try:
                info = await repo.repo_info(self.owner_id, *target)
                await repo.download(self.owner_id, target[0], target[1], info.get("default_branch") or "main", self.dir)
            except Exception as e:
                log.warning("sandbox repo download failed: %s", e)
        await asyncio.to_thread(self._start)

    def _start(self) -> None:
        import docker

        self.dir.mkdir(parents=True, exist_ok=True)
        uid = int(config.SANDBOX_UID) if config.SANDBOX_UID else os.getuid()
        for p in [self.dir, *self.dir.rglob("*")]:  # the agent may run as root; the box doesn't
            try:
                os.chown(p, uid, uid)
            except OSError:
                pass
        client = _docker()
        try:
            client.images.get(config.SANDBOX_IMAGE)
        except docker.errors.ImageNotFound:
            raise RuntimeError(
                f"The sandbox image '{config.SANDBOX_IMAGE}' is not built yet. "
                "Build it with: docker build -t tubelight-sandbox agent-service/sandbox"
            )
        proxy = config.SANDBOX_PROXY
        env = {"HOME": "/tmp", "CI": "1", "npm_config_cache": "/tmp/.npm", "PIP_CACHE_DIR": "/tmp/.pip"}
        if proxy:
            env |= {k: proxy for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")}
            env |= {"NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1"}
        self.container = client.containers.run(
            config.SANDBOX_IMAGE,
            ["sleep", str(WALL_S)],
            detach=True,
            name=f"tubelight-{self.run_id[:8]}-{self.teammate_id[:8]}",
            nano_cpus=1_000_000_000,
            mem_limit="768m",
            pids_limit=256,
            user=f"{uid}:{uid}",  # files stay deletable by the host user
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            read_only=True,
            tmpfs={"/tmp": "rw,size=512m,mode=1777"},
            network=config.SANDBOX_NETWORK or None,
            environment=env,
            working_dir="/workspace",
            volumes={str(self.dir): {"bind": "/workspace", "mode": "rw"}},
        )
        # A baseline commit, so the run's changes are a plain `git diff` (an archive download has no history).
        if any(self.dir.iterdir()) and not (self.dir / ".git").exists():
            self._exec("git init -q && git add -A && git commit -qm 'Repo as downloaded' --no-gpg-sign", 120)

    def _exec(self, cmd: str, timeout_s: int) -> str:
        if self.container is None:
            self._start()
        wrapped = f"timeout {int(timeout_s)} bash -lc {shlex.quote(cmd)}"
        code, out = self.container.exec_run(["bash", "-c", wrapped], workdir="/workspace")
        text = out.decode(errors="replace")
        if code == 124:
            text += f"\n[timed out after {timeout_s}s]"
        return truncate(f"{text}\n[exit code {code}]".strip())

    async def run_shell(self, cmd: str, timeout_s: int = 120) -> str:
        if GIT_PUSH.search(cmd):
            return "git push is blocked in run_shell. Use the git_push tool, which asks the user for approval."
        await self._ready()
        return await asyncio.to_thread(self._exec, cmd, max(1, min(timeout_s, WALL_S)))

    def _path(self, path: str) -> Path:
        p = (self.dir / path.removeprefix("/workspace/").lstrip("/")).resolve()
        if not p.is_relative_to(self.dir.resolve()):
            raise ValueError("Paths must stay inside /workspace.")
        return p

    async def read_file(self, path: str) -> str:
        await self._ready()
        p = self._path(path)
        if not p.is_file():
            return f"No such file: {path}"
        return truncate(p.read_text(errors="replace"))

    async def write_file(self, path: str, content: str) -> str:
        await self._ready()
        p = self._path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return f"Wrote {len(content)} chars to {path}"

    async def git_push(self, branch: str) -> str:
        await self._ready()
        auth = ""
        if config.GITHUB_TOKEN:
            basic = base64.b64encode(f"x-access-token:{config.GITHUB_TOKEN}".encode()).decode()
            auth = f"-c http.extraheader={shlex.quote('AUTHORIZATION: basic ' + basic)} "
        return await asyncio.to_thread(self._exec, f"git {auth}push origin HEAD:{shlex.quote(branch)}", 120)

    def _close(self) -> str:
        """Returns `git diff` of the workdir, then removes the container."""
        if self.container is None:
            return ""
        diff = ""
        try:
            diff = self._exec("git status --short 2>/dev/null; git diff 2>/dev/null", 30)
        except Exception as e:
            log.warning("sandbox diff failed: %s", e)
        try:
            self.container.remove(force=True)
        except Exception as e:
            log.warning("sandbox remove failed: %s", e)
        self.container = None
        return diff

    async def close(self) -> str:
        return await asyncio.to_thread(self._close)


def cleanup_workdir(run_id: str) -> None:
    shutil.rmtree(workdir(run_id), ignore_errors=True)
