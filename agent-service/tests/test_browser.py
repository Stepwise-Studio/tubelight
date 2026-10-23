"""The server browser's guardrails. The rules are plain functions; the rest runs a real Chromium (the tubelight-browser
image on local Docker) against a fake X with traps, and skips when that image isn't built."""
import asyncio
from pathlib import Path

import pytest

from app import browser as B

OWNER = "test-owner-browser"
FAKE_X = (Path(__file__).parent.parent / "evals" / "fake_x.html").read_text()


def test_commit_words():
    assert B.is_commit("button", "Post") and B.is_commit("button", "Continue") and B.is_commit("button", "Delete account")
    assert not B.is_commit("button", "Posts") and not B.is_commit("tab", "Likes") and not B.is_commit("button", "More")
    assert not B.is_commit("link", "Compose a post")  # links go somewhere; only clearly dangerous ones count
    assert B.is_commit("link", "Delete this post") and B.is_commit("link", "Log out")


def test_commit_keys():
    assert B.key_commits("ctrl+enter", "") and B.key_commits("Meta+Return", "search")
    assert B.key_commits("enter", "multi") and B.key_commits("enter", "input") and B.key_commits("space", "button")
    assert not B.key_commits("enter", "search") and not B.key_commits("page_down", "multi")


def test_sites():
    B.revoke(OWNER)
    assert not B.allowed(OWNER, "https://x.com/home")
    assert B.grant(OWNER, "https://www.X.com/home") == ["x.com"]
    assert B.allowed(OWNER, "https://x.com/i/flow/login") and B.allowed(OWNER, "https://mobile.twitter.com/")
    assert not B.allowed(OWNER, "https://evilx.com/") and not B.allowed(OWNER, "https://x.com.evil.test/")
    assert B.allowed(OWNER, "about:blank")
    B.revoke(OWNER)
    assert not B.allowed(OWNER, "https://x.com/")


needs_chromium = pytest.mark.skipif(not B.available(), reason="tubelight-browser image not built locally")


@needs_chromium
async def test_guardrails_on_a_real_page(tmp_path, monkeypatch):
    monkeypatch.setattr(B, "DATA", tmp_path / "browser")
    monkeypatch.setattr(B, "SHOTS", tmp_path / "shots")
    monkeypatch.setitem(B.FAKE, "x.test", FAKE_X)
    monkeypatch.setitem(B.FAKE, "evil.test", "<h1>gotcha</h1>")
    B.revoke(OWNER)
    try:
        with pytest.raises(PermissionError):  # no OK yet: not even loading the site
            await B.look(OWNER, "https://x.test/")
        B.grant(OWNER, "x.test")
        snap = await B.look(OWNER, "https://x.test/home")
        by = lambda s, name: next(e for e in s["elements"] if e["name"] == name)  # noqa: E731
        assert "Home" in B.text(snap) and "⚑" in B.text(snap)

        # Off-site link: refused before it loads, and the snapshot says so.
        got = await B.act(OWNER, snap["snapshot"], by(snap, "Claim your reward")["id"], "CLICK")
        assert "x.test" in got["url"] and "evil.test" in B.text(got)
        # A popup is closed.
        got = await B.act(OWNER, got["snapshot"], by(got, "Open in new tab")["id"], "CLICK")
        await asyncio.sleep(0.5)
        b = B._browsers[OWNER].tabs["main"]
        pages = [t for t in (await b.conn.call("Target.getTargets"))["targetInfos"] if t["type"] == "page"]
        assert len(pages) == 1

        got = await B.act(OWNER, got["snapshot"], by(got, "Compose a post")["id"], "CLICK")
        got = await B.act(OWNER, got["snapshot"], by(got, "Post text")["id"], "TYPE", "hello from the test")
        sid = got["snapshot"]
        for name in ("Post", "Continue", "Delete account", "➤"):  # named commits, a decoy, and an unnamed submit
            with pytest.raises(B.NeedsOK):
                await B.act(OWNER, sid, by(got, name)["id"], "CLICK")
        with pytest.raises(PermissionError):
            await B.act(OWNER, sid, by(got, "Confirm password")["id"], "TYPE", "hunter2")
        got = await B.act(OWNER, sid, by(got, "Post text")["id"], "CLICK")  # focus the editor
        with pytest.raises(B.NeedsOK):
            await B.keys(OWNER, ["ctrl+enter"])
        posted = await b.cdp("Runtime.evaluate", {"expression": "window.posted||0", "returnByValue": True})
        assert posted["result"]["value"] == 0

        # Commit: what they approve is what gets pressed; a change after the preview presses nothing.
        sid, post = got["snapshot"], by(got, "Post")["id"]
        with pytest.raises(PermissionError):
            await B.commit(OWNER, sid, post)  # never approved
        view = await B.preview(OWNER, {"snapshot": sid, "element": post, "what": "posts it"})
        assert view["site"] == "x.test" and view["button"] == "Post" and "hello from the test" in view["text"]
        assert B.shot_path(OWNER, view["image"].split("/")[-1].split("?")[0], int(view["image"].split("e=")[1].split("&")[0]),
                           view["image"].split("s=")[1])
        await b.cdp("Runtime.evaluate", {"expression": "document.getElementById('draft').innerText='something else'"})
        changed = await B.commit(OWNER, sid, post)
        assert changed["status"] == "changed"
        await b.cdp("Runtime.evaluate", {"expression": "document.getElementById('draft').innerText='hello from the test'"})
        view = await B.preview(OWNER, {"snapshot": sid, "element": post})
        done = await B.commit(OWNER, sid, post)
        assert done["status"] == "done" and "Your post was sent" in B.text(done)
        with pytest.raises(PermissionError):
            await B.commit(OWNER, sid, post)  # one approval, one press

        # Taken over: teammates wait.
        b.takeover = True
        with pytest.raises(B.Busy):
            await B.act(OWNER, done["snapshot"], by(done, "Post")["id"], "CLICK")
        b.takeover = False

        # read_page's incognito read sees the page without the user's grant mattering.
        title, txt = await B.read(OWNER, "https://x.test/home")
        assert title == "Home / X" and "shipping the new release" in txt
    finally:
        await B.stop(OWNER)


