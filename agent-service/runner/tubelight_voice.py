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
        except GLib.Error as e:  # Snoofy's extension isn't loaded yet (it starts at the next log-in)
            print(f"voice: no hotkey yet ({e.message.split(': ')[-1]})", flush=True)

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


class Session:
    """One press of the hotkey: listening, talking, doing, until it goes quiet."""

    def __init__(self, voice: Voice) -> None:
        self.v, self.ctx = voice, voice.ctx
        self.ws = None
        self.early: list[bytes] = []  # audio said before the socket opened (the token takes a moment)
        self.pending = b""
        self.speaking_until = 0.0
        self.last = time.monotonic()
        self.turns: list[dict] = []  # the card's conversation: {you, reply, detail, closed}
        self.tasks = 0
        self.verb = ""
        self.over = False
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
            self.turns.append({"you": "", "reply": "", "detail": "", "closed": False})
        return self.turns[-1]

    def _view(self) -> list[dict]:
        return [{k: t[k].strip() for k in ("you", "reply", "detail")} for t in self.turns[-4:]]

    def show(self, state: str) -> None:
        self.v.pill(state=state, verb=self.verb if state == "working" else "", turns=self._view())

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
            status, got = self.v.api(self.v.load(), "/runner/voice/task", {"request": str(a.get("request") or "")}, timeout=120)
            return (got or {}).get("result") or (got or {}).get("detail") or f"The server answered {status}."
        s = self.v.driver()
        if name == "list_windows":
            return _windows_line(s.windows())
        if name == "place_window":
            w = s.place(a["window"], a.get("monitor"), a.get("where") or "", a.get("size") or "", a.get("state") or "",
                        bool(a.get("focus")))
            return f"{w['app']} is now on {w['monitor_name']}, {w['w']}x{w['h']}" + (", maximized" if w["maximized"] else "") + "."
        if name == "open_app":
            r = s.launch(str(a["app"]))
            return f"{r.get('app') or a['app']} is {'open' if r.get('status') == 'opened' else 'already open'}."
        if name == "close_app":
            return s.close_windows(str(a["app"]))
        if name == "look_at_app":
            return s.text(s.observe(str(a["app"]), str(a.get("window") or "")))[:9000]
        if name == "act_in_app":
            sid, eid, action = str(a["snapshot"]), str(a["element"]), str(a.get("action") or "CLICK").upper()
            e = s.element(sid, eid)
            if action in ("CLICK", "DOUBLE_CLICK") and s.risky(e["name"]) and not a.get("confirmed"):
                return (f"Not pressed: “{e['name']}” could delete, send or pay for something. Ask them out loud; only if "
                        "they say yes, call again with confirmed true.")
            r = s.act(sid, eid, action, str(a.get("value") or ""))
            head = " ".join(str(r[k]) for k in ("status", "did", "why") if r.get(k))
            if r.get("reacted") is False:
                head += " (the app showed no change)"
            return (head + "\n" + s.text(r))[:9000]
        if name == "press_keys":
            r = s.keys([str(k) for k in a.get("keys") or []][:12], str(a.get("app") or ""))
            return r.get("did", "pressed") + ("" if r.get("reacted") is not False else " (the app showed no change)")
        return f"No tool called {name}."

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


def _doing(name: str, a: dict) -> str:
    """The card's spinner line while a tool runs."""
    app = _pretty(str(a.get("app") or a.get("window") or ""))
    if name == "place_window":
        where = a.get("monitor") or a.get("where") or a.get("state") or a.get("size") or ""
        return f"Moving {app or 'the window'}" + (f" to {where}" if where else "")
    if name == "act_in_app":
        what = {"TYPE": "Typing", "READ": "Reading", "SCROLL_TO": "Scrolling", "FOCUS": "Focusing"}
        return what.get(str(a.get("action", "")).upper(), "Clicking") + (f" in {app}" if app else "…")
    return {"open_app": f"Opening {app}", "close_app": f"Closing {app}", "press_keys": f"Pressing keys in {app}".strip(),
            "list_windows": "Looking at your windows", "look_at_app": f"Looking at {app}",
            "run_task": "Asking your teammate: " + str(a.get("request") or "")[:70]}.get(name, "Working…")
