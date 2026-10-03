"""Tubelight for desktop: the window (GTK 4 + libadwaita). Link with a QR code, choose shared folders, pause, see what
teammates did here, unlink. The work itself happens in the background service (`tubelight-runner.py run`); the two
share ~/.config/tubelight/runner.json (settings) and ~/.cache/tubelight/state.json (what the service is doing)."""
import json
import platform
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

import qrcodegen  # noqa: E402

APP_ID = "studio.stepwise.Tubelight"
OPS = {"fs_list": "Looked in", "fs_read": "Read", "fs_write": "Wrote", "shell": "Ran",
       "box_start": "Started a sandbox", "box_exec": "Ran in a sandbox", "box_read": "Read in a sandbox",
       "box_write": "Wrote in a sandbox", "box_close": "Closed a sandbox"}
V, CENTER = Gtk.Orientation.VERTICAL, Gtk.Align.CENTER


def label(text: str, *classes: str, **kw) -> Gtk.Label:
    lb = Gtk.Label(label=text, wrap=True, justify=Gtk.Justification.CENTER, **kw)
    for c in classes:
        lb.add_css_class(c)
    return lb


def row(title: str, subtitle: str = "") -> Adw.ActionRow:
    r = Adw.ActionRow(title=title, subtitle=subtitle)
    r.set_use_markup(False)  # paths and commands, not markup
    return r


