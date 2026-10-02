"""Repo knowledge: what a project's GitHub repo is and how it's built, kept current for every teammate in it.

When a project gets a repo (picked in its settings), a background pass:
1. downloads the code through the user's GitHub connection (Composio's archive link works for private repos too),
   keeping source files only (no node_modules, lockfiles, binaries, huge files);
2. builds a repo map without any model: the file tree and each file's top-level functions/classes (regex per
   language; ponytail: tree-sitter if the symbols ever need to be exact);
3. summarises each area (top-level folder, or package in a monorepo) with the cheap model, then writes the brief:
   what it is, stack, layout, how to run and test, conventions. Capped at MAX_AREAS + 1 model calls per pass.
Every 6 hours (and right after a teammate pushes, or on "Re-index") it checks the branch head; a new commit
re-reads only the areas whose files changed and adds the commits to a change log. The user can edit the brief:
their version is what teammates see from then on.

Teammates in the project get the brief in their instructions and a `repo_context` tool (search the code, read a
file, recent changes); `repo_note` adds something they learned to the brief's team notes.
Stored in the LangGraph store under ("repo", project_id); the downloaded files live on disk and are fetched again
when missing (e.g. after a redeploy).
"""
import asyncio
import hashlib
import logging
import re
import shutil
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from . import config, connectors, db, memory

log = logging.getLogger(__name__)

MAX_ARCHIVE = 150 * 1024 * 1024  # bytes downloaded
MAX_FILE = 200 * 1024  # a source file bigger than this is skipped (generated, data)
MAX_FILES = 4000
MAX_AREAS = 24  # model calls per pass, plus one for the brief
REFRESH_S = 6 * 3600
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".expo", "coverage", "vendor", "venv",
             ".venv", "__pycache__", ".turbo", ".cache", "target", "Pods", ".gradle", ".idea", ".vscode", "bower_components"}
SKIP_FILES = re.compile(r"(\.lock|lock\.json|lock\.yaml|\.min\.js|\.map|\.snap|\.svg|\.png|\.jpe?g|\.gif|\.webp|\.ico|"
                        r"\.pdf|\.zip|\.gz|\.mp[34]|\.wav|\.ttf|\.otf|\.woff2?|\.eot|\.jar|\.so|\.dylib|\.exe|\.bin|"
                        r"\.pyc|\.class|\.db|\.sqlite|\.parquet|\.pkl|\.onnx|\.pt|\.h5)$", re.I)
KEY_FILES = re.compile(r"(^|/)(readme(\.\w+)?|package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|go\.mod|"
                       r"cargo\.toml|gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|dockerfile|docker-compose\.ya?ml|"
                       r"claude\.md|agents\.md|contributing\.md|makefile|app\.json|tsconfig\.json|\.env\.example)$", re.I)

NS = lambda project_id: ("repo", project_id)  # noqa: E731
_locks: dict[str, asyncio.Lock] = {}
_tasks: set[asyncio.Task] = set()


def parse(repo_url: str | None) -> tuple[str, str] | None:
    """github.com/owner/repo (any URL shape, or plain owner/repo) -> (owner, repo)."""
    if not repo_url:
        return None
    m = re.search(r"(?:github\.com[/:])?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", repo_url.strip())
    return (m.group(1), m.group(2)) if m else None


def repo_dir(project_id: str) -> Path:
    return config.WORKSPACES.parent / "repos" / project_id


# ------------------------------------------------------------------ GitHub through the user's connection
async def _gh(owner_id: str, slug: str, args: dict[str, Any]) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        r = connectors._client().tools.execute(slug, user_id=owner_id, arguments=args, dangerously_skip_version_check=True)
        return r if isinstance(r, dict) else r.model_dump()
    res = await asyncio.to_thread(run)
    if not res.get("successful"):
        raise RuntimeError(str(res.get("error") or f"{slug} failed")[:300])
    return res.get("data") or {}


async def repo_info(owner_id: str, owner: str, name: str) -> dict[str, Any]:
    d = await _gh(owner_id, "GITHUB_GET_A_REPOSITORY", {"owner": owner, "repo": name})
    return d.get("details") or d.get("repository") or d


