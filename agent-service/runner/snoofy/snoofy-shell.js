// Snoofy's part inside GNOME Shell: on Wayland no app may move another app's window, take a global shortcut or draw
// over other apps, so the shell does those for it.
// D-Bus, on the shell's own name: org.gnome.Shell /studio/stepwise/Snoofy studio.stepwise.Snoofy
//   List() -> JSON {windows, monitors}            every normal window and every monitor's work area
//   Place(JSON) -> JSON {window}                  one window: monitor, size/place, state, focus, in one call
//   Hotkey(accel) -> ok                           take a global shortcut ("<Super>z", "" to let it go)
//   signal Summon()                               it was pressed
//   Pill(JSON)                                    the card by the pointer: {state, verb, turns: [{you, reply, detail}], level}
//                                                 (state "hide" closes it; its × closes it and emits Dismiss)
// Geometry is worked out here so a move is one round trip.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const XML = `<node><interface name="studio.stepwise.Snoofy">
  <method name="List"><arg type="s" direction="out" name="json"/></method>
  <method name="Place"><arg type="s" direction="in" name="json"/><arg type="s" direction="out" name="json"/></method>
  <method name="Hotkey"><arg type="s" direction="in" name="accel"/><arg type="b" direction="out" name="ok"/></method>
  <method name="Pill"><arg type="s" direction="in" name="json"/></method>
  <signal name="Summon"/>
  <signal name="Dismiss"/>
