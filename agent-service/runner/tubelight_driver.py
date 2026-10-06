"""Using this computer's apps for a teammate: the Linux side of computer use, after arc-driver on macOS.

Apps are read through the desktop's accessibility layer (AT-SPI): a window becomes a snapshot of what's on screen in
it, each element with an id, a role, a name, a value and what can be done to it. A teammate acts on an element by id:
click, type or set its text, set a value, focus, read its text. Those go straight to the app (in the background: the
pointer and the window in front stay as they are). Keys go to the window in front, through GNOME's remote-desktop
interface (Wayland lets nothing else type).

Every action is checked against the app as it is when it runs: if the element moved or changed, or a dialog came or
went since the snapshot, nothing happens and a fresh snapshot comes back instead. After acting it waits for the app
to settle (until its accessibility events go quiet), then returns the new snapshot.

The user turns this on in the Tubelight window ("Let teammates use your apps").
"""
import threading
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib  # noqa: E402

MAX_ELEMENTS = 260
MAX_DEPTH = 40
MAX_TEXT = 300
SKIP_APPS = {"gnome-shell", "ibus-extension-gtk3", "evolution-alarm-notify", "xdg-desktop-portal-gtk",
             "xdg-desktop-portal-gnome", "update-notifier", "mutter-x11-frames", "gsd-media-keys", "tubelight"}
WINDOW_ROLES = {"frame", "window", "dialog", "alert", "file chooser"}
# Containers worth showing even without a name (they give the list its shape).
SHAPE_ROLES = {"dialog", "alert", "menu bar", "menu", "tool bar", "list", "list box", "tree", "tree table", "table",
               "page tab list", "tab list", "combo box", "popup menu", "document web", "document frame", "form"}
FOCUS_ROLES = {"text", "entry", "list item", "tree item", "table cell", "terminal", "document web", "document frame",
               "document text", "link", "paragraph", "image", "canvas", "icon"}
CLICKS = ("click", "press", "activate", "jump", "toggle", "open", "select", "expand or contract")

_lock = threading.RLock()
_snaps: dict[str, dict] = {}
_ids: dict[tuple, str] = {}
_count = [0, 0]  # snapshots, element ids


def available() -> bool:
    try:
        return Atspi.get_desktop(0).get_child_count() >= 0
    except Exception:
        return False


def _s(f, default=""):
    try:
        v = f()
        return default if v is None else v
    except Exception:
        return default


def _states(acc) -> set:
    st = _s(acc.get_state_set, None)
    if st is None:
        return set()
    names = {Atspi.StateType.SHOWING: "showing", Atspi.StateType.VISIBLE: "visible", Atspi.StateType.FOCUSED: "focused",
             Atspi.StateType.CHECKED: "checked", Atspi.StateType.SELECTED: "selected", Atspi.StateType.ENABLED: "enabled",
             Atspi.StateType.EXPANDED: "expanded", Atspi.StateType.ACTIVE: "active", Atspi.StateType.EDITABLE: "editable",
             Atspi.StateType.FOCUSABLE: "focusable", Atspi.StateType.CHECKABLE: "checkable", Atspi.StateType.PRESSED: "pressed",
             Atspi.StateType.MULTI_LINE: "multi line"}
    return {n for t, n in names.items() if st.contains(t)}


# ------------------------------------------------------------------ apps and windows
def _apps():
    desk = Atspi.get_desktop(0)
    for i in range(_s(desk.get_child_count, 0)):
        app = _s(lambda: desk.get_child_at_index(i), None)
        if app is None:
            continue
        name = _s(app.get_name)
        if not name or name in SKIP_APPS:
            continue
        wins = []
        for j in range(min(_s(app.get_child_count, 0), 30)):
            w = _s(lambda: app.get_child_at_index(j), None)
            if w is not None and _s(w.get_role_name) in WINDOW_ROLES:
                wins.append((j, w))
        if wins:
            yield app, name, wins


def apps() -> list[dict]:
    """Apps with windows: name, pid, each window's title and whether it's the one in front."""
    out = []
    for app, name, wins in _apps():
        out.append({"app": name, "pid": _s(app.get_process_id, 0),
                    "windows": [{"title": _s(w.get_name) or "(untitled)", "active": "active" in _states(w)} for _, w in wins]})
    return out


