// Port of BongoWidget.qml: the bar "pill" becomes a top-bar PanelMenu.Button
// and the DMS popout becomes its PopupMenu.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CatView} from './catView.js';
import {scanKeyboards} from './system.js';

const PANEL_CAT_HEIGHT = 20; // px at 100 % (GNOME's top bar is ~32 px high)
const HERO_CAT_HEIGHT = 80;

function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    // `vertical` is deprecated since GNOME 48; the layout manager property
    // works on every supported version.
    box.get_layout_manager().set_orientation(Clutter.Orientation.VERTICAL);
    return box;
}

/** A labelled slider bound to an integer GSettings key. */
const SliderRow = GObject.registerClass(
class SliderRow extends PopupMenu.PopupBaseMenuItem {
    _init(settings, {key, icon, label, min, max, step = 1, unit, reset}) {
        super._init({activate: false, style_class: 'bongo-cat-slider-row'});
        this._settings = settings;
        this._key = key;
        this._min = min;
        this._max = max;
        this._step = step;
        this._unit = unit;
        this._syncing = false;
        this._saveId = 0;

        this.add_child(new St.Icon({icon_name: icon, style_class: 'popup-menu-icon'}));
        this.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER, style_class: 'bongo-cat-slider-label'}));
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = label;
        this.add_child(this._slider);
        this._valueLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'bongo-cat-slider-value'});
        this.add_child(this._valueLabel);
        this._resetButton = new St.Button({
            style_class: 'bongo-cat-reset-button',
            child: new St.Icon({icon_name: 'edit-undo-symbolic', icon_size: 14}),
            accessible_name: _('Reset'),
        });
        this._resetButton.connect('clicked', () => settings.set_int(key, reset));
        this._reset = reset;
        this.add_child(this._resetButton);

        // Clicking anywhere on the row drags the slider (like GNOME's volume rows).
        this.connect('button-press-event', (actor, event) => this._slider.startDragging(event));
        this._slider.connect('notify::value', () => this._onSliderChanged());
        this._slider.connect('drag-end', () => this._flush());
        settings.connectObject(`changed::${key}`, () => this.sync(), this);
        this.connect('destroy', () => {
            if (this._saveId)
                GLib.source_remove(this._saveId);
            this._saveId = 0;
        });
        this.sync();
    }

    _currentValue() {
        const raw = this._min + this._slider.value * (this._max - this._min);
        return Math.round(raw / this._step) * this._step;
    }

    _onSliderChanged() {
        if (this._syncing)
            return;
        this._updateLabel(this._currentValue());
        // Debounce writes while dragging so we don't hammer dconf.
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._saveId = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        const v = this._currentValue();
        if (this._settings.get_int(this._key) !== v)
            this._settings.set_int(this._key, v);
    }

    _updateLabel(v) {
        this._valueLabel.text = `${v}${this._unit}`;
        this._resetButton.opacity = v !== this._reset ? 230 : 64;
        this._resetButton.reactive = v !== this._reset;
    }

    sync() {
        const v = this._settings.get_int(this._key);
        this._syncing = true;
        this._slider.value = (v - this._min) / (this._max - this._min);
        this._syncing = false;
        this._updateLabel(v);
    }
});

