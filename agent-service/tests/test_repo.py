"""Repo knowledge: read a project's repo once, keep it current cheaply, and give teammates the brief and a search."""
import io
import tarfile
from pathlib import Path

from app import config, repo
from tests.conftest import OWNER, ai, settle


def test_only_source_files_are_kept_and_grouped_into_areas():
    assert repo.parse("https://github.com/acme/app.git") == ("acme", "app") and repo.parse("acme/app") == ("acme", "app")
    assert repo.keep("src/app.ts", 100) and repo.keep(".github/workflows/ci.yml", 100)
    assert not repo.keep("node_modules/x/index.js", 100) and not repo.keep("pnpm-lock.yaml", 100)
    assert not repo.keep("assets/logo.png", 100) and not repo.keep("src/big.json", repo.MAX_FILE + 1)
    areas = repo.areas_of(["README.md", "apps/web/a.ts", "apps/web/b.ts", "apps/api/c.py", "lib/d.py"])
    assert set(areas) == {"(root)", "apps/web", "apps/api", "lib"}
    assert repo.symbols("x.py", "def a():\n    pass\nclass B:\n") == ["a", "B"]
    assert repo.symbols("x.ts", "export async function load() {}\nexport const Thing = 1\n") == ["load", "Thing"]


def _tar(files: dict[str, str]) -> io.BytesIO:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"acme-app-abc123/{name}")
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    buf.seek(0)
    return buf


def test_extraction_drops_the_archive_prefix_binaries_and_escapes(tmp_path):
    dest = tmp_path / "repo"
    n = repo._extract(_tar({"src/a.py": "x = 1", "node_modules/m.js": "y", "../../evil.py": "z", "bin.dat": "a\0b"}), dest)
    assert n == 1 and (dest / "src/a.py").read_text() == "x = 1" and not (tmp_path / "evil.py").exists()


async def test_first_pass_writes_the_brief_and_later_passes_reread_only_what_changed(env, monkeypatch, tmp_path):
    fdb, fake = env
    monkeypatch.setattr(config, "WORKSPACES", tmp_path / "workspaces")
    fdb.tables.setdefault("projects", []).append({"id": "p1", "owner_id": OWNER, "name": "App", "repo_url": "https://github.com/acme/app"})
    code = {"README.md": "# App\nRun: npm start", "src/server.ts": "export function serve() {}", "lib/util.py": "def helper(): pass"}
    sha = {"now": "a" * 40}

    async def info(*_):
        return {"default_branch": "main", "private": True}

    async def head(*_):
        return sha["now"]

    async def download(owner_id, owner, name, ref, dest: Path):
        dest.mkdir(parents=True, exist_ok=True)
        for p, t in code.items():
            (dest / p).parent.mkdir(parents=True, exist_ok=True)
            (dest / p).write_text(t)
        return len(code)

    async def commits(*_):
        return [{"sha": "bbbbbbb", "message": "Add caching to util", "author": "Jay"}]

    monkeypatch.setattr(repo, "repo_info", info)
    monkeypatch.setattr(repo, "head", head)
    monkeypatch.setattr(repo, "download", download)
    monkeypatch.setattr(repo, "commits_since", commits)

    fake.script = [ai("Server entry: serve() in server.ts."), ai("Helpers."), ai("Root: README."), ai("## What it is\nAn app.")]
    await repo.index(OWNER, "p1")
    stored = await repo.get("p1")
    assert stored["state"]["status"] == "ready" and stored["state"]["files"] == 3
    assert repo.brief_text(stored).startswith("## What it is") and len(fake.calls) == 4

    # Same commit: nothing is re-read.
    await repo.index(OWNER, "p1")
    assert len(fake.calls) == 4

    # A new commit touching lib/ only: one area and the brief are redone, and the commits are logged.
    sha["now"] = "b" * 40
    code["lib/util.py"] = "def helper(): pass\ndef cache(): pass"
    fake.script = [ai("Helpers, now with cache()."), ai("## What it is\nAn app with caching.")]
    await repo.index(OWNER, "p1")
    stored = await repo.get("p1")
    assert len(fake.calls) == 6 and "cache()" in stored["areas"]["areas"]["lib"]["summary"]
    assert stored["log"]["entries"][0]["commits"][0]["message"] == "Add caching to util"

    # The user's edit wins over regeneration; team notes are appended.
    await repo.edit_brief("p1", "## Mine\nMy words.")
    await repo.add_note("p1", "Tests live next to the code.", "Dev")
    text = repo.brief_text(await repo.get("p1"))
    assert text.startswith("## Mine") and "Tests live next to the code. (Dev)" in text

    # Teammates can search the code and read a file; paths can't escape the repo.
    assert "lib/util.py" in repo.search("p1", "cache helper")
    assert "def cache" in repo.read("p1", "lib/util.py") and repo.read("p1", "../../etc/passwd") is None


async def test_picking_a_repo_from_the_app_starts_reading_it(api, env, monkeypatch, tmp_path):
    fdb, fake = env
    fdb.tables.setdefault("projects", []).append({"id": "p2", "owner_id": OWNER, "name": "X", "repo_url": None})
    started = []
    monkeypatch.setattr(repo, "schedule", lambda owner, pid, force=False: started.append((pid, force)))
    assert (await api.put("/projects/p2/repo", json={"repo": "not a repo"})).status_code == 400
    r = (await api.put("/projects/p2/repo", json={"repo": "acme/app"})).json()
    assert r["repo"] == "acme/app" and fdb.rows("projects")[0]["repo_url"] == "https://github.com/acme/app"
    assert started == [("p2", True)]
    await settle()


def test_errors_read_as_plain_words():
    assert "can't find acme/app" in repo._plain(RuntimeError('{"message":"Not Found","status":"404"}'), "acme/app")
    assert "isn't connected" in repo._plain(RuntimeError("404 No connected account found for user"), "acme/app")


def test_a_big_folder_splits_into_its_subfolders():
    paths = [f"app/src/components/c{i}.tsx" for i in range(30)] + [f"app/src/ui/u{i}.tsx" for i in range(25)] + ["app/package.json"]
    areas = repo.areas_of(paths)
    assert set(areas) == {"app/src/components", "app/src/ui", "app"} and areas["app"] == ["app/package.json"]
