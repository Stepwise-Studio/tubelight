"""The server browser: one headless Chromium per user, in its own container (browser/Dockerfile), driven over CDP.
Teammates read and act on web pages the same way they work in apps on a linked computer (computer_use.py): a snapshot
of the page's accessibility tree, actions on element ids, refused when the page changed since.

Guardrails live here, in code, not in the prompt:
- No LAN: the container sits on the internal tl-browser network; its only exit is tl-egress-proxy (no private addresses).
- Sites: `browser_use` (one OK) lets teammates go to the sites named in it for GRANT_S; any other page the tab tries to
  load is refused before it loads (Fetch interception of the main frame). Popups are closed, downloads denied, file
  pickers never open.
- Commits: a click or key that would post, send, buy, delete, confirm or submit is refused by `act`/`keys`. It only
  happens through `commit`, after the user approved a preview (screenshot + the text on the page) and only if the page
  still shows exactly what they approved (fingerprint).
- Passwords: teammates never type into a password field. The user signs in themselves from the live view (takeover);
  while they hold the browser, teammates can't act in it.
- Reading for `read_page` happens in a throwaway incognito context: no cookies, so a link can't act as the user.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
import websockets

from . import config

log = logging.getLogger(__name__)
GRANT_S = 20 * 60
IDLE_S = 5 * 60
MAX_TABS = 3  # teammates working at once, each in its own tab (memory: ~150-250 MB a busy tab)
W, H = 412, 915  # a phone-sized page: mobile sites are lighter to read and fit the phone's live view
MAX_ELEMENTS = 220
CROP = 560  # height of the approval card's screenshot, in page pixels
DATA = config.WORKSPACES.parent / "browser"  # ~/tubelight/data/browser: the same path on the host and in the agent
UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36"
UA_META = {"brands": [{"brand": "Chromium", "version": "142"}, {"brand": "Google Chrome", "version": "142"},
                      {"brand": "Not_A Brand", "version": "99"}],
           "platform": "Android", "platformVersion": "14.0.0", "architecture": "", "model": "Pixel 8", "mobile": True}

CLICKABLE = {"button", "link", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option",
             "switch", "combobox", "treeitem", "disclosuretriangle", "togglebutton", "listboxoption", "popupbutton"}
TYPEABLE = {"textbox", "searchbox", "combobox", "textfield", "textarea"}
SHOWN = {"heading", "img", "image", "dialog", "alertdialog", "alert", "article", "status", "statictext", "paragraph",
         "cell", "columnheader", "rowheader", "listitem", "label", "progressbar", "slider", "spinbutton", "status"}
# What a click must not do without the user's OK. Buttons by their words; links only by the clearly dangerous ones
# (a link usually just goes somewhere: "Compose a post" opens the composer, it doesn't post).
COMMIT = re.compile(r"\b(post|tweet|reply|repost|retweet|quote|send|publish|share|submit|buy|pay|order|checkout|check out|"
                    r"purchase|subscribe|unsubscribe|donate|transfer|withdraw|delete|remove|deactivate|close account|"
                    r"confirm|approve|accept|agree|sign up|create account|register|follow|unfollow|like|block|mute|report|"
                    r"invite|book|reserve|upload|save|apply|continue|next|done|ok|yes|allow|authori[sz]e|grant)\b", re.I)
DANGEROUS_LINK = re.compile(r"\b(delete|remove|deactivate|unsubscribe|buy|pay|checkout|purchase|confirm|transfer|"
                            r"authori[sz]e|log ?out|sign ?out)\b", re.I)
COMMIT_KEYS = re.compile(r"^(ctrl|control|meta|cmd|mod)\+(enter|return)$", re.I)
LOGIN = re.compile(r"/(login|log-in|signin|sign-in|sign_in|i/flow/login|accounts/login|auth)\b|mode=login", re.I)


class Busy(RuntimeError):
    pass


class NeedsOK(RuntimeError):
    """The action would post, send, buy or similar: it needs `commit` and the user's approval."""


# ------------------------------------------------------------------ CDP over a websocket
class Conn:
    def __init__(self, ws) -> None:
        self.ws, self.n, self.waiting = ws, 0, {}
        self.handlers: list[Callable[[dict], Any]] = []
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if "id" in m:
                    fut = self.waiting.pop(m["id"], None)
                    if fut and not fut.done():
                        fut.set_result(m)
                    continue
                for h in list(self.handlers):
                    try:
                        r = h(m)
                        if asyncio.iscoroutine(r):
                            asyncio.create_task(r)
                    except Exception:
                        log.exception("browser event handler failed")
        except Exception as e:
            log.info("browser connection closed: %s", e)
        finally:
            for fut in self.waiting.values():
                if not fut.done():
                    fut.set_exception(ConnectionError("The browser closed."))

    @property
    def closed(self) -> bool:
        return self.reader.done()

    async def call(self, method: str, params: dict | None = None, session: str | None = None, timeout: float = 30) -> dict:
        self.n += 1
        n = self.n  # calls overlap (several tabs): each waits for its own id
        fut = asyncio.get_running_loop().create_future()
        self.waiting[n] = fut
        await self.ws.send(json.dumps({"id": n, "method": method, "params": params or {}, **({"sessionId": session} if session else {})}))
        try:
            m = await asyncio.wait_for(fut, timeout)
        finally:
            self.waiting.pop(n, None)
        if "error" in m:
            raise RuntimeError(f"{method}: {m['error'].get('message')}")
        return m.get("result") or {}