def _find(app_name: str, window: str = ""):
    """The app (by name, or a window title it has) and one window: the named one, else its active one, else its first."""
    want, wtitle = app_name.strip().lower(), window.strip().lower()
    hits = []
    for app, name, wins in _apps():
        titles = [(j, w, _s(w.get_name).lower()) for j, w in wins]
        if want and want not in name.lower() and not any(want in t for _, _, t in titles):
            continue
        hits.append((app, name, titles))
    if not hits:
        raise LookupError(f"No open app called {app_name!r}. Open apps: " + ", ".join(a["app"] for a in apps()) + ".")
    hits.sort(key=lambda h: (want != h[1].lower(), not any("active" in _states(w) for _, w, _ in h[2])))
    app, name, titles = hits[0]
    pick = next(((j, w) for j, w, t in titles if wtitle and wtitle in t), None)
    pick = pick or next(((j, w) for j, w, _ in titles if "active" in _states(w)), None) or (titles[0][0], titles[0][1])
    return app, name, pick[0], pick[1]


# ------------------------------------------------------------------ snapshots
def _actions(acc, roles: str, states: set) -> list[str]:
    out = []
    act = _s(acc.get_action_iface, None)
    names = [(_s(lambda: act.get_action_name(i)) or "").lower() for i in range(_s(act.get_n_actions, 0))] if act else []
    if any(n in CLICKS for n in names):
        out.append("CLICK")
    if _s(acc.get_editable_text_iface, None) is not None and "editable" in states:
        out.append("TYPE")
    if _s(acc.get_value_iface, None) is not None and roles in ("slider", "spin button", "scroll bar", "dial"):
        out.append("SET_VALUE")
    if "focusable" in states and "CLICK" not in out and "TYPE" not in out and roles in FOCUS_ROLES:
        out.append("FOCUS")
    return out


def _value(acc, role: str, states: set) -> str:
    if "checkable" in states or role in ("check box", "radio button", "toggle button", "check menu item", "radio menu item"):
        return "on" if "checked" in states or "pressed" in states else "off"
    val = _s(acc.get_value_iface, None)
    if val is not None and role in ("slider", "spin button", "progress bar", "scroll bar", "level bar", "dial"):
        return f"{_s(val.get_current_value, 0):g}"
    txt = _s(acc.get_text_iface, None)
    if txt is not None and role in ("text", "entry", "password text", "terminal", "paragraph", "editbar", "spin button", "combo box"):
        n = _s(txt.get_character_count, 0)
        if role == "password text":
            return "•" * min(n, 8)
        return _s(lambda: txt.get_text(0, min(n, MAX_TEXT))) + ("…" if n > MAX_TEXT else "")
    return ""


def _walk(win, pid: int) -> list[dict]:
    out: list[dict] = []

    def visit(acc, path: str, depth: int, parent: str = "") -> None:
        if len(out) >= MAX_ELEMENTS or depth > MAX_DEPTH:
            return
        states = _states(acc)
        if depth and ("showing" not in states or "visible" not in states):
            return
        role = _s(acc.get_role_name)
        name = " ".join(_s(acc.get_name).split())[:120]
        acts = _actions(acc, role, states) if depth else []
        value = _value(acc, role, states) if depth else ""
        echo = not acts and not value and name == parent  # a label repeating its button's name
        if depth and not echo and (name or acts or value or role in SHAPE_ROLES):
            key = (pid, path)
            with _lock:
                if key not in _ids:
                    _count[1] += 1
                    _ids[key] = f"e{_count[1]}"
            out.append({"id": _ids[key], "path": path, "role": role, "name": name, "value": value, "actions": acts,
                        "depth": depth, "focused": "focused" in states})
        for i in range(min(_s(acc.get_child_count, 0), 400)):
            child = _s(lambda: acc.get_child_at_index(i), None)
            if child is not None:
                visit(child, f"{path}.{i}", depth + 1, name)

    visit(win, "w", 0)
    return out


