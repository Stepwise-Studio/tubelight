"""The hotkey on this computer: press it, say what you want ("put Firefox on my laptop screen", "close Spotify",
"find Ravi's invoice and open it"), and it's done. Press it again to stop.

Snoofy's shell extension owns the shortcut and draws a small pill by the pointer; this side talks to Gemini Live
(a single-use token from the server, as the computer's own teammate with its memory), streams the microphone, plays
the reply, and runs window and app commands right here through Snoofy, with no trip through the server. Anything
bigger is run_task: the computer's chat on the server does it and the answer is spoken (and lands in that chat).

Half duplex: the microphone pauses while the reply plays (no echo cancellation on a stock desktop), so it never
hears itself. Everything is GLib: Soup for the WebSocket, GStreamer for audio, both from the desktop's own libraries.
"""
import array
import base64
import json
import math
import re
import threading
import time
import urllib.parse

import gi

gi.require_version("Gst", "1.0")
gi.require_version("Soup", "3.0")
from gi.repository import Gio, GLib, Gst, Soup  # noqa: E402

LIVE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
SHELL = ("org.gnome.Shell", "/studio/stepwise/Snoofy", "studio.stepwise.Snoofy")
HOTKEY = "<Super>z"
IDLE_S = 30  # it stops listening this long after the last thing said, heard or done
KEEP_S = 90  # the card stays this long after that, to read (× or the shortcut closes it sooner)
VOICE_LEVEL = 0.12  # a microphone level this loud counts as them talking (it keeps the session open)
TAIL_S = 0.35  # the microphone stays shut this long after the reply stops playing (the room's echo)
CHUNK = 1280  # 40 ms of 16 kHz mono 16-bit
# A yes is checked against what they actually said (Gemini's transcript of their words), never taken from the model.
YES = re.compile(r"\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|post it|send it|confirm(ed)?|correct|please do|haan|"
                 r"go for it|sounds good)\b", re.I)
NO = re.compile(r"\b(no|nope|not|don'?t|stop|cancel|wait|hold on|nahi|mat)\b", re.I)
COMMIT_KEYS = re.compile(r"^(ctrl|control|meta|super|cmd|mod)\+(enter|return)$", re.I)  # sends a post or message


def _later(ctx: GLib.MainContext, fn, *args) -> None:
    """Run fn on the voice thread (Soup's socket is only touched from there)."""
    src = GLib.idle_source_new()
    src.set_callback(lambda *_: fn(*args) and False)
    src.attach(ctx)