# ------------------------------------------------------------------ one browser per user
class Tab:
    """One teammate's tab: its own page, snapshots and element ids. Sign-ins are the browser's, shared by every tab."""

    def __init__(self, browser: "Browser", key: str, label: str, target: str, session: str) -> None:
        self.browser, self.key, self.label = browser, key, label
        self.owner_id, self.conn = browser.owner_id, browser.conn
        self.target, self.session = target, session
        self.lock = asyncio.Lock()
        self.used = time.time()
        self.takeover = False  # the user holds this tab from the live view
        self.loading = False
        self.blocked = ""  # the last page refused for being outside the allowed sites
        self.snaps: dict[str, dict] = {}
        self.ids: dict[int, str] = {}
        self.count = [0, 0]  # snapshots, element ids
        self.cursor: dict | None = None  # where the teammate last pointed and what it did there (the live view's cursor)

    async def cdp(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        self.used = self.browser.used = time.time()
        return await self.conn.call(method, params, self.session, timeout)


class Browser:
    def __init__(self, owner_id: str, container: Any, conn: Conn) -> None:
        self.owner_id, self.container, self.conn = owner_id, container, conn
        self.used = time.time()
        self.tabs: dict[str, Tab] = {}  # teammate id (or "you") -> its tab
        self.opening = asyncio.Lock()
        self.spare = ""  # the blank page Chromium starts with: the first tab takes it
        self.view = ""  # the tab the live view shows
        self.viewers: set[Any] = set()  # live-view websockets

    def by_session(self, session: str | None) -> Tab | None:
        return next((t for t in self.tabs.values() if t.session == session), None)


_browsers: dict[str, Browser] = {}
_grants: dict[str, dict[str, float]] = {}  # owner -> site -> until
_cleared: dict[tuple[str, str, str, str], tuple[str, float]] = {}  # (owner, tab, snapshot, element) -> (fingerprint, until)
_start = asyncio.Lock()
ready = False  # set at startup: the image is there and Docker answers
FAKE: dict[str, str] = {}  # host -> html: evals and tests serve pages without the network


def _docker():
    import docker

    return docker.from_env()


def available() -> bool:
    try:
        c = _docker()
        c.images.get(config.BROWSER_IMAGE)
        return True
    except Exception:
        return False


def _name(owner_id: str) -> str:
    return "tl-browser-" + re.sub(r"[^a-z0-9]", "", owner_id.lower())[:12]


def _run(owner_id: str) -> tuple[Any, str]:
    """Start the user's browser container; (container, its address for CDP)."""
    import docker

    client = _docker()
    try:
        client.containers.get(_name(owner_id)).remove(force=True)
    except docker.errors.NotFound:
        pass
    profile = DATA / owner_id
    profile.mkdir(parents=True, exist_ok=True)
    for lock in profile.glob("Singleton*"):  # left by the last container: Chromium would think another one has it
        lock.unlink(missing_ok=True)
    uid = int(config.SANDBOX_UID) if config.SANDBOX_UID else os.getuid()
    try:
        os.chown(profile, uid, uid)
    except OSError:
        pass
    args = ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
            "--no-default-browser-check", "--disable-sync", "--password-store=basic", "--disable-background-networking",
            "--disable-blink-features=AutomationControlled", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--lang=en-US", f"--window-size={W},{H}", f"--user-agent={UA}", "--user-data-dir=/profile", "about:blank"]
    if config.BROWSER_PROXY:
        args.insert(0, f"--proxy-server={config.BROWSER_PROXY}")
    c = client.containers.run(
        config.BROWSER_IMAGE, args, detach=True, name=_name(owner_id), hostname="tubelight-browser", user=f"{uid}:{uid}",
        mem_limit="1000m", nano_cpus=1_500_000_000, pids_limit=512, cap_drop=["ALL"], security_opt=["no-new-privileges"],
        read_only=True, tmpfs={"/tmp": "rw,size=256m,mode=1777"}, network=config.BROWSER_NETWORK or None,
        volumes={str(profile): {"bind": "/profile", "mode": "rw"}}, labels={"tubelight": "browser"},
    )
    c.reload()
    nets = c.attrs["NetworkSettings"]["Networks"]
    ip = (nets.get(config.BROWSER_NETWORK) or next(iter(nets.values()), {})).get("IPAddress", "")
    return c, ip


async def _ensure(owner_id: str) -> Browser:
    b = _browsers.get(owner_id)
    if b and not b.conn.closed:
        b.used = time.time()
        return b
    async with _start:
        b = _browsers.get(owner_id)
        if b and not b.conn.closed:
            return b
        if b:
            await _stop(owner_id)
        # ponytail: one browser at a time (the server has 3 GB); a busy one makes others wait, an idle one gives way.
        for other, ob in list(_browsers.items()):
            if time.time() - ob.used < 120:
                raise Busy("The browser is busy with another task. Try again in a couple of minutes.")
            await _stop(other)
        if not await asyncio.to_thread(available):
            raise Busy("The browser isn't installed on the server yet (docker build -t tubelight-browser agent-service/browser).")
        container, ip = await asyncio.to_thread(_run, owner_id)
        base = f"http://{ip}:9223"
        ws_url = ""
        async with httpx.AsyncClient() as http:
            for _ in range(60):
                try:
                    ws_url = (await http.get(f"{base}/json/version", timeout=2)).json()["webSocketDebuggerUrl"]
                    break
                except Exception:
                    await asyncio.sleep(0.5)
        if not ws_url:
            await asyncio.to_thread(container.remove, force=True)
            raise Busy("The browser didn't start. Try again.")
        ws = await websockets.connect(re.sub(r"^ws://[^/]+", f"ws://{ip}:9223", ws_url), max_size=None, ping_interval=None)
        b = Browser(owner_id, container, Conn(ws))
        b.conn.handlers.append(lambda m: _on_event(b, m))
        await b.conn.call("Browser.setDownloadBehavior", {"behavior": "deny"})
        await b.conn.call("Target.setDiscoverTargets", {"discover": True})
        pages = [t for t in (await b.conn.call("Target.getTargets"))["targetInfos"] if t["type"] == "page"]
        b.spare = pages[0]["targetId"] if pages else ""
        _browsers[owner_id] = b
        log.info("browser started for %s", owner_id)
        return b


async def _tab(owner_id: str, key: str = "main", label: str = "") -> Tab:
    """This teammate's tab, opened on first use. Up to MAX_TABS at once; a full browser gives up a tab idle for a
    minute, else asks the newcomer to wait."""
    b = await _ensure(owner_id)
    if t := b.tabs.get(key):
        t.label = label or t.label
        return t
    async with b.opening:
        if t := b.tabs.get(key):
            return t
        if len(b.tabs) >= MAX_TABS:
            idle = min(b.tabs.values(), key=lambda t: t.used)
            if time.time() - idle.used < 60 or idle.takeover or (b.viewers and idle.key == b.view):
                raise Busy(f"{MAX_TABS} teammates are using the browser right now. Try again in a few minutes.")
            await _close_tab(b, idle)
        target, b.spare = b.spare or (await b.conn.call("Target.createTarget", {"url": "about:blank"}))["targetId"], ""
        session = (await b.conn.call("Target.attachToTarget", {"targetId": target, "flatten": True}))["sessionId"]
        await _setup(b, session)
        await b.conn.call("Emulation.setFocusEmulationEnabled", {"enabled": True}, session)  # typing works in every tab
        t = b.tabs[key] = Tab(b, key, label or key, target, session)
        you = b.tabs.get("you")
        if b.view not in b.tabs or (b.view == "you" and you and not you.takeover):  # watching nothing yet: follow them
            await _cast(b, False)
            b.view = key
            await _cast(b, True)
        await _announce(b)
        return t


async def _close_tab(b: Browser, t: Tab) -> None:
    b.tabs.pop(t.key, None)
    try:
        await b.conn.call("Target.closeTarget", {"targetId": t.target})
    except Exception:
        pass
    if b.view == t.key:
        b.view = next(iter(b.tabs), "")
        await _cast(b, True)
    await _announce(b)


async def _setup(b: Any, session: str, guard: bool = True) -> None:
    c = lambda m, p=None: b.conn.call(m, p, session)  # noqa: E731
    await c("Page.enable")
    await c("Accessibility.enable")
    await c("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 2, "mobile": True})
    await c("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
    await c("Emulation.setUserAgentOverride", {"userAgent": UA, "acceptLanguage": "en-US,en", "platform": "Linux armv8l",
                                               "userAgentMetadata": UA_META})
    await c("Page.setInterceptFileChooserDialog", {"enabled": True})  # no uploads, ever: the picker never opens
    if guard:
        await c("Fetch.enable", {"patterns": [{"resourceType": "Document", "requestStage": "Request"}]})


def _on_event(b: Browser, m: dict) -> Any:
    method, p, session = m.get("method"), m.get("params") or {}, m.get("sessionId")
    if method == "Target.targetCreated":
        t = p["targetInfo"]
        if t["type"] == "page" and t.get("openerId"):  # a popup or a new tab: never; links open in the same tab
            return b.conn.call("Target.closeTarget", {"targetId": t["targetId"]})
    if method == "Target.targetDestroyed":  # a crashed or closed tab: its teammate gets a fresh one next time
        for t in [t for t in b.tabs.values() if t.target == p.get("targetId")]:
            b.tabs.pop(t.key, None)
    if method == "Fetch.requestPaused":
        return _guard(b, session, p)
    t = b.by_session(session)
    if t is None:
        return None
    if method == "Page.frameStartedLoading" and p.get("frameId") == t.target:
        t.loading = True
    elif method in ("Page.frameStoppedLoading", "Page.loadEventFired") and p.get("frameId", t.target) == t.target:
        t.loading = False
    elif method == "Page.screencastFrame":
        return _frame(b, t, p)
    return None


async def _guard(b: Browser, session: str | None, p: dict) -> None:
    """Every page load in a browser tab: the allowed sites go on, the rest are refused before they load."""
    url = p["request"]["url"]
    host = urlparse(url).hostname or ""
    rid = p["requestId"]
    try:
        t = b.by_session(session)
        if t is None or p.get("frameId") != t.target or t.takeover or allowed(b.owner_id, url):
            if host in FAKE:
                body = base64.b64encode(FAKE[host].encode()).decode()
                await b.conn.call("Fetch.fulfillRequest", {"requestId": rid, "responseCode": 200, "body": body, "responseHeaders": [
                    {"name": "Content-Type", "value": "text/html; charset=utf-8"}]}, session)
            else:
                await b.conn.call("Fetch.continueRequest", {"requestId": rid}, session)
        else:
            t.blocked = url
            await b.conn.call("Fetch.failRequest", {"requestId": rid, "errorReason": "BlockedByClient"}, session)
    except Exception as e:
        log.debug("guard: %s", e)


# ------------------------------------------------------------------ sites
def site_of(s: str) -> str:
    s = s.strip().lower()
    host = urlparse(s if "://" in s else f"https://{s}").hostname or ""
    return host.removeprefix("www.")


ALIASES = {"twitter.com": "x.com", "x.com": "twitter.com"}


def grant(owner_id: str, *sites: str) -> list[str]:
    g = _grants.setdefault(owner_id, {})
    out = []
    for s in sites:
        if site := site_of(s):
            for one in {site, ALIASES.get(site, site)}:
                g[one] = time.time() + GRANT_S
            out.append(site)
    return out


def granted(owner_id: str) -> list[str]:
    now = time.time()
    return sorted(s for s, until in (_grants.get(owner_id) or {}).items() if until > now)


def allowed(owner_id: str, url: str) -> bool:
    if url.startswith(("about:", "data:", "blob:", "chrome-error:")):
        return True
    host = (urlparse(url).hostname or "").lower()
    return any(host == s or host.endswith("." + s) for s in granted(owner_id))


def revoke(owner_id: str) -> None:
    _grants.pop(owner_id, None)
    for k in [k for k in _cleared if k[0] == owner_id]:
        _cleared.pop(k, None)


# ------------------------------------------------------------------ reading the page
async def _url(b: Tab) -> tuple[str, str]:
    r = await b.cdp("Runtime.evaluate", {"expression": "[location.href, document.title]", "returnByValue": True})
    href, title = (r.get("result") or {}).get("value") or ["", ""]
    return href, title


async def settle(b: Tab, most: float = 10) -> None:
    await asyncio.sleep(0.35)
    end = time.time() + most
    while b.loading and time.time() < end:
        await asyncio.sleep(0.2)
    await asyncio.sleep(0.6)  # single-page apps keep drawing after load
    if b.blocked and (await _url(b))[0].startswith("chrome-error"):  # a refused page: back to where it was
        h = await b.cdp("Page.getNavigationHistory")
        if h["currentIndex"] > 0:
            b.loading = True
            await b.cdp("Page.navigateToHistoryEntry", {"entryId": h["entries"][h["currentIndex"] - 1]["id"]})
            await settle(b, most)


def _prop(n: dict, key: str) -> Any:
    return next(((p.get("value") or {}).get("value") for p in n.get("properties") or [] if p.get("name") == key), None)


async def snapshot(b: Tab) -> dict:
    for _ in range(8):  # a page still drawing (a slow server, a heavy app): wait until it shows something
        nodes = (await b.cdp("Accessibility.getFullAXTree"))["nodes"]
        if sum(1 for n in nodes if not n.get("ignored") and n.get("backendDOMNodeId")) > 8:
            break
        await asyncio.sleep(1)
    by_id = {n["nodeId"]: n for n in nodes}
    elements: list[dict] = []
    login = False

    def visit(nid: str, depth: int, parent: str) -> None:
        n = by_id.get(nid)
        if n is None or len(elements) >= MAX_ELEMENTS:
            return
        role = str((n.get("role") or {}).get("value") or "").lower()
        name = " ".join(str((n.get("name") or {}).get("value") or "").split())[:160]
        shown = not n.get("ignored")
        here = parent
        if shown and role not in ("rootwebarea", "webarea", "none", "generic", "inlinetextbox", "linebreak", "group", "section"):
            disabled = bool(_prop(n, "disabled"))
            editable = role in TYPEABLE or bool(_prop(n, "editable"))
            acts = [] if disabled or not n.get("backendDOMNodeId") else (
                ["TYPE"] if editable else ["CLICK"] if role in CLICKABLE else [])
            if editable and role in ("combobox",) and "CLICK" not in acts:
                acts.append("CLICK")
            value = str((n.get("value") or {}).get("value") or "")[:200]
            keep = acts or value or (name and role in SHOWN and name != parent)
            if keep:
                bid = n.get("backendDOMNodeId") or 0
                eid = b.ids.get(bid)
                if not eid:
                    b.count[1] += 1
                    eid = b.ids[bid] = f"e{b.count[1]}"
                e = {"id": eid, "backend": bid, "role": role, "name": name, "value": value, "actions": acts,
                     "depth": depth, "focused": bool(_prop(n, "focused")), "multiline": bool(_prop(n, "multiline"))}
                if acts == ["CLICK"]:
                    e["commit"] = is_commit(role, name)
                elements.append(e)
                here = name or parent
                depth += 1
        for c in n.get("childIds") or []:
            visit(c, depth, here)

    if nodes:
        visit(nodes[0]["nodeId"], 0, "")
    url, title = await _url(b)
    pw = await b.cdp("Runtime.evaluate", {"expression": "(() => { const v = e => e.offsetParent !== null; const pw = [...document.querySelectorAll('input[type=password]')].some(v);"
                                                    " return pw && [...document.querySelectorAll('input')].some(e => v(e) && (e.type === 'email' || /username|email|tel/.test(e.autocomplete)"
                                                    " || /user|mail|login|phone/i.test(e.name + e.id))) })()", "returnByValue": True})
    # ponytail: a sign-in page = a login address, or a password box next to a username/email box
    login = bool(LOGIN.search("/" + url.split("://", 1)[-1].partition("/")[2])) or bool((pw.get("result") or {}).get("value"))
    b.count[0] += 1
    sid = f"b{b.count[0]}"
    b.snaps[sid] = {"url": url, "elements": {e["id"]: e for e in elements}, "at": time.time()}
    for old in list(b.snaps)[:-20]:
        b.snaps.pop(old, None)
    blocked, b.blocked = b.blocked, ""
    return {"snapshot": sid, "url": url, "title": title, "elements": elements, "login": login, "blocked": blocked,
            "truncated": len(elements) >= MAX_ELEMENTS}


def is_commit(role: str, name: str) -> bool:
    if role == "link":
        return bool(DANGEROUS_LINK.search(name))
    return bool(COMMIT.search(name))


def text(snap: dict) -> str:
    """A snapshot as a teammate reads it: one line per element, the format computer_look uses."""
    lines = [f"Snapshot {snap['snapshot']}: {snap['title'] or '(untitled)'} · {snap['url']}"]
    if snap.get("blocked"):
        lines.append(f"(Refused {snap['blocked']}: not one of the sites they allowed. Ask with browser_use to add it.)")
    base = min((e["depth"] for e in snap["elements"]), default=0)
    for e in snap["elements"]:
        bits = [f"[{e['id']}]", e["role"]]
        if e["name"]:
            bits.append(f"“{e['name']}”")
        if e["value"]:
            bits.append(f"= {e['value'][:80]!r}" + ("…" if len(e["value"]) > 80 else ""))
        if e["actions"]:
            bits.append("(" + ", ".join(a.lower() for a in e["actions"]) + ")")
        if e.get("commit"):
            bits.append("⚑ needs their OK: browser_commit")
        if e["focused"]:
            bits.append("*focused*")
        lines.append("  " * min(e["depth"] - base, 8) + " ".join(bits))
    if snap.get("truncated"):
        lines.append(f"(only the first {MAX_ELEMENTS} elements; scroll with KEYS page_down to see more)")
    if snap.get("login"):
        lines.append("This is a sign-in page. Never type a password or a code, and never ask for one in chat: call "
                     "browser_signin with this site, and they sign in themselves.")
    return "\n".join(lines)


# ------------------------------------------------------------------ acting
async def _check(b: Tab, sid: str, element: str) -> tuple[dict | None, dict]:
    """(a fresh snapshot if the page moved on, else None; the element)."""
    if b.takeover:
        raise Busy("They're using the browser themselves right now. Wait for them, then look again.")
    snap = b.snaps.get(sid)
    if not snap:
        raise LookupError(f"Snapshot {sid} is gone; look again.")
    e = snap["elements"].get(element)
    if not e:
        raise LookupError(f"No element {element} in snapshot {sid}.")
    url, _ = await _url(b)
    if url != snap["url"]:
        return {"status": "changed", "why": f"the page changed (now {url})", **await snapshot(b)}, e
    try:
        part = (await b.cdp("Accessibility.getPartialAXTree", {"backendNodeId": e["backend"], "fetchRelatives": False}))["nodes"]
        n = next((x for x in part if not x.get("ignored")), part[0] if part else {})
        name = " ".join(str((n.get("name") or {}).get("value") or "").split())[:160]
        if str((n.get("role") or {}).get("value") or "").lower() != e["role"] or name != e["name"]:
            raise LookupError
    except Exception:
        return {"status": "stale", "why": "that element changed or is gone", **await snapshot(b)}, e
    return None, e


def _may_act(b: Tab, url: str) -> None:
    if not allowed(b.owner_id, url):
        raise PermissionError(f"Ask first: call browser_use with {site_of(url) or 'the site'} and the task; they OK it once.")


async def _obj(b: Tab, e: dict) -> str:
    return (await b.cdp("DOM.resolveNode", {"backendNodeId": e["backend"]}))["object"]["objectId"]


async def _js(b: Tab, e: dict, fn: str) -> Any:
    r = await b.cdp("Runtime.callFunctionOn", {"objectId": await _obj(b, e), "functionDeclaration": fn, "returnByValue": True})
    return (r.get("result") or {}).get("value")


async def _submits(b: Tab, e: dict) -> bool:
    """A button that submits a form, whatever it's called (an unnamed arrow can post too)."""
    return bool(await _js(b, e, "function(){const t=(this.getAttribute('type')||'').toLowerCase();"
                                "return !!(this.form && (t==='submit' || (this.tagName==='BUTTON' && !t) || t==='image'))}"))


async def _point(b: Tab, e: dict | None, did: str) -> tuple[float, float] | None:
    """Move the teammate's cursor to an element (its centre, after scrolling it into view) and say what it's doing.
    While a phone watches this tab, wait a beat so the cursor visibly arrives before the click lands."""
    at = None
    if e is not None:
        await b.cdp("DOM.scrollIntoViewIfNeeded", {"backendNodeId": e["backend"]})
        quads = (await b.cdp("DOM.getContentQuads", {"backendNodeId": e["backend"]}))["quads"]
        if quads:
            at = (sum(quads[0][0::2]) / 4, sum(quads[0][1::2]) / 4)
    if at:  # page pixels -> the screen the phone sees (a desktop-width page is shown zoomed out)
        vv = (await b.cdp("Page.getLayoutMetrics"))["cssVisualViewport"]
        sx, sy = (at[0] - vv["offsetX"]) * vv["scale"], (at[1] - vv["offsetY"]) * vv["scale"]
    else:
        sx, sy = (b.cursor or {}).get("x", W / 2), (b.cursor or {}).get("y", H / 3)
    b.cursor = {"x": round(sx, 1), "y": round(sy, 1), "did": did[:80], "at": time.time()}
    br = b.browser
    if br.viewers and br.view == b.key:
        msg = json.dumps({"t": "cursor", "key": b.key, **b.cursor})
        for ws in list(br.viewers):
            try:
                await ws.send_text(msg)
            except Exception:
                br.viewers.discard(ws)
        await asyncio.sleep(0.35)
    return at


async def _click(b: Tab, e: dict, did: str = "") -> None:
    at = await _point(b, e, did or f"clicking “{e['name'] or e['role']}”")
    if at is None:
        await _js(b, e, "function(){this.click()}")
        return
    for kind in ("mousePressed", "mouseReleased"):
        await b.cdp("Input.dispatchMouseEvent", {"type": kind, "x": at[0], "y": at[1], "button": "left", "clickCount": 1})


async def act(owner_id: str, sid: str, element: str, action: str, value: str = "", tab: str = "main") -> dict:
    """Do one thing to one element of a snapshot: CLICK, TYPE (replaces the text) or READ. Returns done | changed |
    stale and a fresh snapshot. Commits raise NeedsOK; password fields refuse."""
    b = await _tab(owner_id, tab)
    async with b.lock:
        moved, e = await _check(b, sid, element)
        if moved:
            return moved
        action = action.upper()
        if action != "READ":
            _may_act(b, (b.snaps.get(sid) or {}).get("url", ""))
        if action == "CLICK":
            if e.get("commit") or await _submits(b, e):
                raise NeedsOK(f"“{e['name'] or e['role']}” would submit or commit something. Use browser_commit with "
                              f"snapshot {sid} and element {element}: they see the screen and approve it.")
            await _click(b, e)
            did = f"clicked {e['role']} “{e['name']}”"
        elif action == "TYPE":
            if await _js(b, e, "function(){return (this.type||'').toLowerCase()==='password' || this.autocomplete==='one-time-code'}"):
                raise PermissionError("That's a password or code field: teammates never type those, and never ask for "
                                      "them in chat. Call browser_signin: they sign in themselves.")
            await _point(b, e, f"typing in “{e['name'] or e['role']}”")
            await b.cdp("DOM.focus", {"backendNodeId": e["backend"]})
            await _js(b, e, "function(){if(this.select){this.select()}else{const r=document.createRange();"
                            "r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r)}}")
            if value:
                await b.cdp("Input.insertText", {"text": value})
            else:
                await _key(b, "Delete")
            did = f"typed into {e['role']} “{e['name']}”"
        elif action == "READ":
            await _point(b, e, f"reading “{e['name'] or e['role']}”")
            got = await _js(b, e, "function(){return (this.innerText||this.value||'').slice(0,12000)}")
            return {"status": "done", "did": str(got or e["name"]), **await snapshot(b)}
        else:
            raise ValueError("action is CLICK, TYPE or READ (keys: browser_keys)")
        await settle(b)
        return {"status": "done", "did": did, **await snapshot(b)}


KEYS = {"enter": ("Enter", 13, "\r"), "return": ("Enter", 13, "\r"), "tab": ("Tab", 9, ""), "escape": ("Escape", 27, ""),
        "esc": ("Escape", 27, ""), "backspace": ("Backspace", 8, ""), "delete": ("Delete", 46, ""), "up": ("ArrowUp", 38, ""),
        "down": ("ArrowDown", 40, ""), "left": ("ArrowLeft", 37, ""), "right": ("ArrowRight", 39, ""), "home": ("Home", 36, ""),
        "end": ("End", 35, ""), "page_down": ("PageDown", 34, ""), "pagedown": ("PageDown", 34, ""), "page_up": ("PageUp", 33, ""),
        "pageup": ("PageUp", 33, ""), "space": (" ", 32, " ")}
MODS = {"alt": 1, "ctrl": 2, "control": 2, "meta": 4, "cmd": 4, "mod": 2, "shift": 8}


async def _key(b: Tab, combo: str) -> None:
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    mods = sum(MODS.get(p, 0) for p in parts[:-1])
    last = parts[-1] if parts else ""
    if last in KEYS:
        key, code, txt = KEYS[last]
    elif len(last) == 1:
        key, code, txt = last, ord(last.upper()), "" if mods & 6 else last
    else:
        key, code, txt = last.capitalize(), 0, ""
    base = {"key": key, "windowsVirtualKeyCode": code, "modifiers": mods, "code": key}
    await b.cdp("Input.dispatchKeyEvent", {"type": "keyDown" if txt else "rawKeyDown", **base, **({"text": txt} if txt else {})})
    await b.cdp("Input.dispatchKeyEvent", {"type": "keyUp", **base})


async def _focus_kind(b: Tab) -> str:
    r = await b.cdp("Runtime.evaluate", {"returnByValue": True, "expression": """(()=>{const a=document.activeElement;
      if(!a||a===document.body) return '';
      if(a.isContentEditable||a.tagName==='TEXTAREA') return 'multi';
      if(a.tagName==='INPUT'){const t=(a.type||'').toLowerCase(), r=a.getAttribute('role')||'';
        if(t==='search'||r==='searchbox'||r==='combobox'||(a.form&&a.form.getAttribute('role')==='search')) return 'search';
        return 'input'}
      if(a.tagName==='BUTTON'||a.getAttribute('role')==='button') return 'button';
      return ''})()"""})
    return str((r.get("result") or {}).get("value") or "")


def key_commits(combo: str, focus: str) -> bool:
    """Would this key send or submit? Ctrl/Cmd+Enter always (it posts in most composers); Enter or Space unless the
    focus is a search box or nothing typed-into."""
    c = combo.strip().lower().replace(" ", "")
    if COMMIT_KEYS.match(c):
        return True
    if c in ("enter", "return"):
        return focus in ("multi", "input", "button")
    if c == "space":
        return focus == "button"
    return False


async def keys(owner_id: str, sequence: list[str], tab: str = "main") -> dict:
    b = await _tab(owner_id, tab)
    async with b.lock:
        if b.takeover:
            raise Busy("They're using the browser themselves right now. Wait for them, then look again.")
        _may_act(b, (await _url(b))[0])
        for combo in sequence[:8]:
            if key_commits(combo, await _focus_kind(b)):
                raise NeedsOK(f"“{combo}” here would send or submit. Click the page's own button through browser_commit "
                              "instead, so they can approve it.")
            await _point(b, None, f"pressing {combo.replace('_', ' ')}")
            await _key(b, combo)
        await settle(b)
        return {"status": "done", "did": "pressed " + ", ".join(sequence[:8]), **await snapshot(b)}


async def look(owner_id: str, url: str = "", tab: str = "main", label: str = "") -> dict:
    b = await _tab(owner_id, tab, label)
    async with b.lock:
        if url:
            if b.takeover:
                raise Busy("They're using the browser themselves right now. Wait for them, then look again.")
            await goto(b, url)
        return await snapshot(b)


async def goto(b: Tab, url: str) -> None:
    if not re.match(r"https?://", url):
        url = "https://" + url
    if not allowed(b.owner_id, url):
        sites = ", ".join(granted(b.owner_id)) or "none yet"
        raise PermissionError(f"{site_of(url)} isn't one of the sites they allowed ({sites}). Ask with browser_use.")
    await _point(b, None, f"opening {site_of(url)}")
    b.loading = True
    r = await b.cdp("Page.navigate", {"url": url}, timeout=40)
    if r.get("errorText"):
        b.loading = False
        raise RuntimeError(f"Couldn't open {url}: {r['errorText']}")
    await settle(b, 20)


# ------------------------------------------------------------------ commits: a preview the user approves, then the click
def _fp(url: str, e: dict, texts: list[str]) -> str:
    return hashlib.sha256(json.dumps([site_of(url), e["role"], e["name"], texts]).encode()).hexdigest()


async def _typed(b: Tab) -> list[str]:
    """What's typed on the page (fields and editors, never passwords): the content the user approves."""
    r = await b.cdp("Runtime.evaluate", {"returnByValue": True, "expression": """[...document.querySelectorAll(
      'textarea, input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), [contenteditable=""], [contenteditable=true]')]
      .map(e => (e.isContentEditable ? e.innerText : e.value || '').trim()).filter(Boolean)"""})
    return [str(t)[:4000] for t in (r.get("result") or {}).get("value") or []]


SHOTS = DATA.parent / "browser-shots"


async def preview(owner_id: str, args: dict, tab: str = "main") -> dict:
    """For the approval card: the screen as it is, the button and the text. Remembers a fingerprint of exactly this, so
    `commit` clicks only if the page still shows it."""
    br = _browsers.get(owner_id)
    b = br.tabs.get(tab) if br else None
    if b is None:
        raise LookupError("no browser tab")
    sid, element = str(args.get("snapshot", "")), str(args.get("element", ""))
    async with b.lock:
        moved, e = await _check(b, sid, element)
        if moved:
            raise LookupError("the page moved on")
        url, _ = await _url(b)
        texts = await _typed(b)
        await b.cdp("DOM.scrollIntoViewIfNeeded", {"backendNodeId": e["backend"]})
        # The part of the screen around the button (what's being sent sits above it), not a thin full-height page.
        quads = (await b.cdp("DOM.getContentQuads", {"backendNodeId": e["backend"]}))["quads"]
        cy = sum(quads[0][1::2]) / 4 if quads else H / 2
        view = (await b.cdp("Page.getLayoutMetrics"))["cssVisualViewport"]
        top = min(max(0.0, cy - 400), H - CROP)
        shot = (await b.cdp("Page.captureScreenshot", {"format": "jpeg", "quality": 75, "clip": {
            "x": view["pageX"], "y": view["pageY"] + top, "width": W, "height": CROP, "scale": 1}}))["data"]
    key = uuid.uuid4().hex
    (SHOTS / owner_id).mkdir(parents=True, exist_ok=True)
    (SHOTS / owner_id / f"{key}.jpg").write_bytes(base64.b64decode(shot))
    _cleared[(owner_id, tab, sid, element)] = (_fp(url, e, texts), time.time() + 15 * 60)
    return {"site": site_of(url), "button": e["name"] or e["role"], "text": "\n\n".join(texts)[:2000],
            "what": str(args.get("what") or "")[:200], "image": shot_link(owner_id, key)}


async def commit(owner_id: str, sid: str, element: str, tab: str = "main") -> dict:
    fp, until = _cleared.pop((owner_id, tab, sid, element), ("", 0))
    if not fp or until < time.time():
        raise PermissionError("This wasn't approved (or the approval expired). Call browser_commit again; they'll see it.")
    b = await _tab(owner_id, tab)
    async with b.lock:
        moved, e = await _check(b, sid, element)
        url, _ = await _url(b)
        if moved or _fp(url, e, await _typed(b)) != fp:
            return {"status": "changed", "why": "the page changed after they approved it, so nothing was clicked; "
                                                "call browser_commit again if it's still wanted", **(moved or await snapshot(b))}
        await _click(b, e, f"pressing “{e['name'] or e['role']}” (you approved it)")
        await settle(b)
        return {"status": "done", "did": f"clicked {e['role']} “{e['name']}” (approved)", **await snapshot(b)}


def _sig(owner_id: str, key: str, exp: int) -> str:
    secret = hashlib.sha256(b"browser-shot:" + (config.SUPABASE_SERVICE_ROLE_KEY or "dev").encode()).digest()
    return hmac.new(secret, f"{owner_id}:{key}:{exp}".encode(), "sha256").hexdigest()[:32]


def shot_link(owner_id: str, key: str) -> str:
    exp = int(time.time()) + 7 * 86400
    return f"/browser/shot/{owner_id}/{key}?e={exp}&s={_sig(owner_id, key, exp)}"


def shot_path(owner_id: str, key: str, exp: int, sig: str) -> Path | None:
    if not re.fullmatch(r"[0-9a-f]{32}", key) or exp < time.time() or not hmac.compare_digest(_sig(owner_id, key, exp), sig):
        return None
    p = SHOTS / owner_id / f"{key}.jpg"
    return p if p.is_file() else None


# ------------------------------------------------------------------ read_page's fallback: an incognito tab, no cookies
async def read(owner_id: str, url: str, budget: float = 25) -> tuple[str, str]:
    """(title, text) of a page that needs a real browser (scripts, or sites that turn away fetchers)."""
    b: Any = await _ensure(owner_id)
    ctx = (await b.conn.call("Target.createBrowserContext", {"disposeOnDetach": True}))["browserContextId"]
    try:
        tid = (await b.conn.call("Target.createTarget", {"url": "about:blank", "browserContextId": ctx}))["targetId"]
        s = (await b.conn.call("Target.attachToTarget", {"targetId": tid, "flatten": True}))["sessionId"]
        await _setup(b, s, guard=bool(FAKE))
        await b.conn.call("Page.navigate", {"url": url}, s, timeout=budget)
        got = ""
        for _ in range(int(budget / 1.5)):  # until the text stops growing
            await asyncio.sleep(1.5)
            r = await b.conn.call("Runtime.evaluate", {"expression": "[document.title, document.body ? document.body.innerText : '']",
                                                       "returnByValue": True}, s)
            title, now = (r.get("result") or {}).get("value") or ["", ""]
            if now and len(now) == len(got):
                break
            got = now
        return title, got
    finally:
        try:
            await b.conn.call("Target.disposeBrowserContext", {"browserContextId": ctx})
        except Exception:
            pass


# ------------------------------------------------------------------ sign-in: the user's own hands, in a teammate's tab
SIGNIN = {"x.com": "https://x.com/i/flow/login", "twitter.com": "https://x.com/i/flow/login",
          "instagram.com": "https://www.instagram.com/accounts/login/", "linkedin.com": "https://www.linkedin.com/login",
          "facebook.com": "https://www.facebook.com/login", "github.com": "https://github.com/login",
          "reddit.com": "https://www.reddit.com/login/", "threads.net": "https://www.threads.net/login"}


async def open_signin(owner_id: str, tab: str, label: str, site: str, url: str = "") -> None:
    """Open the site's sign-in page in the teammate's tab (the card's Sign in button lands the user on it)."""
    grant(owner_id, site)
    t = await _tab(owner_id, tab, label)
    async with t.lock:
        await goto(t, url if url and allowed(owner_id, url) else SIGNIN.get(site) or f"https://{site}/login")
    b = _browsers[owner_id]
    if b.view != tab:
        await _cast(b, False)
        b.view = tab
        await _cast(b, True)
        await _announce(b)


# ------------------------------------------------------------------ live view (the phone watches, or takes over)
async def _frame(b: Browser, t: Tab, p: dict) -> None:
    await b.conn.call("Page.screencastFrameAck", {"sessionId": p["sessionId"]}, t.session)
    if t.key != b.view:
        return
    msg = json.dumps({"t": "frame", "data": p["data"]})
    for ws in list(b.viewers):
        try:
            await ws.send_text(msg)
        except Exception:
            b.viewers.discard(ws)


async def _cast(b: Browser, on: bool) -> None:
    """Stream the viewed tab to the phones watching (or stop)."""
    t = b.tabs.get(b.view)
    if t is None or (on and not b.viewers):
        return
    try:
        await t.cdp("Page.startScreencast" if on else "Page.stopScreencast",
                    {"format": "jpeg", "quality": 60, "maxWidth": W * 2, "maxHeight": H * 2} if on else None)
    except Exception:
        pass


async def _announce(b: Browser) -> None:
    if b.viewers:
        msg = json.dumps({"t": "state", **await state(b.owner_id)})
        for ws in list(b.viewers):
            try:
                await ws.send_text(msg)
            except Exception:
                b.viewers.discard(ws)


async def state(owner_id: str) -> dict:
    b = _browsers.get(owner_id)
    running = bool(b and not b.conn.closed)
    t = b.tabs.get(b.view) if b and running else None
    out = {"running": running, "sites": granted(owner_id), "takeover": bool(t and t.takeover), "available": True,
           "url": "", "title": "", "tab": t.key if t else "", "cursor": t.cursor if t and not t.takeover else None, "tabs": [{"key": x.key, "label": x.label} for x in b.tabs.values()] if running else []}
    if t:
        try:
            out["url"], out["title"] = await _url(t)
        except Exception:
            pass
    return out


async def watch(owner_id: str, ws: Any) -> None:
    """One phone watching a tab: frames out; taps, typing, scrolls, back and go in (only while it holds that tab).
    `tab` switches which teammate's tab it shows."""
    b = await _ensure(owner_id)
    if not b.tabs:
        await _tab(owner_id, "you", "You")
    b.viewers.add(ws)
    if len(b.viewers) == 1:
        await _cast(b, True)
    await ws.send_text(json.dumps({"t": "state", **await state(owner_id)}))
    try:
        while True:
            m = json.loads(await ws.receive_text())
            b.used = time.time()
            kind, t = m.get("t"), b.tabs.get(b.view)
            if kind == "tab" and m.get("key") in b.tabs and m["key"] != b.view:
                await _cast(b, False)
                if t:
                    t.takeover = False
                b.view = m["key"]
                await _cast(b, True)
            elif kind == "signin":  # from a Sign in card: that teammate's tab on the site's sign-in page, in their hands
                key, site = str(m.get("key") or "you"), site_of(str(m.get("site") or ""))
                t = b.tabs.get(key)
                if site and (t is None or site not in (await _url(t))[0]):
                    await open_signin(owner_id, key, str(m.get("label") or key), site)
                if key in b.tabs and b.view != key:
                    await _cast(b, False)
                    b.view = key
                    await _cast(b, True)
                if t := b.tabs.get(key):
                    t.takeover = True
            elif kind == "takeover" and t:
                t.takeover = bool(m.get("on"))
            elif kind == "stop":
                revoke(owner_id)
            elif t and t.takeover:
                if focus := await _user_input(t, m):
                    await ws.send_text(json.dumps({"t": "focus", **focus}))
            if kind in ("takeover", "stop", "go", "back", "tab", "signin"):
                await ws.send_text(json.dumps({"t": "state", **await state(owner_id)}))
    finally:
        b.viewers.discard(ws)
        if not b.viewers and not b.conn.closed:
            for t in b.tabs.values():
                t.takeover = False
            await _cast(b, False)


FOCUS = """(() => { const a = document.activeElement; if (!a || a === document.body) return {kind: 'none', label: ''};
  const t = (a.type || '').toLowerCase(), ac = (a.autocomplete || '').toLowerCase();
  const field = a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' &&
    !['button', 'submit', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset'].includes(t));
  if (!field) return {kind: 'none', label: ''};
  const kind = t === 'password' ? 'password' : ac.includes('one-time-code') ? 'otp' : t === 'email' || ac.includes('email') ? 'email'
    : ac.includes('username') || /user|login|phone|mail/i.test(a.name + ' ' + a.id) ? 'username' : t === 'tel' ? 'tel' : 'text';
  const label = a.getAttribute('aria-label') || a.placeholder || (a.labels && a.labels[0] && a.labels[0].innerText) || a.name || '';
  const r = a.getBoundingClientRect(), v = window.visualViewport || {offsetTop: 0, scale: 1};
  return {kind, label: label.trim().slice(0, 40), y: Math.round((r.top + r.height / 2 - v.offsetTop) * v.scale)} })()"""


async def _user_input(b: Tab, m: dict) -> dict | None:
    """The user's own hands on the page: no site limits, no commit checks (it's them). A tap answers with the field it
    focused (password, username, code...), so the phone's own keyboard and password manager can type into it."""
    kind = m.get("t")
    if kind == "tap":
        x, y = float(m["x"]), float(m["y"])
        for t in ("touchStart", "touchEnd"):
            await b.cdp("Input.dispatchTouchEvent", {"type": t, "touchPoints": [{"x": x, "y": y}] if t == "touchStart" else []})
        await asyncio.sleep(0.25)
        r = await b.cdp("Runtime.evaluate", {"expression": FOCUS, "returnByValue": True})
        return (r.get("result") or {}).get("value") or {"kind": "none", "label": ""}
    elif kind == "scroll":
        await b.cdp("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": W / 2, "y": H / 2, "deltaX": 0, "deltaY": float(m.get("dy", 0))})
    elif kind == "text":
        await b.cdp("Input.insertText", {"text": str(m.get("v", ""))[:2000]})
    elif kind == "key":
        for _ in range(max(1, min(int(m.get("n", 1)), 200))):
            await _key(b, str(m.get("k", "")))
    elif kind == "back":
        await b.cdp("Runtime.evaluate", {"expression": "history.back()"})
    elif kind == "go":
        url = str(m.get("url", "")).strip()
        if url:
            await b.cdp("Page.navigate", {"url": url if re.match(r"https?://", url) else "https://" + url})
    return None


# ------------------------------------------------------------------ lifecycle
async def _stop(owner_id: str) -> None:
    b = _browsers.pop(owner_id, None)
    if b:
        # Close Chromium the way a person would, so it writes cookies and site data (the sign-ins) to the profile;
        # a killed browser loses whatever it hadn't saved yet.
        try:
            await b.conn.call("Browser.close", timeout=5)
        except Exception:
            pass
        try:
            await b.conn.ws.close()
        except Exception:
            pass

        def down() -> None:
            try:
                b.container.wait(timeout=15)
            except Exception:
                pass
            b.container.remove(force=True)

        await asyncio.to_thread(down)


async def stop(owner_id: str) -> None:
    """The kill switch: no sites allowed any more, the browser closed (sign-ins stay in the profile)."""
    revoke(owner_id)
    await _stop(owner_id)


async def close_all() -> None:
    """The service is shutting down: close every browser properly, so sign-ins are saved."""
    await asyncio.gather(*(_stop(o) for o in list(_browsers)), return_exceptions=True)


async def sign_out(owner_id: str) -> None:
    """Forget every sign-in: the profile is deleted."""
    await stop(owner_id)
    await asyncio.to_thread(shutil.rmtree, DATA / owner_id, True)


def _sweep() -> None:
    try:
        for c in _docker().containers.list(all=True, filters={"label": "tubelight=browser"}):
            c.stop(timeout=10)  # SIGTERM: Chromium (the container's main process) saves its profile on the way out
            c.remove(force=True)
    except Exception as e:
        log.info("browser sweep skipped: %s", e)


async def loop() -> None:
    """Closes browsers nobody used for IDLE_S (and old preview screenshots)."""
    await asyncio.to_thread(_sweep)
    while True:
        await asyncio.sleep(60)
        for owner, b in list(_browsers.items()):
            if b.conn.closed or (time.time() - b.used > IDLE_S and not b.viewers):
                await _stop(owner)
                continue
            for t in list(b.tabs.values())[:-1] if len(b.tabs) > 1 else []:  # the last tab closes with the browser
                if time.time() - t.used > IDLE_S and not t.takeover and not (b.viewers and t.key == b.view):
                    await _close_tab(b, t)
        for p in SHOTS.glob("*/*.jpg") if SHOTS.exists() else []:
            if time.time() - p.stat().st_mtime > 7 * 86400:
                p.unlink(missing_ok=True)