def _signature(app) -> tuple:
    """The app's shape: its windows and dialogs. A change means the screen isn't what a snapshot showed."""
    sig = []
    for j in range(min(_s(app.get_child_count, 0), 30)):
        w = _s(lambda: app.get_child_at_index(j), None)
        if w is not None:
            sig.append((_s(w.get_role_name), _s(w.get_name)[:60], "showing" in _states(w)))
    return tuple(sig)


def observe(app_name: str, window: str = "") -> dict:
    app, name, index, win = _find(app_name, window)
    pid = _s(app.get_process_id, 0)
    elements = _walk(win, pid)
    with _lock:
        _count[0] += 1
        sid = f"s{_count[0]}"
        _snaps[sid] = {"app": name, "pid": pid, "window": index, "title": _s(win.get_name), "sig": _signature(app),
                       "elements": {e["id"]: e for e in elements}, "at": time.time()}
        for old in [k for k, v in _snaps.items() if time.time() - v["at"] > 900]:
            _snaps.pop(old, None)
    return {"snapshot": sid, "app": name, "window": _s(win.get_name), "elements": elements,
            "truncated": len(elements) >= MAX_ELEMENTS}


def text(snap: dict) -> str:
    """A snapshot as a teammate reads it: one line per element, indented by depth."""
    lines = [f"Snapshot {snap['snapshot']}: {snap['app']}, window “{snap['window']}”"]
    base = min((e["depth"] for e in snap["elements"]), default=1)
    for e in snap["elements"]:
        bits = [f"[{e['id']}]", e["role"]]
        if e["name"]:
            bits.append(f"“{e['name']}”")
        if e["value"]:
            bits.append(f"= {e['value']!r}" if len(e["value"]) < 80 else f"= {e['value'][:80]!r}…")
        if e["actions"]:
            bits.append("(" + ", ".join(a.lower() for a in e["actions"]) + ")")
        if e["focused"]:
            bits.append("*focused*")
        lines.append("  " * min(e["depth"] - base, 8) + " ".join(bits))
    if snap.get("truncated"):
        lines.append(f"(only the first {MAX_ELEMENTS} elements; act on what's here or look at another window)")
    return "\n".join(lines)


# ------------------------------------------------------------------ acting
def _at(win, path: str):
    acc = win
    for part in path.split(".")[1:]:
        acc = acc.get_child_at_index(int(part))
        if acc is None:
            return None
    return acc


class _Events:
    """Counts the apps' accessibility events while an action runs, to tell when they've settled."""

    def __init__(self) -> None:
        self.n = 0
        self.last = 0.0
        self.loop: GLib.MainLoop | None = None
        self.listener = None

    def start(self) -> None:
        if self.loop:
            return
        ready = threading.Event()

        def run() -> None:
            ctx = GLib.MainContext.default()
            self.loop = GLib.MainLoop.new(ctx, False)
            ready.set()
            self.loop.run()
        threading.Thread(target=run, daemon=True, name="atspi-events").start()
        ready.wait(2)

    def _hit(self, _event) -> None:
        self.n += 1
        self.last = time.time()

    def __enter__(self):
        self.start()
        self.n, self.last = 0, 0.0
        self.listener = Atspi.EventListener.new(self._hit)
        for kind in ("object:children-changed", "object:state-changed", "object:property-change", "object:text-changed",
                     "object:value-changed", "window:create", "window:activate", "focus:"):
            _s(lambda k=kind: self.listener.register(k), None)
        return self

    def settle(self, quiet: float = 0.15, idle: float = 0.6, most: float = 2.0) -> None:
        began = time.time()
        while time.time() - began < most:
            time.sleep(0.05)
            if not self.n and time.time() - began >= idle:
                return  # the app didn't react
            if self.n and time.time() - self.last >= quiet:
                return

    def __exit__(self, *exc) -> None:
        for kind in ("object:children-changed", "object:state-changed", "object:property-change", "object:text-changed",
                     "object:value-changed", "window:create", "window:activate", "focus:"):
            _s(lambda k=kind: self.listener.deregister(k), None)


_events = _Events()