class Window(Adw.ApplicationWindow):
    def __init__(self, app: Adw.Application, runner):
        super().__init__(application=app, title="Tubelight", default_width=440, default_height=700)
        self.r = runner
        self.linking = False
        self.answer: dict = {}
        self.home_key = None
        self.toasts = Adw.ToastOverlay()
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self.toasts.set_child(self.stack)
        view = Adw.ToolbarView()
        view.add_top_bar(Adw.HeaderBar())
        view.set_content(self.toasts)
        self.set_content(view)
        self.stack.add_named(self._link_page(), "link")
        self.stack.add_named(self._confirm_page(), "confirm")
        self.home = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        self.stack.add_named(self.home, "home")
        self.refresh()
        GLib.timeout_add_seconds(2, self.refresh)

    # ---------------------------------------------------------------- linking
    def _link_page(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=V, spacing=16, valign=CENTER, halign=CENTER, margin_start=28, margin_end=28,
                      margin_top=24, margin_bottom=24)
        box.append(label("Link this computer", "title-1"))
        box.append(label("On your phone, open Tubelight → Profile → Computers → Scan, and point it at this code.",
                         "dim-label", max_width_chars=34))
        self.qr_pic = Gtk.Picture(can_shrink=True, width_request=232, height_request=232, halign=CENTER)
        card = Gtk.Box(halign=CENTER)
        card.add_css_class("card")
        for side in ("top", "bottom", "start", "end"):
            getattr(self.qr_pic, f"set_margin_{side}")(14)
        card.append(self.qr_pic)
        box.append(card)
        self.link_note = label("Getting a code…", "dim-label", "caption")
        box.append(self.link_note)
        return box

    @staticmethod
    def _texture(qr: qrcodegen.QrCode, px: int = 8) -> Gdk.Texture:
        """The code as an image (no Cairo binding needed): dark modules on white, a quiet zone of two modules."""
        n = qr.get_size() + 4
        line = lambda y: b"".join((b"\x18\x18\x1b" if 0 <= y - 2 < n - 4 and 0 <= x - 2 < n - 4 and qr.get_module(x - 2, y - 2)  # noqa: E731
                                   else b"\xff\xff\xff") * px for x in range(n))
        data = b"".join(line(y) * px for y in range(n))
        return Gdk.MemoryTexture.new(n * px, n * px, Gdk.MemoryFormat.R8G8B8, GLib.Bytes.new(data), n * px * 3)

    def _show_qr(self, link: str) -> None:
        self.qr_pic.set_paintable(self._texture(qrcodegen.QrCode.encode_text(link, qrcodegen.QrCode.Ecc.MEDIUM)))
        self.link_note.set_label(f"Waiting for your phone · {urlparse(self.r.load().get('url', '')).netloc}")
        self.stack.set_visible_child_name("link")

    def _confirm_page(self) -> Gtk.Widget:
        self.confirm = Adw.StatusPage(icon_name="computer-symbolic", title="Link this computer?")
        buttons = Gtk.Box(orientation=V, spacing=10, halign=CENTER)
        yes = Gtk.Button(label="Link")
        yes.add_css_class("suggested-action"), yes.add_css_class("pill")
        yes.connect("clicked", lambda _b: self._answer(True))
        no = Gtk.Button(label="That’s not me")
        no.add_css_class("flat"), no.add_css_class("pill")
        no.connect("clicked", lambda _b: self._answer(False))
        buttons.append(yes), buttons.append(no)
        self.confirm.set_child(buttons)
        return self.confirm

    def _ask(self, email: str, done: threading.Event) -> None:
        self.answer = {"done": done}
        self.confirm.set_title(f"Link to {email}?")
        self.confirm.set_description("Teammates in that Tubelight account will be able to read the folders you share "
                                     "here, and change files or run commands after you approve each step on your phone.")
        self.stack.set_visible_child_name("confirm")

    def _answer(self, ok: bool) -> None:
        self.answer["ok"] = ok
        self.answer["done"].set()

    def _link_loop(self) -> None:
        try:
            while not self.r.load().get("token"):
                c = self.r.load()
                try:
                    st, res = self.r.api(c, "/runner/hello", {"name": socket.gethostname(), "os": platform.system()})
                    if st != 200 or not res:
                        raise OSError(f"the server answered {st}")
                    GLib.idle_add(self._show_qr, res["link"])
                    deadline = time.time() + res["expires_in"] - 10
                    while time.time() < deadline and not self.r.load().get("token"):
                        st, s = self.r.api(c, "/runner/link-status", {"request": res["request"]}, timeout=45)
                        state = (s or {}).get("state")
                        if state == "expired":
                            break
                        if state != "scanned":
                            continue
                        done = threading.Event()
                        GLib.idle_add(self._ask, s.get("email") or "your account", done)
                        done.wait()
                        ok = self.answer.get("ok", False)
                        st, made = self.r.api(c, "/runner/link-confirm", {"request": res["request"], "approve": ok})
                        if ok and st == 200 and made and made.get("token"):
                            self.r.save({**self.r.load(), "url": c["url"], "token": made["token"], "id": made["id"]})
                            GLib.idle_add(self._toast, "Linked. Now share a folder for your teammates.")
                            return
                        GLib.idle_add(self.stack.set_visible_child_name, "link")
                except Exception as e:  # offline, server restarting: keep trying
                    GLib.idle_add(self.link_note.set_label, f"Can’t reach your Tubelight server ({e}). Trying again…")
                    time.sleep(5)
        finally:
            self.linking = False

    # ---------------------------------------------------------------- linked
    def refresh(self) -> bool:
        c = self.r.load()
        if not c.get("token"):
            self.home_key = None
            if not self.linking:
                self.linking = True
                threading.Thread(target=self._link_loop, daemon=True).start()
            return True
        try:
            st = json.loads(self.r.STATE.read_text()) if self.r.STATE.exists() else {}
        except ValueError:
            st = {}
        online = bool(st.get("online")) and time.time() - st.get("seen", 0) < 90
        key = json.dumps([c.get("folders"), c.get("paused"), c.get("full_access", True), online, st.get("error"), (st.get("jobs") or [])[-8:]])
        if key != self.home_key:
            self.home_key = key
            self.home.set_child(self._home_page(c, st, online))
        self.stack.set_visible_child_name("home")
        return True

    def _home_page(self, c: dict, st: dict, online: bool) -> Gtk.Widget:
        page = Adw.PreferencesPage()
        host = urlparse(c.get("url", "")).netloc
        g = Adw.PreferencesGroup(title="This computer")
        status = row("Paused" if c.get("paused") else "Connected" if online else "Connecting…",
                     f"to {host}" + (f" · {st['error']}" if st.get("error") and not online else ""))
        dot = Gtk.Image(icon_name="media-record-symbolic")
        dot.add_css_class("success" if online and not c.get("paused") else "dim-label")
        status.add_prefix(dot)
        g.add(status)
        reach = Adw.SwitchRow(title="Let teammates reach this computer", active=not c.get("paused"),
                              subtitle="Off: they can’t read or run anything here")
        reach.connect("notify::active", lambda sw, _p: self._set(paused=not sw.get_active()))
        g.add(reach)
        whole = Adw.SwitchRow(title="Full access from its chat", active=c.get("full_access", True),
                              subtitle="Its chat in the app can open any file and run any command as you, after you approve")
        whole.connect("notify::active", lambda sw, _p: self._set(full_access=sw.get_active()))
        g.add(whole)
        page.add(g)

        f = Adw.PreferencesGroup(title="Shared folders",
                                 description="Other teammates can read these (Cowork). Every change and command waits for your OK on your phone.")
        add = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="Share a folder", valign=CENTER)
        add.add_css_class("flat")
        add.connect("clicked", self._add_folder)
        f.set_header_suffix(add)
        for path in c.get("folders", []):
            r = row(Path(path).name, path)
            rm = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Stop sharing", valign=CENTER)
            rm.add_css_class("flat")
            rm.connect("clicked", lambda _b, p=path: self._share(p, False))
            r.add_suffix(rm)
            f.add(r)
        if not c.get("folders"):
            empty = row("Nothing shared yet", "Add a folder (+) so teammates can work in it")
            f.add(empty)
        page.add(f)

        a = Adw.PreferencesGroup(title="Recent activity")
        jobs = (st.get("jobs") or [])[-8:]
        for j in reversed(jobs):
            r = row(f"{OPS.get(j['op'], j['op'])} {j.get('what') or ''}".strip(),
                    time.strftime("%a %H:%M", time.localtime(j["at"])) + ("" if j["ok"] else " · failed"))
            r.set_title_lines(1)
            a.add(r)
        if not jobs:
            a.add(row("Nothing yet", "What teammates do here shows up in this list"))
        page.add(a)

        u = Adw.PreferencesGroup()
        out = Gtk.Button(label="Unlink this computer", halign=CENTER, margin_top=8)
        out.add_css_class("destructive-action"), out.add_css_class("pill")
        out.connect("clicked", self._unlink)
        u.add(out)
        page.add(u)
        return page

    def _set(self, **changes) -> None:
        self.r.save({**self.r.load(), **changes})
        self.refresh()

    def _share(self, path: str, on: bool) -> None:
        try:
            self.r.share(path, on)
            self._toast(f"Sharing {Path(path).name}" if on else f"Stopped sharing {Path(path).name}")
        except ValueError as e:
            self._toast(str(e))
        self.refresh()

    def _add_folder(self, _b) -> None:
        dialog = Gtk.FileDialog(title="Share a folder with your teammates")

        def done(d, res):
            try:
                folder = d.select_folder_finish(res)
            except GLib.Error:
                return  # cancelled
            if folder and folder.get_path():
                self._share(folder.get_path(), True)
        dialog.select_folder(self, None, done)

    def _unlink(self, _b) -> None:
        d = Adw.AlertDialog(heading="Unlink this computer?",
                            body="Teammates lose access right away. You can link it again with a new code.")
        d.add_response("cancel", "Cancel")
        d.add_response("unlink", "Unlink")
        d.set_response_appearance("unlink", Adw.ResponseAppearance.DESTRUCTIVE)

        def chosen(_d, response):
            if response != "unlink":
                return
            c = self.r.load()
            threading.Thread(target=lambda: self.r.api(c, "/runner/unlink", {}), daemon=True).start()
            self.r.save({k: v for k, v in c.items() if k not in ("token", "id")})
            self.refresh()
        d.connect("response", chosen)
        d.present(self)

    def _toast(self, text: str) -> None:
        self.toasts.add_toast(Adw.Toast(title=text))


def main(runner) -> None:
    app = Adw.Application(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
    app.connect("activate", lambda a: (a.get_active_window() or Window(a, runner)).present())
    app.run(None)