export const BongoIndicator = GObject.registerClass(
class BongoIndicator extends PanelMenu.Button {
    _init(ctx) {
        super._init(0.5, 'Bongo Cat', false);
        this._ctx = ctx;
        const {settings, model, input} = ctx;

        // ---- panel content ("pill") ----
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box bongo-cat-panel-box'});
        this._cat = new CatView(ctx, {style_class: 'bongo-cat-panel-cat'});
        this._metricsLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'bongo-cat-panel-metrics'});
        this._warnIcon = new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'system-status-icon bongo-cat-warning-icon'});
        box.add_child(this._cat);
        box.add_child(this._metricsLabel);
        box.add_child(this._warnIcon);
        this.add_child(box);

        this.menu.box.add_style_class_name('bongo-cat-menu');
        this._buildMenu();

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._rebuildDevices();
                this._sync();
            }
        });

        model.connectObject(
            'changed', () => this._onModelChanged(),
            'metrics-changed', () => this._syncMetrics(),
            this);
        settings.connectObject('changed', () => this._sync(), this);
        input.connectObject('status-changed', () => this._syncWarnings(), this);
        this._sync();
    }

    // Right click toggles sleep, any other click opens the popout.
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._ctx.model.toggleForceSleep();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    // ---- popout -----------------------------------------------------------

    _buildMenu() {
        const {settings, model} = this._ctx;

        // Warning card (input tool / group problems)
        this._warnItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'bongo-cat-warning-item'});
        this._warnLabel = new St.Label({style_class: 'bongo-cat-warning', x_expand: true});
        this._warnLabel.clutter_text.line_wrap = true;
        this._warnItem.add_child(this._warnLabel);
        this.menu.addMenuItem(this._warnItem);

        // Hero stage with the big cat and the Awake/Asleep chip
        const heroItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'bongo-cat-hero-item'});
        this._hero = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'bongo-cat-hero', x_expand: true});
        this._heroCat = new CatView(this._ctx, {
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'bongo-cat-hero-cat',
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._heroCat.setCatHeight(HERO_CAT_HEIGHT);
        this._hero.add_child(this._heroCat);

        this._chipIcon = new St.Icon({icon_size: 14});
        this._chipLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        const chipBox = new St.BoxLayout({style_class: 'bongo-cat-chip-box'});
        chipBox.add_child(this._chipIcon);
        chipBox.add_child(this._chipLabel);
        this._chip = new St.Button({
            style_class: 'bongo-cat-chip',
            child: chipBox,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            can_focus: true,
        });
        this._chip.connect('clicked', () => model.toggleForceSleep());
        this._hero.add_child(this._chip);
        heroItem.add_child(this._hero);
        this.menu.addMenuItem(heroItem);

        // Metric tiles
        this._metricsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'bongo-cat-metrics-item'});
        const tiles = new St.BoxLayout({x_expand: true, style_class: 'bongo-cat-tiles'});
        const makeTile = caption => {
            const tile = vbox({x_expand: true, style_class: 'bongo-cat-tile'});
            const value = new St.Label({style_class: 'bongo-cat-tile-value', x_align: Clutter.ActorAlign.CENTER});
            tile.add_child(value);
            tile.add_child(new St.Label({text: caption, style_class: 'bongo-cat-tile-caption', x_align: Clutter.ActorAlign.CENTER}));
            tiles.add_child(tile);
            return value;
        };
        this._wpmValue = makeTile(_('WPM'));
        this._cleanValue = makeTile(_('Clean'));
        this._metricsItem.add_child(tiles);
        this.menu.addMenuItem(this._metricsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Keyboard device selector
        this._deviceMenu = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._deviceMenu.icon.icon_name = 'input-keyboard-symbolic';
        this.menu.addMenuItem(this._deviceMenu);
        this._deviceOptions = [];

        // Skin selector
        this._skinMenu = this._choiceMenu('applications-graphics-symbolic', 'cat-skin', () => [
            ['classic', _('Classic (Vector)')],
            ['pixel', _('Pixel Doodle')],
        ]);
        // Cat colour (vector skin) / pixel colourway (pixel skin)
        this._colorMenu = this._choiceMenu('applications-graphics-symbolic', 'cat-color-mode', () => [
            ['classic', _('Classic B/W')],
            ['accent', _('Accent Color')],
            ['custom', _('Custom')],
        ]);
        this._pixelColorMenu = this._choiceMenu('applications-graphics-symbolic', 'pixel-skin-color', () => [
            ['white', _('Classic White')],
            ['black', _('Midnight Black')],
            ['orange', _('Ginger Orange')],
            ['calico', _('Calico')],
            ['siamese', _('Siamese')],
            ['pink', _('Sakura Pink')],
            ['cyberpunk', _('Cyberpunk')],
            ['zombie', _('Zombie')],
        ]);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Sliders: size, sleep timeout, paw hold
        this.menu.addMenuItem(new SliderRow(settings, {
            key: 'cat-size-percent', icon: 'zoom-in-symbolic', label: _('Size'),
            min: 50, max: 200, step: 5, unit: '%', reset: 100,
        }));
        this.menu.addMenuItem(new SliderRow(settings, {
            key: 'waiting-timeout', icon: 'weather-clear-night-symbolic', label: _('Sleep'),
            min: 1, max: 10, unit: 's', reset: 5,
        }));
        this.menu.addMenuItem(new SliderRow(settings, {
            key: 'paw-hold-time', icon: 'alarm-symbolic', label: _('Paw'),
            min: 0, max: 100, step: 5, unit: 'ms', reset: 0,
        }));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Quick toggles: blink / sound / stats
        this._toggles = {};
        for (const [key, label] of [
            ['enable-blinking', _('Blink')],
            ['sound-enabled', _('Sound')],
            ['show-metrics', _('Stats')],
        ]) {
            const item = new PopupMenu.PopupSwitchMenuItem(label, settings.get_boolean(key));
            item.connect('toggled', (i, state) => settings.set_boolean(key, state));
            this.menu.addMenuItem(item);
            this._toggles[key] = item;
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._hintItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const hint = new St.Label({text: _('Right-click bar icon to toggle sleep mode.'), style_class: 'bongo-cat-hint', x_expand: true});
        hint.clutter_text.line_wrap = true;
        this._hintItem.add_child(hint);
        this.menu.addMenuItem(this._hintItem);

        this.menu.addAction(_('Settings'), () => this._ctx.openPreferences());
    }

    /** Submenu acting like the DMS DDropdown, bound to a string key. */
    _choiceMenu(icon, key, optionsFn) {
        const {settings} = this._ctx;
        const sub = new PopupMenu.PopupSubMenuMenuItem('', true);
        sub.icon.icon_name = icon;
        const options = optionsFn();
        const items = options.map(([value, label]) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => settings.set_string(key, value));
            sub.menu.addMenuItem(item);
            return [value, item];
        });
        sub._bongoSync = () => {
            const current = settings.get_string(key);
            const found = options.find(([v]) => v === current) ?? options[0];
            sub.label.text = found[1];
            for (const [value, item] of items)
                item.setOrnament(value === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        };
        this.menu.addMenuItem(sub);
        return sub;
    }

    _rebuildDevices() {
        const {settings} = this._ctx;
        const options = [['all', _('All Keyboards (Auto)')]];
        for (const d of scanKeyboards())
            options.push([d.path, d.label]);
        const current = settings.get_string('selected-device-path');
        // Keep a previously-chosen device visible even if it is unplugged.
        if (!options.some(([p]) => p === current))
            options.push([current, current]);
        this._deviceOptions = options;

        this._deviceMenu.menu.removeAll();
        for (const [path, label] of options) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(path === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => settings.set_string('selected-device-path', path));
            this._deviceMenu.menu.addMenuItem(item);
        }
    }

    // ---- syncing ----------------------------------------------------------

    _onModelChanged() {
        this._cat.queue_repaint();
        if (this.menu.isOpen) {
            this._heroCat.queue_repaint();
            this._syncHero();
        }
    }

    _syncHero() {
        const {settings, model} = this._ctx;
        const active = model.isActive;
        this._hero.style_class = active && settings.get_string('cat-color-mode') === 'classic'
            ? 'bongo-cat-hero active' : 'bongo-cat-hero';
        this._heroCat.ease({
            scale_x: active ? 1.0 : 0.94,
            scale_y: active ? 1.0 : 0.94,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._chipIcon.icon_name = model.forceSleep ? 'weather-clear-night-symbolic' : 'weather-clear-symbolic';
        this._chipLabel.text = model.forceSleep ? _('Asleep') : _('Awake');
        if (model.forceSleep)
            this._chip.add_style_pseudo_class('checked');
        else
            this._chip.remove_style_pseudo_class('checked');
    }

    _syncMetrics() {
        const {settings, model} = this._ctx;
        const show = settings.get_boolean('show-metrics');
        this._metricsLabel.visible = show && settings.get_boolean('metrics-in-bar');
        this._metricsLabel.text = `${model.liveWpm} · ${model.cleanPercent}%`;
        this._metricsLabel.opacity = model.forceSleep ? 128 : 255;
        this._metricsItem.visible = show;
        this._wpmValue.text = String(model.liveWpm);
        this._cleanValue.text = `${model.cleanPercent}%`;
    }

    _syncWarnings() {
        const {input, settings} = this._ctx;
        const s = input.status;
        const lines = [];
        if (s.inputToolMissing) {
            lines.push(settings.get_string('selected-device-path') === 'all'
                ? _("The 'libinput' CLI was not found, so Auto mode can't see your keyboard. Install it (Arch: libinput-tools, Debian/Ubuntu: libinput-tools, Fedora: libinput-utils) or pick a specific keyboard below.")
                : _("'evtest' was not found — install it to monitor a specific keyboard, or switch to Auto mode."));
        }
        if (s.notInInputGroup)
            lines.push(_("Your user is not in the 'input' group, so keyboard events can't be read. Run: sudo usermod -aG input $USER — then log out and back in."));
        if (s.mouseToolMissing)
            lines.push(_("Mouse interaction needs the 'libinput' CLI — install it (Arch: libinput-tools, Debian/Ubuntu: libinput-tools, Fedora: libinput-utils) or switch the keyboard to Auto mode."));
        if (!lines.length && input.lastError)
            lines.push(input.lastError);
        this._warnLabel.text = lines.join('\n\n');
        this._warnItem.visible = lines.length > 0;
        this._warnIcon.visible = s.inputBroken;
    }

    _sync() {
        const {settings} = this._ctx;
        const scale = settings.get_int('cat-size-percent') / 100;
        this._cat.yOffset = settings.get_int('cat-y-offset');
        this._cat.setCatHeight(PANEL_CAT_HEIGHT * scale);
        this._heroCat.update();

        const pixel = settings.get_string('cat-skin') === 'pixel';
        this._colorMenu.visible = !pixel;
        this._pixelColorMenu.visible = pixel;
        for (const m of [this._skinMenu, this._colorMenu, this._pixelColorMenu])
            m._bongoSync();

        const current = settings.get_string('selected-device-path');
        const dev = this._deviceOptions.find(([p]) => p === current);
        this._deviceMenu.label.text = dev ? dev[1] : (current === 'all' ? _('All Keyboards (Auto)') : current);

        for (const [key, item] of Object.entries(this._toggles)) {
            if (item.state !== settings.get_boolean(key))
                item.setToggleState(settings.get_boolean(key));
        }
        this._hintItem.visible = settings.get_boolean('show-hints');

        this._syncHero();
        this._syncMetrics();
        this._syncWarnings();
        this._cat.queue_repaint();
        this._heroCat.queue_repaint();
    }

    repaint() {
        this._cat.queue_repaint();
        this._heroCat.queue_repaint();
    }
});