def act(sid: str, element: str, action: str, value: str = "") -> dict:
    """Do one thing to one element of a snapshot. Returns status done | changed | stale, and a fresh snapshot."""
    snap = _snaps.get(sid)
    if not snap:
        raise LookupError(f"Snapshot {sid} is gone; look again.")
    e = snap["elements"].get(element)
    if not e:
        raise LookupError(f"No element {element} in snapshot {sid}.")
    app, name, index, win = _find(snap["app"])
    if _s(app.get_process_id, 0) != snap["pid"]:
        return {"status": "changed", "why": f"{snap['app']} was restarted", **observe(snap["app"])}
    if _signature(app) != snap["sig"]:
        return {"status": "changed", "why": "a window or dialog came or went since that snapshot", **observe(snap["app"])}
    win = _s(lambda: app.get_child_at_index(snap["window"]), None) or win
    acc = _at(win, e["path"])
    if acc is None or _s(acc.get_role_name) != e["role"] or " ".join(_s(acc.get_name).split())[:120] != e["name"]:
        return {"status": "stale", "why": "that element changed or moved", **observe(snap["app"])}
    action = action.upper()
    with _events as ev:
        did = _do(acc, e, action, value)
        ev.settle()
    return {"status": "done", "did": did, **observe(snap["app"], snap["title"])}


def _do(acc, e: dict, action: str, value: str) -> str:
    if action == "CLICK":
        act = _s(acc.get_action_iface, None)
        names = [(_s(lambda: act.get_action_name(i)) or "").lower() for i in range(_s(act.get_n_actions, 0))] if act else []
        i = next((i for i, n in enumerate(names) if n in CLICKS), None)
        if i is None:
            raise ValueError(f"{e['role']} “{e['name']}” can't be clicked; try FOCUS then a key.")
        act.do_action(i)
        return f"clicked {e['role']} “{e['name']}”"
    if action in ("TYPE", "TYPE_TEXT", "SET_TEXT", "REPLACE"):
        ed = _s(acc.get_editable_text_iface, None)
        if ed is None:
            raise ValueError(f"{e['role']} “{e['name']}” doesn't take text.")
        _s(lambda: acc.get_component_iface().grab_focus(), None)
        if "multi line" in _states(acc) and action != "REPLACE":
            # A document: write at the cursor, never over what's there (REPLACE does that, on purpose).
            txt = _s(acc.get_text_iface, None)
            at = _s(txt.get_caret_offset, -1) if txt else -1
            at = at if at >= 0 else _s(txt.get_character_count, 0) if txt else 0
            ed.insert_text(at, value, len(value.encode()))
            return f"typed into {e['role']} “{e['name']}” at the cursor"
        ed.set_text_contents(value)
        return f"set the text of {e['role']} “{e['name']}”"
    if action == "SET_VALUE":
        val = _s(acc.get_value_iface, None)
        if val is None:
            raise ValueError(f"{e['role']} “{e['name']}” has no value to set.")
        val.set_current_value(float(value))
        return f"set {e['role']} “{e['name']}” to {value}"
    if action == "FOCUS":
        if not _s(lambda: acc.get_component_iface().grab_focus(), False):
            raise ValueError(f"{e['role']} “{e['name']}” can't take focus.")
        return f"focused {e['role']} “{e['name']}”"
    if action == "READ":
        txt = _s(acc.get_text_iface, None)
        if txt is None:
            return e["name"] or e["value"]
        n = _s(txt.get_character_count, 0)
        return _s(lambda: txt.get_text(0, min(n, 12000)))
    if action == "SCROLL_TO":
        if not _s(lambda: acc.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE), False):
            raise ValueError("It can't be scrolled into view.")
        return f"scrolled to {e['role']} “{e['name']}”"
    raise ValueError("action is CLICK, TYPE, REPLACE, SET_VALUE, FOCUS, READ or SCROLL_TO (keys: use the keys tool)")


# ------------------------------------------------------------------ keys, through GNOME's remote-desktop interface
KEYSYMS = {
    "enter": 0xff0d, "return": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "esc": 0xff1b, "backspace": 0xff08,
    "delete": 0xffff, "up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53, "home": 0xff50, "end": 0xff57,
    "pageup": 0xff55, "page_up": 0xff55, "pagedown": 0xff56, "page_down": 0xff56, "space": 0x20, "insert": 0xff63,
    "ctrl": 0xffe3, "control": 0xffe3, "shift": 0xffe1, "alt": 0xffe9, "super": 0xffeb, "meta": 0xffeb, "mod": 0xffe3,
    **{f"f{i}": 0xffbd + i for i in range(1, 13)},
}


