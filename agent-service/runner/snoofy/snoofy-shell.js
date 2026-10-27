// Windows for the Tubelight driver: GNOME on Wayland lets no app move another app's window, so the shell does it.
// D-Bus, on the shell's own name: org.gnome.Shell /studio/stepwise/Snoofy studio.stepwise.Snoofy
//   List() -> JSON {windows, monitors}            every normal window and every monitor's work area
//   Place(JSON) -> JSON {window}                  one window: monitor, size/place, state, focus, in one call
// Geometry is worked out here so a move is one round trip.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const XML = `<node><interface name="studio.stepwise.Snoofy">
  <method name="List"><arg type="s" direction="out" name="json"/></method>
  <method name="Place"><arg type="s" direction="in" name="json"/><arg type="s" direction="out" name="json"/></method>
</interface></node>`;

function maximized(w) {
    return typeof w.is_maximized === 'function' ? w.is_maximized() : w.get_maximized() === Meta.MaximizeFlags.BOTH;
}

function call(w, name) {  // GNOME 49 dropped the flags argument of maximize/unmaximize
    try {
        w[name]();
    } catch (e) {
        w[name](Meta.MaximizeFlags.BOTH);
    }
}

function info(w) {
    const r = w.get_frame_rect();
    return {
        id: String(w.get_id()), title: w.get_title() ?? '', app: w.get_wm_class() ?? '', pid: w.get_pid(),
        monitor: w.get_monitor(), x: r.x, y: r.y, w: r.width, h: r.height, maximized: maximized(w),
        fullscreen: w.is_fullscreen(), minimized: w.minimized, focused: w.has_focus(),
        resizable: w.resizeable ?? true,
    };
}

function windows() {
    return global.get_window_actors().map(a => a.meta_window)
        .filter(w => !w.skip_taskbar && [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG].includes(w.get_window_type()));
}

function monitors() {
    const ws = global.workspace_manager.get_active_workspace();
    return Main.layoutManager.monitors.map((m, i) => {
        const a = ws.get_work_area_for_monitor(i);
        return {index: i, x: m.x, y: m.y, w: m.width, h: m.height, primary: i === Main.layoutManager.primaryIndex,
            area: {x: a.x, y: a.y, w: a.width, h: a.height}};
    });
}

const later = new Map();  // window id -> re-placements still to come (a newer Place cancels them)

function cancel(id) {
    for (const src of later.get(id) ?? [])
        GLib.source_remove(src);
    later.delete(id);
}

class Service {
    List() {
        return JSON.stringify({windows: windows().map(info), monitors: monitors()});
    }

    // {id, monitor?, frac?: [x, y, w, h] of the work area, px?: [x, y, w, h] inside the work area,
    //  state?: maximize|unmaximize|minimize|restore|fullscreen|unfullscreen, focus?: bool}
    Place(json) {
        const a = JSON.parse(json);
        const w = windows().find(x => String(x.get_id()) === String(a.id));
        if (!w)
            throw new Error(`No window ${a.id}: list them again`);
        cancel(String(a.id));
        if (w.minimized && a.state !== 'minimize')
            w.unminimize();
        if (w.is_fullscreen() && (a.frac || a.px || a.state === 'unfullscreen' || a.state === 'maximize'))
            w.unmake_fullscreen();
        const n = Main.layoutManager.monitors.length;
        const mon = a.monitor ?? w.get_monitor();
        if (mon < 0 || mon >= n)
            throw new Error(`No monitor ${mon}: there are ${n}`);
        const box = a.frac || a.px;
        let target = null;  // the frame it should end up with, for the caller to wait on
        const wasMax = box && maximized(w);
        if (wasMax)
            call(w, 'unmaximize');
        if (mon !== w.get_monitor()) {
            const was = maximized(w);
            if (was)
                call(w, 'unmaximize');
            w.move_to_monitor(mon);
            if (was && !box)
                call(w, 'maximize');
        }
        if (box) {
            const r = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(mon);
            const [x, y, ww, hh] = a.frac
                ? [r.x + a.frac[0] * r.width, r.y + a.frac[1] * r.height, a.frac[2] * r.width, a.frac[3] * r.height]
                : [r.x + a.px[0], r.y + a.px[1], a.px[2], a.px[3]];
            target = [Math.round(x), Math.round(y), Math.round(ww), Math.round(hh)];
            const put = () => w.move_resize_frame(true, Math.round(x), Math.round(y), Math.round(ww), Math.round(hh));
            put();
            if (wasMax) {  // un-maximizing restores the old size after this call: place it again once that's done
                const id = String(a.id);
                later.set(id, [
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { put(); return GLib.SOURCE_REMOVE; }),
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { put(); later.delete(id); return GLib.SOURCE_REMOVE; }),
                ]);
            }
        }
        if (a.state === 'maximize' || (maximized(w) && !box && a.monitor !== undefined)) {
            const r = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(mon);
            target = [r.x, r.y, r.width, r.height];
        }
        if (a.state === 'maximize')
            call(w, 'maximize');
        else if (a.state === 'unmaximize')
            call(w, 'unmaximize');
        else if (a.state === 'minimize')
            w.minimize();
        else if (a.state === 'fullscreen')
            w.make_fullscreen();
        else if (a.state === 'unfullscreen')
            w.unmake_fullscreen();
        if (a.focus)
            Main.activateWindow(w);
        return JSON.stringify({window: info(w), target});
    }
}

export default class TubelightWindows extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(XML, new Service());
        this._dbus.export(Gio.DBus.session, '/studio/stepwise/Snoofy');
    }

    disable() {
        for (const id of [...later.keys()])
            cancel(id);
        this._dbus?.unexport();
        this._dbus = null;
    }
}