</interface></node>`;

// The card by the pointer while an agent listens and works: a blue gradient, a line that says what it's doing (a
// turning ring while it works, a dot that breathes and swells with the voice while it listens) and the whole
// conversation of the session, wrapped and scrollable, so nothing it says is cut off. × (or the shortcut) stops it.
// Motion: transitions.dev feel (ease-out, 200-320 ms, 4-6 px). Loops are Clutter transitions, never per-frame timers;
// the only frame callback is the fade of freshly streamed words, and it stops as soon as they're in.
const INK = '#ffffff';
const DIM = 'rgba(255,255,255,0.6)';
const SANS = 'font-family: Inter, sans-serif;';
const DISPLAY = 'font-family: Inter Display, Inter, sans-serif;';
const OUT = Clutter.AnimationMode.EASE_OUT_CUBIC;
const VERB = {listening: 'Listening', thinking: 'Thinking', working: 'Working', speaking: 'Speaking', done: '', error: ''};
const ROLES = [
    ['you', `${SANS} color: ${DIM}; font-size: 13px;`],
    ['reply', `${SANS} color: ${INK}; font-size: 15px; font-weight: 500;`],
    ['detail', `${SANS} color: rgba(255,255,255,0.78); font-size: 13px; padding-top: 2px;`],
];
const DOT = c => `width: 20px; height: 20px; border-radius: 10px; background-color: ${c}; box-shadow: 0 0 12px rgba(255,255,255,0.4);`;
const CLOSE = 'border-radius: 99px; padding: 5px;';
// Round marks are drawn at their largest size and scaled down: St draws a corner radius into a texture at the actor's
// own size, so a 10 px circle scaled up 2.7x came out as a blurry squircle.
const DOT_REST = 0.5;  // the dot's resting scale (10 px)
const FADE_US = 300000;  // streamed words fade in over this

function vbox(params) {  // GNOME 48 replaced `vertical` with `orientation`
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function text(style) {
    const label = new St.Label({style, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function enter(actor, dy, opacity = 255, duration = 280, delay = 0) {  // fade + small rise; translation never moves the layout
    actor.opacity = 0;
    actor.translation_y = dy;
    actor.ease({opacity, translation_y: 0, duration, delay, mode: OUT});
}

const esc = s => GLib.markup_escape_text(s, -1);

// A wrapped label whose text streams in: each newly arrived run of words fades from faint to full on its own clock,
// in place, so the layout only grows (no re-flow jitter, no flashing of what was already there).
class Line {
    constructor(style) {
        this.label = text(style);
        this.shown = '';
        this.runs = [];  // [{at: char index, t0: µs}] still fading
        this.tl = null;
    }

    set(s) {
        if (s === this.shown)
            return;
        const grows = this.shown && s.startsWith(this.shown);
        if (grows)
            this.runs.push({at: this.shown.length, t0: GLib.get_monotonic_time()});
        else
            this.runs = [];
        this.shown = s;
        this.draw();
        if (this.runs.length && !this.tl) {
            this.tl = new Clutter.Timeline({actor: this.label, duration: 1000, repeat_count: -1});
            this.tl.connect('new-frame', () => this.draw());
            this.tl.start();
        }
    }

    draw() {
        const now = GLib.get_monotonic_time();
        while (this.runs.length && now - this.runs[0].t0 >= FADE_US)
            this.runs.shift();
        if (!this.runs.length) {
            this.stop();
            this.label.clutter_text.set_markup(esc(this.shown));
            return;
        }
        let out = esc(this.shown.slice(0, this.runs[0].at));
        this.runs.forEach((r, i) => {
            const p = Math.min(1, (now - r.t0) / FADE_US);
            const a = 0.18 + 0.82 * (1 - (1 - p) ** 3);
            const part = this.shown.slice(r.at, this.runs[i + 1]?.at ?? this.shown.length);
            out += `<span alpha="${Math.max(1, Math.round(a * 100))}%">${esc(part)}</span>`;
        });
        this.label.clutter_text.set_markup(out);
    }

    stop() {
        this.tl?.stop();
        this.tl = null;
    }
}

class Pill {
    constructor(stop) {
        this.box = vbox({
            style: 'width: 380px; padding: 14px 14px 14px 16px; spacing: 12px; border-radius: 24px;' +
                   'background-gradient-direction: vertical; background-gradient-start: #3f7cff; background-gradient-end: #1f50e3;' +
                   'border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 14px 36px rgba(14,36,120,0.34);',
            reactive: true, opacity: 0,
        });
        const head = new St.BoxLayout({style: 'spacing: 10px;'});

        // The status mark: a ripple (halo) behind a glowing dot that breathes (breath) and swells with the voice (dot);
        // a white ring with one bright side turns in its place while it thinks or works (GNOME's spinner won't take
        // a colour).
        const mark = new St.Widget({layout_manager: new Clutter.BinLayout(), style: 'width: 18px; height: 18px;',
            y_align: Clutter.ActorAlign.CENTER});
        const centred = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};
        this.halo = new St.Widget({style: 'width: 28px; height: 28px; border-radius: 14px; background-color: rgba(255,255,255,0.5);',
            ...centred, opacity: 0});
        this.breath = new St.Widget({layout_manager: new Clutter.BinLayout(), ...centred});
        this.dot = new St.Widget({style: DOT(INK), ...centred, scale_x: DOT_REST, scale_y: DOT_REST});
        this.breath.add_child(this.dot);
        this.spinner = new St.Widget({style: 'width: 11px; height: 11px; border-radius: 99px; border: 2px solid rgba(255,255,255,0.22);' +
            `border-top-color: ${INK}; border-right-color: ${INK};`, ...centred, opacity: 0});
        for (const a of [this.halo, this.breath, this.dot, this.spinner])
            a.set_pivot_point(0.5, 0.5);
        for (const a of [this.halo, this.breath, this.spinner])
            mark.add_child(a);

        // The verb: labels stacked in one cell, so a change cross-fades (old rises out, new rises in).
        this.verbs = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this.verb = null;
        this.verbKey = null;

        const close = new St.Button({style: CLOSE, can_focus: false, y_align: Clutter.ActorAlign.CENTER, opacity: 170,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14, style: `color: ${INK}; -st-icon-style: symbolic; icon-shadow: 0 0 0.6px ${INK};`})});
        close.connect('notify::hover', () => {
            close.set_style(close.hover ? `${CLOSE} background-color: rgba(255,255,255,0.14);` : CLOSE);
            close.ease({opacity: close.hover ? 255 : 170, duration: 160, mode: OUT});
        });
        close.connect('clicked', () => stop());
        for (const a of [mark, this.verbs, close])
            head.add_child(a);

        this.turns = vbox({style: 'spacing: 14px; padding-right: 4px;'});
        this.scroll = new St.ScrollView({style: 'max-height: 300px; -st-vfade-offset: 28px;', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, visible: false});
        if (this.scroll.set_child)
            this.scroll.set_child(this.turns);
        else
            this.scroll.add_actor(this.turns);
        this.adj = this.scroll.vadjustment ?? this.scroll.vscroll?.adjustment;
        this.stick = true;  // follow the newest words unless they scrolled up to read
        this.adj?.connect('notify::upper', () => {
            if (this.stick)
                this.adj.ease(Math.max(0, this.adj.upper - this.adj.page_size), {duration: 240, mode: OUT});
        });
        this.box.add_child(head);
        this.box.add_child(this.scroll);
        this.items = [];  // [{t: {you, reply, detail}, actor, lines: {role: Line}}]

        Main.layoutManager.addTopChrome(this.box);  // takes input: × and scrolling a long answer
        const [x, y] = global.get_pointer();
        this.at = {x, y, m: Main.layoutManager.monitors.find(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            ?? Main.layoutManager.primaryMonitor};
        this.target = null;
        this.box.connect('notify::height', () => this.place());
        this.box.set_pivot_point(0, 0);  // grows out of the pointer's corner
        this.box.scale_x = this.box.scale_y = 0.96;
        this.box.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 260, mode: OUT});
    }

    // {state, verb?, turns?: [{you, reply, detail}], level?}
    set(a) {
        if (a.state)
            this.mode(a.state, a.verb);
        if (a.level !== undefined && (this.state === 'listening' || this.state === 'speaking')) {
            const k = DOT_REST * (1 + Math.min(1, Math.max(0, a.level)) ** 0.6 * 0.85);
            this.dot.ease({scale_x: k, scale_y: k, duration: k > this.dot.scale_x ? 110 : 260,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        if (a.turns)
            this.show(a.turns);
        this.place();
    }

    mode(state, verb) {
        this.word(verb || VERB[state] || '', state === 'done', state === 'error');
        if (state === this.state)
            return;
        this.state = state;
        const busy = state === 'working' || state === 'thinking';
        this.halo.remove_all_transitions();
        this.breath.remove_all_transitions();
        this.halo.opacity = 0;
        if (busy) {
            this.dot.ease({scale_x: DOT_REST, scale_y: DOT_REST, duration: 160, mode: OUT});
            this.breath.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 160, mode: OUT});
            if (!this.turning) {
                this.turning = true;
                this.spinner.rotation_angle_z = 0;
                this.spinner.ease({rotation_angle_z: 360, duration: 900, mode: Clutter.AnimationMode.LINEAR, repeatCount: -1});
            }
            this.spinner.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 200, mode: OUT});
            return;
        }
        if (this.turning) {
            this.turning = false;
            this.spinner.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 160, mode: OUT,
                onComplete: () => this.spinner.remove_transition('rotation-angle-z')});
        }
        this.dot.set_style(DOT(state === 'error' ? '#ffb3a8' : INK));
        const calm = state === 'done' || state === 'error';
        this.breath.ease({opacity: calm ? 190 : 255, scale_x: 1, scale_y: 1, duration: 200, mode: OUT,
            onComplete: () => !calm && this.state === state && this.pulse(state === 'speaking')});
        if (calm)
            this.dot.ease({scale_x: DOT_REST, scale_y: DOT_REST, duration: 240, mode: OUT});
    }

    pulse(fast) {  // breathe in and out, and send a soft ring outward each breath
        const [s, d] = fast ? [1.22, 620] : [1.12, 1300];
        this.breath.ease({scale_x: s, scale_y: s, duration: d, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true, repeatCount: -1});
        this.halo.scale_x = this.halo.scale_y = 10 / 28;
        this.halo.opacity = 255;
        const g = (fast ? 2.4 : 2.7) * 10 / 28;
        this.halo.ease({scale_x: g, scale_y: g, opacity: 0, duration: d * 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            repeatCount: -1});
    }

    word(s, dim, wrap) {  // one line that ellipsizes (steady while verbs change); an error wraps so it's read whole
        const key = `${dim}|${wrap}|${s}`;
        if (key === this.verbKey)
            return;
        this.verbKey = key;
        const old = this.verb;
        this.verb = new St.Label({text: s, x_expand: true, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
            style: `${DISPLAY} color: ${dim ? DIM : INK}; font-size: 13px; font-weight: 600;`});
        this.verb.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        this.verb.clutter_text.line_wrap = wrap;
        this.verbs.add_child(this.verb);
        if (old) {
            old.remove_all_transitions();
            old.ease({opacity: 0, translation_y: -4, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => old.destroy()});
            enter(this.verb, 4, 255, 240, 70);  // the old word is mostly gone first
        }
    }

    // The turns arrive whole every time (the last few). Match them to what's drawn (by what was said, since the window
    // slides), update those in place, and let only the new turns and lines rise in.
    show(turns) {
        if (this.adj)
            this.stick = this.adj.value + this.adj.page_size >= this.adj.upper - 24;
        const same = (o, n) => !o.you || !n.you || o.you.startsWith(n.you) || n.you.startsWith(o.you);
        let k = 0;
        while (k < this.items.length && !this.items.slice(k).every((it, j) => j >= turns.length || same(it.t, turns[j])))
            k++;
        for (const it of this.items.splice(0, k))
            this.drop(it);
        turns.forEach((t, i) => {
            let it = this.items[i];
            const fresh = !it;
            if (fresh) {
                it = {actor: vbox({style: 'spacing: 4px;'}), lines: {}};
                this.items.push(it);
                this.turns.add_child(it.actor);
            }
            it.t = t;
            ROLES.forEach(([role, style], r) => {
                if (!t[role] && !it.lines[role])
                    return;
                let line = it.lines[role];
                if (!line) {
                    line = it.lines[role] = new Line(style);
                    const before = ROLES.slice(0, r).filter(([q]) => it.lines[q]).length;
                    it.actor.insert_child_at_index(line.label, before);
                    line.set(t[role]);
                    if (!fresh)
                        enter(line.label, 4, 255, 240);
                    return;
                }
                line.set(t[role] || '');
                line.label.visible = !!t[role];
            });
            const last = i === turns.length - 1;
            if (fresh)
                enter(it.actor, 6, last ? 255 : 170, 300);
            else if (it.dim !== !last)
                it.actor.ease({opacity: last ? 255 : 170, duration: 240, mode: OUT});
            it.dim = !last;
        });
        for (const it of this.items.splice(turns.length))
            this.drop(it);
        this.scroll.visible = turns.length > 0;
    }

    drop(it) {
        for (const line of Object.values(it.lines))
            line.stop();
        it.actor.destroy();
    }

    place() {  // below-right of the pointer, kept on its monitor; slides if it has to move
        const {x, y, m} = this.at;
        const [w, h] = this.box.get_size();
        const to = [Math.min(Math.max(x + 18, m.x + 12), m.x + m.width - w - 12),
            Math.min(Math.max(y + 22, m.y + 12), m.y + m.height - h - 12)].map(Math.round);
        if (!this.target)
            this.box.set_position(...to);
        else if (to[0] !== this.target[0] || to[1] !== this.target[1])
            this.box.ease({x: to[0], y: to[1], duration: 220, mode: OUT});
        this.target = to;
    }

    quiet() {  // stop every loop and fade
        for (const it of this.items)
            Object.values(it.lines).forEach(l => l.stop());
        for (const a of [this.spinner, this.halo, this.breath])
            a.remove_all_transitions();
    }

    close() {
        const box = this.box;
        this.quiet();
        box.reactive = false;
        box.ease({opacity: 0, scale_x: 0.98, scale_y: 0.98, duration: 180, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                Main.layoutManager.removeChrome(box);
                box.destroy();
            }});
    }
}

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
    constructor(summon, dismiss) {
        this._summon = summon;
        this._dismiss = dismiss;
        this._grab = 0;
        this._pill = null;
        this._pressed = global.display.connect('accelerator-activated', (_d, action) => {
            if (action === this._grab)
                this._summon();
        });
    }

    Hotkey(accel) {
        this.release();
        if (!accel)
            return true;
        const id = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.NONE);
        if (id === Meta.KeyBindingAction.NONE)
            return false;  // malformed, or another app holds it
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(id),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
        this._grab = id;
        return true;
    }

    Pill(json) {
        const a = JSON.parse(json);
        if (a.state === 'hide') {
            this._pill?.close();
            this._pill = null;
            return;
        }
        this._pill ??= new Pill(() => {
            this._pill?.close();
            this._pill = null;
            this._dismiss();
        });
        this._pill.set(a);
    }

    release() {
        if (this._grab)
            global.display.ungrab_accelerator(this._grab);
        this._grab = 0;
    }

    destroy() {
        this.release();
        global.display.disconnect(this._pressed);
        if (this._pill) {
            this._pill.quiet();
            Main.layoutManager.removeChrome(this._pill.box);
            this._pill.box.destroy();
        }
    }

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
        else if (a.state === 'close')
            w.delete(global.get_current_time());  // as its close button: the app may ask about unsaved work
        if (a.focus)
            Main.activateWindow(w);
        return JSON.stringify({window: info(w), target});
    }
}

export default class Snoofy extends Extension {
    enable() {
        this._service = new Service(() => this._dbus?.emit_signal('Summon', null), () => this._dbus?.emit_signal('Dismiss', null));
        this._dbus = Gio.DBusExportedObject.wrapJSObject(XML, this._service);
        this._dbus.export(Gio.DBus.session, '/studio/stepwise/Snoofy');
    }

    disable() {
        for (const id of [...later.keys()])
            cancel(id);
        this._service?.destroy();
        this._service = null;
        this._dbus?.unexport();
        this._dbus = null;
    }
}