def _keysym(token: str) -> int:
    t = token.strip()
    if t.lower() in KEYSYMS:
        return KEYSYMS[t.lower()]
    if len(t) == 1:
        cp = ord(t.lower()) if t.isalpha() else ord(t)
        return cp if cp < 0x100 else 0x01000000 + cp
    raise ValueError(f"Unknown key {token!r}")


class _Remote:
    """One remote-desktop session at a time, opened when keys are needed and closed soon after."""

    def __init__(self) -> None:
        self.path: str | None = None
        self.used = 0.0
        self.bus = None

    def _open(self) -> None:
        self.bus = self.bus or Gio.bus_get_sync(Gio.BusType.SESSION)
        if self.path:
            return
        res = self.bus.call_sync("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop",
                                 "org.gnome.Mutter.RemoteDesktop", "CreateSession", None, GLib.VariantType("(o)"), 0, 5000, None)
        self.path = res.unpack()[0]
        self._call("Start")
        threading.Thread(target=self._reaper, daemon=True).start()

    def _call(self, method: str, args=None) -> None:
        self.bus.call_sync("org.gnome.Mutter.RemoteDesktop", self.path, "org.gnome.Mutter.RemoteDesktop.Session",
                           method, args, None, 0, 5000, None)

    def _reaper(self) -> None:  # no session (and no "remote" indicator) left open when idle
        while self.path:
            time.sleep(5)
            if time.time() - self.used > 20:
                with _lock:
                    _s(lambda: self._call("Stop"), None)
                    self.path = None

    def keys(self, combo: str) -> None:
        with _lock:
            self._open()
            self.used = time.time()
            syms = [_keysym(k) for k in combo.split("+") if k.strip()] if len(combo) > 1 else [_keysym(combo)]
            for s in syms:
                self._call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (s, True)))
            for s in reversed(syms):
                self._call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (s, False)))
            self.used = time.time()

    def type(self, text_: str) -> None:
        with _lock:
            self._open()
            for ch in text_:
                s = 0xff0d if ch == "\n" else 0xff09 if ch == "\t" else (ord(ch) if ord(ch) < 0x100 else 0x01000000 + ord(ch))
                self._call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (s, True)))
                self._call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (s, False)))
            self.used = time.time()


_remote = _Remote()


def keys(sequence: list[str], app_name: str = "") -> dict:
    """Presses each chord ("ctrl+s", "enter", "page_down") or types text ("text:hello") in the window in front."""
    with _events as ev:
        for k in sequence:
            if k.startswith("text:"):
                _remote.type(k[5:])
            else:
                _remote.keys(k)
            time.sleep(0.03)
        ev.settle()
    front = next((a["app"] for a in apps() if any(w["active"] for w in a["windows"])), "")
    out = {"status": "done", "did": f"pressed {', '.join(sequence)}", "front": front}
    target = app_name or front
    if target:
        try:
            out.update(observe(target))
        except LookupError:
            pass
    return out


# ------------------------------------------------------------------ launching
def launch(name: str) -> dict:
    """Opens an app by name (as its menu entry calls it) and waits for its window."""
    if any(name.lower() in a["app"].lower() for a in apps()):
        return {"status": "running", **observe(name)}
    hits = [h for group in Gio.DesktopAppInfo.search(name) for h in group]
    info = next((Gio.DesktopAppInfo.new(h) for h in hits if Gio.DesktopAppInfo.new(h)), None)
    if not info:
        raise LookupError(f"No app called {name!r} is installed.")
    before = {a["app"] for a in apps()}
    import subprocess  # its own session, nothing of ours inherited (a launched app outlives this call)
    subprocess.Popen(["gtk-launch", info.get_id()], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(40):
        time.sleep(0.25)
        new = [a for a in apps() if a["app"] not in before]
        if new:
            time.sleep(0.6)  # let its first window fill in
            return {"status": "opened", **observe(new[0]["app"])}
    raise TimeoutError(f"{info.get_display_name()} was started but no window showed up in 10 s.")