async def head(owner_id: str, owner: str, name: str, branch: str) -> str:
    d = await _gh(owner_id, "GITHUB_GET_A_BRANCH", {"owner": owner, "repo": name, "branch": branch})
    return (d.get("commit") or {}).get("sha") or ""


async def commits_since(owner_id: str, owner: str, name: str, branch: str, sha: str, limit: int = 30) -> list[dict[str, str]]:
    """Commits on the branch newer than `sha` (newest first), as {sha, message, author}."""
    d = await _gh(owner_id, "GITHUB_LIST_COMMITS", {"owner": owner, "repo": name, "sha": branch, "per_page": limit})
    out = []
    for c in d.get("commits") or []:
        if c.get("sha") == sha:
            break
        info = c.get("commit") or {}
        out.append({"sha": c.get("sha", "")[:7], "message": (info.get("message") or "").split("\n")[0][:160],
                    "author": ((info.get("author") or {}).get("name") or "")[:60]})
    return out


def keep(path: str, size: int) -> bool:
    parts = path.split("/")
    return (size <= MAX_FILE and not any(p in SKIP_DIRS or p.startswith(".") and p not in (".github", ".env.example")
                                         for p in parts[:-1])
            and not SKIP_FILES.search(path))


async def download(owner_id: str, owner: str, name: str, ref: str, dest: Path) -> int:
    """The repo's source files at `ref` into `dest` (replaced). Returns how many were kept."""
    d = await _gh(owner_id, "GITHUB_DOWNLOAD_A_REPOSITORY_ARCHIVE_TAR", {"owner": owner, "repo": name, "ref": ref})
    url = (d.get("headers") or {}).get("location") or d.get("url")
    if not url:
        raise RuntimeError("GitHub didn't give a download link for this repo.")
    with tempfile.TemporaryFile() as tmp:
        got = 0
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as h, h.stream("GET", url) as r:
            r.raise_for_status()
            async for chunk in r.aiter_bytes():
                got += len(chunk)
                if got > MAX_ARCHIVE:
                    raise RuntimeError("This repo is over 150 MB to download; too big to read here.")
                tmp.write(chunk)
        tmp.seek(0)
        return await asyncio.to_thread(_extract, tmp, dest)