class Voice:
    def __init__(self, load, api, driver) -> None:
        self.load, self.api, self.driver = load, api, driver  # the runner's config, its server calls, Snoofy
        self.ctx: GLib.MainContext | None = None
        self.bus = None
        self.session: Session | None = None

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True, name="voice").start()

    def _run(self) -> None:
        Gst.init(None)
        self.ctx = GLib.MainContext.new()
        self.ctx.push_thread_default()
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.bus.signal_subscribe(SHELL[0], SHELL[2], "Summon", SHELL[1], None, 0, lambda *_: self.toggle())
        self.bus.signal_subscribe(SHELL[0], SHELL[2], "Dismiss", SHELL[1], None, 0, lambda *_: self.dismiss())
        # The shell forgets the shortcut when it restarts (a log-in): take it again whenever it appears.
        Gio.bus_watch_name_on_connection(self.bus, SHELL[0], 0, lambda *_: self._grab(), None)
        GLib.MainLoop.new(self.ctx, False).run()

    def _grab(self) -> None:
        accel = self.load().get("hotkey") or HOTKEY
        try:
            ok = self.bus.call_sync(*SHELL, "Hotkey", GLib.Variant("(s)", (accel,)), GLib.VariantType("(b)"), 0, 3000, None).unpack()[0]
            print(f"voice: hotkey {accel} {'ready' if ok else 'is taken by something else'}", flush=True)
        except GLib.Error as e:  # Snoofy's extension isn't loaded yet: at a log-in the shell is up a few seconds first
            print(f"voice: no hotkey yet ({e.message.split(': ')[-1]})", flush=True)
            self._tries = getattr(self, "_tries", 0) + 1
            if self._tries <= 40:  # ask again every 3 s for 2 minutes, then wait for the next shell start
                src = GLib.timeout_source_new_seconds(3)
                src.set_callback(lambda *_: self._grab() or False)
                src.attach(self.ctx)
            return
        self._tries = 0

    def pill(self, **a) -> None:
        self.bus.call(*SHELL, "Pill", GLib.Variant("(s)", (json.dumps(a),)), None, 0, 1000, None, None)

    def linger(self, seconds: float) -> None:
        """Hide the card after a while, unless a new session took it over by then."""
        self._lingering = getattr(self, "_lingering", 0) + 1
        mine = self._lingering
        src = GLib.timeout_source_new(int(seconds * 1000))
        src.set_callback(lambda *_: (self.session is None and mine == self._lingering and self.pill(state="hide")) and False)
        src.attach(self.ctx)

    def dismiss(self) -> None:
        """× on the card: it closed itself; stop listening too."""
        if self.session:
            self.session.end("Stopped")

    def toggle(self) -> None:
        c = self.load()
        if not c.get("token") or not c.get("use_apps") or c.get("paused"):
            self.pill(state="error", verb="Turn on “Let teammates use your apps” in Tubelight first")
            src = GLib.timeout_source_new(2500)
            src.set_callback(lambda *_: self.pill(state="hide") and False)
            src.attach(self.ctx)
            return
        if self.session:
            self.session.end("Stopped")
        else:
            self.session = Session(self)


_live: list = []  # the session that's on, for step()


def step(text: str) -> None:
    """The runner's app ops call this while the worker drives an app, so the card says what it's doing right now."""
    sess = _live[0] if _live else None
    if sess and sess.tasks and not sess.over:
        _later(sess.ctx, sess._step, text)


