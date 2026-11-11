// Port of BongoDesktopWidget.qml.
//
// GNOME has no "desktop widget" concept. We add an actor to
// Main.layoutManager._backgroundGroup (above the wallpaper, below all
// windows). That is a private field, but it is what the established
// desktop-widget extensions use. Drag with the left button to move,
// right click toggles sleep.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CatView} from './catView.js';
import {aspectRatio} from './catDraw.js';

export const DesktopWidget = GObject.registerClass(
class DesktopWidget extends St.Widget {
    _init(ctx) {
        super._init({
            reactive: true,
            track_hover: true,
            style_class: 'bongo-cat-desktop',
            layout_manager: new Clutter.BinLayout(),
        });
        this._ctx = ctx;
        this._grab = null;
        this._dragOffset = null;

        const box = new St.BoxLayout({x_expand: true, y_expand: true});
        box.get_layout_manager().set_orientation(Clutter.Orientation.VERTICAL);
        this._cat = new CatView(ctx, {
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            style_class: 'bongo-cat-desktop-cat',
        });
        this._metrics = new St.Label({x_align: Clutter.ActorAlign.CENTER, style_class: 'bongo-cat-desktop-metrics'});
        box.add_child(this._cat);
        box.add_child(this._metrics);
        this.add_child(box);

        Main.layoutManager._backgroundGroup.add_child(this);

        ctx.model.connectObject(
            'changed', () => this.repaint(),
            'metrics-changed', () => this._syncMetrics(),
            this);
        ctx.settings.connectObject('changed', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._syncPosition(), this);
        this._sync();
    }

    _sync() {
        const {settings} = this._ctx;
        const w = settings.get_int('desktop-widget-size');
        const h = Math.round(w * 0.8);
        this.set_size(w, h);

        const opacity = settings.get_int('desktop-background-opacity') / 100;
        const pad = opacity > 0 ? 8 : 0;
        this.set_style(
            `background-color: rgba(36, 36, 40, ${opacity});` +
            `border: 1px solid rgba(255, 255, 255, ${opacity > 0 ? 0.2 * opacity : 0});` +
            `padding: ${pad}px;`);

        const showMetrics = settings.get_boolean('desktop-show-metrics');
        // Same sizing rule as the QML: ~75 % of the width, 70-85 % of the height.
        const innerW = w - 2 * pad, innerH = h - 2 * pad;
        const aspect = aspectRatio(settings.get_string('cat-skin'));
        this._cat.setCatHeight(Math.max(16, Math.min(innerW * 0.9 / aspect, innerH * (showMetrics ? 0.7 : 0.85))));
        this._metrics.visible = showMetrics;
        this._syncMetrics();
        this._syncPosition();
    }

    _syncMetrics() {
        const {model} = this._ctx;
        this._metrics.text = `${model.liveWpm} WPM · ${model.cleanPercent}%`;
        this._metrics.opacity = model.forceSleep ? 128 : 230;
    }

    _syncPosition() {
        if (this._grab)
            return;
        const {settings} = this._ctx;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        let x = settings.get_int('desktop-widget-x');
        let y = settings.get_int('desktop-widget-y');
        if (x < 0 || y < 0) {
            // Default: bottom-right corner of the primary monitor.
            x = monitor.x + monitor.width - this.width - 48;
            y = monitor.y + monitor.height - this.height - 96;
        }
        // Keep it reachable if monitors changed.
        x = Math.max(0, Math.min(x, global.stage.width - this.width));
        y = Math.max(0, Math.min(y, global.stage.height - this.height));
        this.set_position(x, y);
    }

    repaint() {
        this._cat.queue_repaint();
        this._syncMetrics();
    }

    vfunc_button_press_event(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._ctx.model.toggleForceSleep();
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_PRIMARY && !this._grab) {
            const [sx, sy] = event.get_coords();
            this._dragOffset = [sx - this.x, sy - this.y];
            this._grab = global.stage.grab(this);
            this.add_style_pseudo_class('active');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        this.set_position(Math.round(sx - this._dragOffset[0]), Math.round(sy - this._dragOffset[1]));
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag();
        const {settings} = this._ctx;
        settings.set_int('desktop-widget-x', Math.max(0, Math.round(this.x)));
        settings.set_int('desktop-widget-y', Math.max(0, Math.round(this.y)));
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this.remove_style_pseudo_class('active');
    }

    destroy() {
        this._endDrag();
        super.destroy();
    }
});