def _extract(fileobj: Any, dest: Path) -> int:
    staging = dest.with_name(dest.name + ".new")
    shutil.rmtree(staging, ignore_errors=True)
    kept = 0
    with tarfile.open(fileobj=fileobj, mode="r:gz") as t:
        for m in t:
            if not m.isfile():
                continue
            path = m.name.split("/", 1)[1] if "/" in m.name else m.name  # drop the owner-repo-sha/ prefix
            if not path or not keep(path, m.size) or kept >= MAX_FILES:
                continue
            data = t.extractfile(m).read()
            if b"\0" in data[:4096]:
                continue  # binary
            out = staging / path
            if not out.resolve().is_relative_to(staging.resolve()):
                continue  # a path trying to escape
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            kept += 1
    shutil.rmtree(dest, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    staging.rename(dest)
    return kept


# ------------------------------------------------------------------ the map (no model)
SYMBOLS = [
    (re.compile(r"\.(py)$"), re.compile(r"^(?:async\s+)?(?:def|class)\s+(\w+)", re.M)),
    (re.compile(r"\.(m?[jt]sx?|cjs)$"), re.compile(
        r"^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+(\w+)", re.M)),
    (re.compile(r"\.go$"), re.compile(r"^(?:func(?:\s+\([^)]*\))?|type)\s+(\w+)", re.M)),
    (re.compile(r"\.rs$"), re.compile(r"^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+(\w+)", re.M)),
    (re.compile(r"\.(java|kt|cs|swift)$"), re.compile(
        r"^\s*(?:public\s+|open\s+|internal\s+)?(?:final\s+|abstract\s+|data\s+)?(?:class|interface|object|struct|enum|fun)\s+(\w+)", re.M)),
    (re.compile(r"\.rb$"), re.compile(r"^\s*(?:def|class|module)\s+([\w.]+)", re.M)),
    (re.compile(r"\.php$"), re.compile(r"^\s*(?:final\s+|abstract\s+)?(?:class|function|interface|trait)\s+(\w+)", re.M)),
]


def symbols(path: str, text: str) -> list[str]:
    for ext, rx in SYMBOLS:
        if ext.search(path):
            return list(dict.fromkeys(rx.findall(text)))[:25]
    return []


def files_of(root: Path) -> dict[str, str]:
    """path -> text for every kept file under root."""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = p.read_text(errors="replace")
    return out


def areas_of(paths: list[str]) -> dict[str, list[str]]:
    """Group files into areas: top-level folders; a folder holding packages (apps/*, packages/*, services/*) splits
    into one area per package; loose top-level files form "(root)"."""
    groups: dict[str, list[str]] = {}
    tops: dict[str, set[str]] = {}
    for p in paths:
        parts = p.split("/")
        if len(parts) > 2:
            tops.setdefault(parts[0], set()).add(parts[1])
    for p in paths:
        parts = p.split("/")
        if len(parts) == 1:
            key = "(root)"
        elif parts[0] in ("apps", "packages", "services", "libs", "modules", "crates") and len(parts) > 2:
            key = f"{parts[0]}/{parts[1]}"
        else:
            key = parts[0]
        groups.setdefault(key, []).append(p)
    return dict(sorted(groups.items(), key=lambda kv: -len(kv[1])))


def map_text(area: str, files: dict[str, str]) -> str:
    lines = []
    for p in sorted(files):
        syms = symbols(p, files[p])
        lines.append(f"{p}" + (f": {', '.join(syms)}" if syms else ""))
    return "\n".join(lines)


def digest(text: str) -> str:
    return hashlib.sha1(text.encode(errors="replace")).hexdigest()[:12]


# ------------------------------------------------------------------ the model passes
AREA = """You are documenting one part of a codebase so AI teammates can find their way around it later.
Repo: {repo}. Area: {area} ({n} files).
Write 3-7 short lines: what this area does, the key files and what each is for, how it connects to the rest
(what calls it, what it calls), and anything surprising. Plain text, no headings, no fluff. Name real files."""

BRIEF = """You are writing the brief every AI teammate on this project reads before working on its repo: {repo}.
Write markdown with these sections, each short and concrete (the whole thing under ~500 words):
## What it is
## Stack
## Layout (one line per area: `path` — what it is)
## Run and test (exact commands from the manifests/README; say "not documented" if absent)
## Conventions (naming, patterns, where things go; only what the code shows)
## Watch out for (gotchas, generated code, secrets handling; only if evident)
Only facts the material shows. No marketing, no guesses."""


async def _ask(system: str, user: str) -> str:
    from langchain_core.messages import HumanMessage, SystemMessage

    from . import llm
    res = await llm.chat_model(config.KEEPER_MODEL).ainvoke([SystemMessage(system), HumanMessage(user[:24000])])
    return res.text.strip()


def _area_input(area: str, files: dict[str, str], budget: int = 14000) -> str:
    """The area's map, then its most telling files (README, manifests, entry points, then the biggest), within budget."""
    out = [f"Files and their top-level symbols:\n{map_text(area, files)[:5000]}"]
    def rank(p: str) -> tuple[int, int]:
        name = p.rsplit("/", 1)[-1].lower()
        key = 0 if KEY_FILES.search(p) else 1 if re.match(r"(index|main|app|server|__init__|mod|lib)\.", name) else 2
        return key, -len(files[p])
    left = budget - len(out[0])
    for p in sorted(files, key=rank):
        if left < 600:
            break
        chunk = files[p][: min(left - 100, 4000)]
        out.append(f"\n--- {p} ---\n{chunk}")
        left -= len(chunk) + 20
    return "\n".join(out)


# ------------------------------------------------------------------ state
async def get(project_id: str) -> dict[str, Any]:
    """Everything stored about the project's repo: state, brief, areas, log (empty dict if none)."""
    if not memory.store:
        return {}
    out = {}
    for key in ("state", "brief", "areas", "log"):
        item = await memory.store.aget(NS(project_id), key)
        out[key] = item.value if item else None
    return out if out["state"] else {}


async def _put(project_id: str, key: str, value: dict[str, Any]) -> None:
    await memory.store.aput(NS(project_id), key, value, index=False)


async def _set_state(project_id: str, **changes: Any) -> dict[str, Any]:
    item = await memory.store.aget(NS(project_id), "state")
    state = {**(item.value if item else {}), **changes}
    await _put(project_id, "state", state)
    return state


async def forget(project_id: str) -> None:
    for key in ("state", "brief", "areas", "log"):
        await memory.store.adelete(NS(project_id), key)
    shutil.rmtree(repo_dir(project_id), ignore_errors=True)


def brief_text(stored: dict[str, Any]) -> str:
    """What teammates read: the user's edit if they made one, else the generated brief, plus team notes."""
    b = stored.get("brief") or {}
    text = b.get("edited") or b.get("text") or ""
    notes = b.get("notes") or []
    if notes:
        text += "\n\n## Notes from the team\n" + "\n".join(f"- {n['text']} ({n['by']})" for n in notes[-20:])
    return text


# ------------------------------------------------------------------ the pass
def schedule(owner_id: str, project_id: str, force: bool = False) -> None:
    """Index or refresh in the background (one pass per project at a time)."""
    async def run() -> None:
        try:
            await index(owner_id, project_id, force=force)
        except Exception:
            log.exception("repo pass failed for %s", project_id)
    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def index(owner_id: str, project_id: str, force: bool = False) -> None:
    lock = _locks.setdefault(project_id, asyncio.Lock())
    if lock.locked():
        return  # a pass is already running
    async with lock:
        project = await db.one("projects", {"id": f"eq.{project_id}", "owner_id": f"eq.{owner_id}", "select": "id,repo_url"})
        target = parse((project or {}).get("repo_url"))
        if not target:
            return
        owner, name = target
        full = f"{owner}/{name}"
        stored = await get(project_id)
        state = stored.get("state") or {}
        if state.get("repo") != full:  # a different repo: start over
            await forget(project_id)
            stored, state = {}, {}
        try:
            await _set_state(project_id, repo=full, status="checking", error=None, progress=0)
            info = await repo_info(owner_id, owner, name)
            branch = info.get("default_branch") or state.get("branch") or "main"
            sha = await head(owner_id, owner, name, branch)
            if not force and sha and sha == state.get("sha") and state.get("status") != "error" and repo_dir(project_id).exists():
                await _set_state(project_id, status="ready", checked_at=_now())
                return
            await _set_state(project_id, status="reading", branch=branch, private=bool(info.get("private")),
                             description=(info.get("description") or "")[:300])
            count = await download(owner_id, owner, name, sha or branch, repo_dir(project_id))
            files = await asyncio.to_thread(files_of, repo_dir(project_id))
            await _summarise(project_id, full, files, stored, force)
            new_commits = await commits_since(owner_id, owner, name, branch, state.get("sha") or "") if state.get("sha") else []
            if new_commits:
                logs = (stored.get("log") or {}).get("entries") or []
                logs.insert(0, {"at": _now(), "from": (state.get("sha") or "")[:7], "to": sha[:7], "commits": new_commits[:20]})
                await _put(project_id, "log", {"entries": logs[:50]})
            await _set_state(project_id, status="ready", sha=sha, files=count, indexed_at=_now(), checked_at=_now(), progress=100)
        except Exception as e:
            log.warning("repo pass for %s failed: %s", full, e)
            await _set_state(project_id, status="error", error=str(e)[:300])


async def _summarise(project_id: str, full: str, files: dict[str, str], stored: dict[str, Any], force: bool) -> None:
    """Re-read only the areas whose files changed (all of them the first time), then the brief if anything did."""
    old = (stored.get("areas") or {}).get("areas") or {}
    groups = areas_of(list(files))
    areas: dict[str, Any] = {}
    todo = []
    for area, paths in list(groups.items())[:MAX_AREAS]:
        sub = {p: files[p] for p in paths}
        h = digest("".join(f"{p}:{digest(t)}" for p, t in sorted(sub.items())))
        prev = old.get(area)
        if prev and prev.get("hash") == h and not force:
            areas[area] = prev
        else:
            todo.append((area, sub, h))
    for i, (area, sub, h) in enumerate(todo):
        await _set_state(project_id, progress=int(90 * i / max(1, len(todo))), current=area)
        try:
            summary = await _ask(AREA.format(repo=full, area=area, n=len(sub)), _area_input(area, sub))
        except Exception as e:
            summary = (old.get(area) or {}).get("summary") or f"(not summarised yet: {str(e)[:80]})"
        areas[area] = {"summary": summary[:1500], "hash": h, "files": len(sub), "map": map_text(area, sub)[:6000]}
    if len(groups) > MAX_AREAS:  # the long tail: listed, not summarised
        rest = list(groups.items())[MAX_AREAS:]
        areas["(other)"] = {"summary": "Smaller folders: " + ", ".join(f"{a} ({len(p)})" for a, p in rest)[:1500],
                            "hash": "", "files": sum(len(p) for _, p in rest), "map": ""}
    await _put(project_id, "areas", {"areas": areas})
    if todo or force or not (stored.get("brief") or {}).get("text"):
        await _set_state(project_id, progress=92, current="brief")
        key = "\n\n".join(f"--- {p} ---\n{files[p][:3500]}" for p in sorted(files) if KEY_FILES.search(p))[:12000]
        layout = "\n".join(f"- {a} ({v['files']} files): {v['summary'][:400]}" for a, v in areas.items())
        text = await _ask(BRIEF.format(repo=full), f"Areas:\n{layout}\n\nKey files:\n{key}")
        b = stored.get("brief") or {}
        await _put(project_id, "brief", {**b, "text": text[:6000], "generated_at": _now()})


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def tick() -> None:
    """Every repo whose last check is older than REFRESH_S: check for new commits (called by the schedule loop)."""
    if not memory.store:
        return
    for p in await db.select("projects", {"select": "id,owner_id,repo_url"}):
        if not parse(p.get("repo_url")):
            continue
        item = await memory.store.aget(NS(p["id"]), "state")
        state = item.value if item else {}
        last = state.get("checked_at")
        if state.get("status") in ("reading", "checking"):
            continue
        if not last or (datetime.now(UTC) - datetime.fromisoformat(last)).total_seconds() > REFRESH_S:
            schedule(p["owner_id"], p["id"])


# ------------------------------------------------------------------ what teammates use
def search(project_id: str, query: str, limit: int = 12) -> str:
    """Files whose path or text mention the query's words, with the matching lines."""
    root = repo_dir(project_id)
    if not root.exists():
        return ""
    words = [w.lower() for w in re.findall(r"[\w.-]{3,}", query)][:6]
    if not words:
        return ""
    hits = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(root))
        text = p.read_text(errors="replace")
        low = text.lower()
        score = sum(low.count(w) + 5 * rel.lower().count(w) for w in words)
        if score:
            lines = [f"  {i + 1}: {ln.strip()[:160]}" for i, ln in enumerate(text.splitlines())
                     if any(w in ln.lower() for w in words)][:4]
            hits.append((score, rel, lines))
    hits.sort(key=lambda h: -h[0])
    return "\n".join(f"{rel}\n" + "\n".join(lines) for _, rel, lines in hits[:limit])


def read(project_id: str, path: str, max_chars: int = 12000) -> str | None:
    root = repo_dir(project_id)
    p = (root / path.lstrip("/")).resolve()
    if not p.is_relative_to(root.resolve()) or not p.is_file():
        return None
    text = p.read_text(errors="replace")
    return text if len(text) <= max_chars else text[:max_chars] + f"\n[... {len(text) - max_chars} more chars]"


async def edit_brief(project_id: str, text: str | None) -> None:
    """The user's own version of the brief (None: back to the generated one). Regenerating never overwrites it."""
    item = await memory.store.aget(NS(project_id), "brief")
    b = {**(item.value if item else {}), "edited": text}
    await _put(project_id, "brief", b)


async def add_note(project_id: str, text: str, by: str) -> None:
    item = await memory.store.aget(NS(project_id), "brief")
    b = item.value if item else {}
    notes = [*(b.get("notes") or []), {"text": text.strip()[:400], "by": by, "at": _now()}][-40:]
    await _put(project_id, "brief", {**b, "notes": notes})