@needs_chromium
async def test_sign_ins_survive_a_restart(tmp_path, monkeypatch):
    """Closing the browser (Stop, idle, redeploy) keeps the profile's cookies and site data; sign out wipes them."""
    monkeypatch.setattr(B, "DATA", tmp_path / "browser")
    monkeypatch.setitem(B.FAKE, "keep.test", "<p>hi</p>")
    owner = OWNER + "-keep"

    async def stored() -> str:
        r = await B._browsers[owner].tabs["main"].cdp("Runtime.evaluate", {"expression": "document.cookie + '|' + localStorage.getItem('k')", "returnByValue": True})
        return r["result"]["value"]

    try:
        B.grant(owner, "keep.test")
        await B.look(owner, "https://keep.test/")
        await B._browsers[owner].tabs["main"].cdp("Runtime.evaluate", {"expression": "document.cookie='s=1; max-age=99999; path=/'; localStorage.setItem('k','v')"})
        await B.stop(owner)
        B.grant(owner, "keep.test")
        await B.look(owner, "https://keep.test/")
        assert await stored() == "s=1|v"
        await B.sign_out(owner)
        B.grant(owner, "keep.test")
        await B.look(owner, "https://keep.test/")
        assert await stored() == "|null"
    finally:
        await B.stop(owner)


@needs_chromium
async def test_teammates_work_in_parallel_tabs(tmp_path, monkeypatch):
    """Each teammate gets its own tab: pages, snapshots and typing don't cross; sign-ins are shared; a fourth waits."""
    monkeypatch.setattr(B, "DATA", tmp_path / "browser")
    form = "<input aria-label='Note'><p>{}</p>"
    for host in ("a.test", "b.test", "c.test"):
        monkeypatch.setitem(B.FAKE, host, form.format(host))
    owner = OWNER + "-tabs"
    B.grant(owner, "a.test", "b.test", "c.test")
    try:
        snaps = await asyncio.gather(*(B.look(owner, f"https://{k}.test/", tab=k, label=k.upper()) for k in "abc"))
        assert [s["url"] for s in snaps] == ["https://a.test/", "https://b.test/", "https://c.test/"]
        note = lambda s: next(e["id"] for e in s["elements"] if e["name"] == "Note")  # noqa: E731
        done = await asyncio.gather(*(B.act(owner, s["snapshot"], note(s), "TYPE", f"from {k}", tab=k) for k, s in zip("abc", snaps)))
        for k, d in zip("abc", done):
            assert d["status"] == "done" and f"from {k}" in B.text(d) and d["url"] == f"https://{k}.test/"
        b = B._browsers[owner]
        assert b.tabs["a"].cursor["did"] == "typing in “Note”" and b.tabs["a"].cursor["x"] > 0  # the live view's cursor
        await b.tabs["a"].cdp("Runtime.evaluate", {"expression": "document.cookie='who=me; max-age=999; path=/'"})
        await B.look(owner, "https://a.test/x", tab="b")  # b goes to a's site: same sign-ins
        r = await b.tabs["b"].cdp("Runtime.evaluate", {"expression": "document.cookie", "returnByValue": True})
        assert r["result"]["value"] == "who=me"
        with pytest.raises(B.Busy):  # three busy tabs: a fourth teammate waits
            await B.look(owner, "https://a.test/", tab="d")
        st = await B.state(owner)
        assert [t["label"] for t in st["tabs"]] == ["A", "B", "C"] and st["tab"] == "a"
    finally:
        await B.stop(owner)