class Session:
    """One press of the hotkey: listening, talking, doing, until it goes quiet."""

    def __init__(self, voice: Voice) -> None:
        self.v, self.ctx = voice, voice.ctx
        self.ws = None
        self.early: list[bytes] = []  # audio said before the socket opened (the token takes a moment)
        self.pending = b""
        self.speaking_until = 0.0
        self.last = time.monotonic()
        self.turns: list[dict] = []  # the card's conversation: {you, reply, detail, closed, at}
        self.asked: dict[str, float] = {}  # a risky step -> when they were asked about it
        self.tasks = 0
        self.verb = ""
        self.over = False
        _live[:] = [self]
        print("voice: listening", flush=True)
        self.show("listening")
        self.mic = self._mic()
        self.out = self._speaker()
        self._tick = GLib.timeout_source_new(500)
        self._tick.set_callback(self._idle)
        self._tick.attach(self.ctx)
        threading.Thread(target=self._token, daemon=True).start()

    # ---------------------------------------------------------- audio
    def _mic(self):
        p = Gst.parse_launch("autoaudiosrc ! audioconvert ! audioresample ! "
                             "audio/x-raw,format=S16LE,rate=16000,channels=1 ! appsink name=sink emit-signals=true sync=false")
        p.get_by_name("sink").connect("new-sample", self._sample)
        p.set_state(Gst.State.PLAYING)
        return p

    def _speaker(self):
        p = Gst.parse_launch("appsrc name=src is-live=true format=time "
                             "caps=audio/x-raw,format=S16LE,rate=24000,channels=1,layout=interleaved ! "
                             "audioconvert ! audioresample ! autoaudiosink")
        p.set_state(Gst.State.PLAYING)
        return p

    def _sample(self, sink) -> Gst.FlowReturn:
        buf = sink.emit("pull-sample").get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        if ok:
            data = bytes(info.data)
            buf.unmap(info)
            _later(self.ctx, self._heard, data)
        return Gst.FlowReturn.OK

    def _heard(self, data: bytes) -> None:
        if self.over or time.monotonic() < self.speaking_until + TAIL_S:
            return  # it's talking: don't let it hear itself
        self.pending += data
        while len(self.pending) >= CHUNK:
            chunk, self.pending = self.pending[:CHUNK], self.pending[CHUNK:]
            samples = array.array("h", chunk)
            level = math.sqrt(sum(s * s for s in samples[::8]) / max(1, len(samples) // 8)) / 6000
            if level > VOICE_LEVEL:
                self.last = time.monotonic()  # they're talking, even before any words come back
            if self.tasks == 0:
                self.v.pill(level=min(1.0, level))
            if self.ws:
                self._send({"realtimeInput": {"audio": {"data": base64.b64encode(chunk).decode(), "mimeType": "audio/pcm;rate=16000"}}})
            elif len(self.early) < 75:  # up to 3 s
                self.early.append(chunk)

    def _play(self, b64: str) -> None:
        pcm = base64.b64decode(b64)
        now = time.monotonic()
        self.speaking_until = max(self.speaking_until, now) + len(pcm) / 48000  # 24 kHz, 2 bytes a sample
        self.out.get_by_name("src").emit("push-buffer", Gst.Buffer.new_wrapped(pcm))

    # ---------------------------------------------------------- the socket
    def _token(self) -> None:
        screen = ""
        try:  # the windows and what's in front, so "move this", "put Firefox left" and "what's this?" need no look first
            snoofy = self.v.driver()
            screen = _windows_line(snoofy.windows()) + "\n"
            front = next((a["app"] for a in snoofy.apps() if any(w["active"] for w in a["windows"])), "")
            if front:
                screen += snoofy.text(snoofy.observe(front))[:6000]
        except Exception:
            pass
        try:
            status, got = self.v.api(self.v.load(), "/runner/voice", {"screen": screen, "voice": self.v.load().get("voice") or ""},
                                     timeout=20)
        except OSError as e:  # no internet (a power cut takes the router down), or the server is down
            print(f"voice: can't reach the server ({e})", flush=True)
            _later(self.ctx, self.end, "Can't reach Tubelight: check the internet and try again", "error")
            return
        if status != 200 or not got:
            print(f"voice: no session ({status}: {(got or {}).get('detail')})", flush=True)
            _later(self.ctx, self.end, (got or {}).get("detail") or "Couldn't start voice", "error")
            return
        _later(self.ctx, self._connect, got["token"])

    def _connect(self, token: str) -> None:
        if self.over:
            return
        msg = Soup.Message.new("GET", f"{LIVE_WS}?access_token={urllib.parse.quote(token)}")
        Soup.Session().websocket_connect_async(msg, None, None, GLib.PRIORITY_DEFAULT, None, self._opened)

    def _opened(self, sess, res) -> None:
        try:
            ws = sess.websocket_connect_finish(res)
        except GLib.Error as e:
            print(f"voice: Gemini Live refused or unreachable ({e.message})", flush=True)
            self.end("Can't reach the voice service: check the internet and try again", "error")
            return
        if self.over:
            ws.close(1000, None)
            return
        ws.set_max_incoming_payload_size(16 * 1024 * 1024)
        ws.connect("message", self._message)
        ws.connect("closed", lambda *_: self.end("The voice session ended") if not self.over else None)
        self.ws = ws
        self._send({"setup": {}})  # the setup comes from the token

    def _send(self, m: dict) -> None:
        if self.ws and self.ws.get_state() == Soup.WebsocketState.OPEN:
            self.ws.send_text(json.dumps(m))

    def _message(self, _ws, _kind, data) -> None:
        m = json.loads(data.get_data().decode())
        if "setupComplete" in m:
            for chunk in self.early:
                self._send({"realtimeInput": {"audio": {"data": base64.b64encode(chunk).decode(), "mimeType": "audio/pcm;rate=16000"}}})
            self.early = []
            return
        for fc in (m.get("toolCall") or {}).get("functionCalls") or []:
            self._tool(fc)
        sc = m.get("serverContent") or {}
        if sc.get("interrupted"):
            self.speaking_until = 0
        for part in (sc.get("modelTurn") or {}).get("parts") or []:
            if (part.get("inlineData") or {}).get("data"):
                self._play(part["inlineData"]["data"])
        if (sc.get("inputTranscription") or {}).get("text"):
            self._turn(new=True)["you"] += sc["inputTranscription"]["text"]
            self.last = time.monotonic()
            self.show("working" if self.tasks else "thinking")
        if (sc.get("outputTranscription") or {}).get("text"):
            self._turn()["reply"] += sc["outputTranscription"]["text"]
            self.show("working" if self.tasks else "speaking")
        if sc.get("turnComplete"):
            if self.turns:
                self.turns[-1]["closed"] = True
            self.last = time.monotonic()
            self.show("working" if self.tasks else "listening")

    # ---------------------------------------------------------- the card
    def _turn(self, new: bool = False) -> dict:
        """The exchange being spoken now; a new one when they start talking after the last one finished."""
        if not self.turns or new and self.turns[-1]["closed"]:
            self.turns.append({"you": "", "reply": "", "detail": "", "closed": False, "at": time.monotonic()})
        return self.turns[-1]

    def _view(self) -> list[dict]:
        return [{k: t[k].strip() for k in ("you", "reply", "detail")} for t in self.turns[-4:]]

    def show(self, state: str) -> None:
        self.v.pill(state=state, verb=self.verb if state == "working" else "", turns=self._view())

    def _step(self, text: str) -> None:
        if self.tasks and not self.over:
            self.verb = text
            self.show("working")

    # ---------------------------------------------------------- tools
    def _tool(self, fc: dict) -> None:
        name, args = fc.get("name"), fc.get("args") or {}
        self.tasks += 1
        snap = getattr(self.v.driver(), "_snaps", {}).get(str(args.get("snapshot") or ""), {}) if name == "act_in_app" else {}
        self.verb = _doing(name, {**args, "app": args.get("app") or snap.get("app") or ""})
        self.show("working")

        def run() -> None:
            began = time.monotonic()
            try:
                result = self._do(name, args)
            except Exception as e:  # the model hears why and says so
                result = f"That didn't work: {e}"
            print(f"voice: {name} {json.dumps(args)[:200]} -> {result[:200]!r} ({(time.monotonic() - began) * 1000:.0f} ms)", flush=True)
            _later(self.ctx, self._done, fc, result)
        threading.Thread(target=run, daemon=True).start()

    def _do(self, name: str, a: dict) -> str:
        if name == "run_task":
            status, got = self.v.api(self.v.load(), "/runner/voice/task", {"request": str(a.get("request") or ""),
                                                                            "teammate": str(a.get("teammate") or "")}, timeout=120)
            return (got or {}).get("result") or (got or {}).get("detail") or f"The server answered {status}."
        s = self.v.driver()
        if name == "work_in_app":
            app = str(a.get("app") or "")
            title = next((w["title"] for w in reversed(s.windows().get("windows") or [])
                          if _flat(app) and _flat(app) in _flat(w.get("app", "") + w.get("title", ""))), "")
            status, got = self.v.api(self.v.load(), "/runner/voice/work", {
                "app": app, "goal": str(a.get("task") or ""), "text": [str(t) for t in a.get("text") or []][:8],
                "window": title}, timeout=240)
            out = (got or {}).get("result") or (got or {}).get("detail") or f"The server answered {status}."
            if m := re.search(r"NEEDS_OK.*?press “([^”]+)”", out):
                snap = re.search(r"Snapshot (s\d+)", out)
                out = self._ask(f"press “{m.group(1)}”", s.typed(snap.group(1)) if snap else []) + "\n" + out
            return out
        if name == "list_windows":
            return _windows_line(s.windows())
        if name == "place_window":
            w = s.place(a["window"], a.get("monitor"), a.get("where") or "", a.get("size") or "", a.get("state") or "",
                        bool(a.get("focus")))
            return f"{w['app']} is now on {w['monitor_name']}, {w['w']}x{w['h']}" + (", maximized" if w["maximized"] else "") + "."
        if name == "open_app":
            r = s.launch(str(a["app"]))
            app = r.get("app") if r.get("app") and not str(r["app"]).isdigit() else a["app"]
            return f"{app} is {'open' if r.get('status') == 'opened' else 'already open'}."
        if name == "close_app":
            return s.close_windows(str(a["app"]))
        if name == "look_at_app":
            return s.text(s.observe(str(a["app"]), str(a.get("window") or "")))[:9000]
        if name == "open_website":
            r = s.open_url(str(a["url"]), a.get("new_tab", True) is not False, str(a.get("browser") or ""))
            return ((r["note"] + "\n") if r.get("note") else "") + s.text(r)[:9000]
        if name == "read_page":
            r = s.page(str(a.get("browser") or ""))
            return f"{r['app']}, “{r['window']}”:\n{r['text']}" + ("\n(cut here: the page goes on)" if r["truncated"] else "")
        if name == "act_in_app":
            sid, eid, action = str(a["snapshot"]), str(a["element"]), str(a.get("action") or "CLICK").upper()
            e = s.element(sid, eid)
            if action in ("CLICK", "DOUBLE_CLICK") and s.risky(e["name"]):
                if not self._confirmed(f"press “{e['name']}”", a, s.typed(sid)):
                    return self._ask(f"press “{e['name']}”", s.typed(sid))
            r = s.act(sid, eid, action, str(a.get("value") or ""))
            head = " ".join(str(r[k]) for k in ("status", "did", "why") if r.get(k))
            if r.get("reacted") is False:
                head += " (the app showed no change)"
            return (head + "\n" + s.text(r))[:9000]
        if name == "press_keys":
            sent = next((k for k in a.get("keys") or [] if COMMIT_KEYS.match(str(k).strip())), None)
            if sent and not self._confirmed(f"press {sent}", a, []):
                return self._ask(f"press {sent} (it sends what's written)", [])
            r = s.keys([str(k) for k in a.get("keys") or []][:12], str(a.get("app") or ""))
            return r.get("did", "pressed") + ("" if r.get("reacted") is not False else " (the app showed no change)")
        return f"No tool called {name}."

    def _ask(self, step: str, typed: list[str]) -> str:
        """A step that posts, sends, deletes or pays: nothing happens until they say yes out loud."""
        self.asked[step.split(" (")[0]] = time.monotonic()
        said = "; ".join(f"“{t[:300]}”" for t in typed)
        self._turn()["detail"] = f"Waiting for your yes: {step}" + (f"\nWritten: {said}" if said else "")
        return (f"Not done yet: {step} can't be undone. Say exactly what will happen" + (f" (what's written: {said})" if said
                else "") + " and ask them. Only after they say yes, call again with confirmed true.")

    def _confirmed(self, step: str, a: dict, typed: list[str]) -> bool:
        """True only when they were asked about this step and said yes since (in their own words, not the model's)."""
        at = self.asked.get(step)
        if not a.get("confirmed") or at is None:
            return False
        said = " ".join(t["you"] for t in self.turns if t.get("at", 0) > at and t["you"].strip())
        ok = bool(YES.search(said)) and not NO.search(said)
        if ok:
            self.asked.pop(step, None)
            self._turn()["detail"] = ""
        return ok

    def _done(self, fc: dict, result: str) -> None:
        self.tasks -= 1
        self.last = time.monotonic()
        response = {"result": result[:3000]}
        if fc.get("name") == "run_task":
            response["scheduling"] = "WHEN_IDLE"
        self._send({"toolResponse": {"functionResponses": [{"id": fc.get("id"), "name": fc.get("name"), "response": response}]}})
        if fc.get("name") == "run_task" and result.strip():  # the teammate's whole answer, not just the spoken gist
            self._turn()["detail"] = result.strip()
        if self.tasks == 0:
            self.show("thinking")

    # ---------------------------------------------------------- ending
    def _idle(self, *_) -> bool:
        if self.over:
            return False
        busy = self.tasks or time.monotonic() < self.speaking_until + TAIL_S
        if not busy and time.monotonic() - self.last > IDLE_S:
            self.end()
            return False
        return True

    def end(self, why: str = "", state: str = "done") -> None:
        if self.over:
            return
        self.over = True
        print(f"voice: ended{': ' + why if why else ''}", flush=True)
        for p in (self.mic, self.out):
            p.set_state(Gst.State.NULL)
        if self.ws:
            self.ws.close(1000, None)
        if why == "Stopped":
            self.v.pill(state="hide")
        else:  # the card stays to be read: the conversation, and what ended it
            self.v.pill(state="error" if state == "error" else "done", verb=why if state == "error" else "Super+Z to talk again",
                        turns=self._view())
            self.v.linger(KEEP_S if self.turns else 4)
        turns = [{"role": r, "text": t[k].strip()} for t in self.turns for r, k in (("user", "you"), ("teammate", "reply"))
                 if t[k].strip()]
        if turns:
            threading.Thread(target=self.v.api, args=(self.v.load(), "/runner/voice/transcript", {"turns": turns}), daemon=True).start()
        if self.v.session is self:
            self.v.session = None


def _windows_line(got: dict) -> str:
    mons = {m["index"]: f"{m['name']}{' (laptop screen)' if m['builtin'] else ''}" for m in got["monitors"]}
    return "Monitors: " + ", ".join(mons.values()) + ". Windows (top first): " + "; ".join(
        f"{w['app']} “{w['title'][:50]}” on {mons.get(w['monitor'], '?')}"
        + "".join(f" ({k})" for k in ("maximized", "minimized", "focused") if w[k]) for w in reversed(got["windows"]))


def _pretty(app: str) -> str:
    """"gnome-calculator", "org.gnome.TextEditor", "app.zen_browser.zen" → Calculator, TextEditor, Zen."""
    app = app.rsplit(".", 1)[-1].removeprefix("gnome-").replace("-", " ").replace("_", " ").strip()
    return app[:1].upper() + app[1:] if app else ""


def _flat(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def _doing(name: str, a: dict) -> str:
    """The card's spinner line while a tool runs."""
    app = _pretty(str(a.get("app") or a.get("window") or ""))
    if name == "place_window":
        where = a.get("monitor") or a.get("where") or a.get("state") or a.get("size") or ""
        return f"Moving {app or 'the window'}" + (f" to {where}" if where else "")
    if name == "act_in_app":
        what = {"TYPE": "Typing", "READ": "Reading", "SCROLL_TO": "Scrolling", "FOCUS": "Focusing"}
        return what.get(str(a.get("action", "")).upper(), "Clicking") + (f" in {app}" if app else "…")
    if name == "open_website":
        return "Opening " + str(a.get("url") or "the page").removeprefix("https://").removeprefix("www.")[:40]
    if name == "read_page":
        return "Reading the page"
    if name == "work_in_app":
        return f"Working in {app}" if app else "Working…"
    if name == "run_task" and a.get("teammate"):
        return f"Asking {_pretty(str(a['teammate']))}"
    return {"open_app": f"Opening {app}", "close_app": f"Closing {app}", "press_keys": f"Pressing keys in {app}".strip(),
            "list_windows": "Looking at your windows", "look_at_app": f"Looking at {app}",
            "run_task": "Asking your teammate: " + str(a.get("request") or "")[:70]}.get(name, "Working…")
