// Port of BongoSettings.qml as a libadwaita preferences window.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {checkInputRequirements, scanKeyboards} from './lib/system.js';

const SETUP_COMMAND = 'sudo usermod -aG input $USER';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, {min, max, step = 1, subtitle = ''}) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Combo row bound to a string key. options: [[value, label], ...] */
function comboRow(settings, key, title, options, subtitle = '') {
    const model = Gtk.StringList.new(options.map(o => o[1]));
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        const idx = options.findIndex(o => o[0] === settings.get_string(key));
        if (idx >= 0 && row.selected !== idx)
            row.selected = idx;
    };
    sync();
    row.connect('notify::selected', () => {
        const opt = options[row.selected];
        if (opt && settings.get_string(key) !== opt[0])
            settings.set_string(key, opt[0]);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function bindVisible(settings, row, keys, predicate) {
    const sync = () => {
        row.visible = predicate();
    };
    for (const k of keys)
        settings.connect(`changed::${k}`, sync);
    sync();
}

export default class BongoCatPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window
        window.set_default_size(640, 760);

        // ------------------------------------------------------------------
        const general = new Adw.PreferencesPage({title: _('General'), icon_name: 'applications-graphics-symbolic'});
        window.add(general);

        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        general.add(appearance);
        appearance.add(comboRow(settings, 'cat-skin', _('Skin'), [
            ['classic', _('Classic (Vector)')],
            ['pixel', _('Pixel Doodle')],
        ]));
        appearance.add(spinRow(settings, 'cat-size-percent', _('Cat Size'), {min: 50, max: 200, step: 5, subtitle: _('Size of the cat in the top bar (%)')}));
        appearance.add(spinRow(settings, 'cat-y-offset', _('Vertical Offset'), {min: -10, max: 10, subtitle: _('Nudge the cat up or down in the top bar (px)')}));

        const pixelColor = comboRow(settings, 'pixel-skin-color', _('Pixel Cat Color'), [
            ['white', _('Classic White')], ['black', _('Midnight Black')], ['orange', _('Ginger Orange')],
            ['calico', _('Calico')], ['siamese', _('Siamese')], ['pink', _('Sakura Pink')],
            ['cyberpunk', _('Cyberpunk')], ['zombie', _('Zombie')],
        ]);
        appearance.add(pixelColor);
        bindVisible(settings, pixelColor, ['cat-skin'], () => settings.get_string('cat-skin') === 'pixel');

        const colorMode = comboRow(settings, 'cat-color-mode', _('Cat Color'), [
            ['classic', _('Classic B/W')],
            ['accent', _('Accent Color')],
            ['custom', _('Custom')],
        ], _('Classic follows the top bar text color'));
        appearance.add(colorMode);
        bindVisible(settings, colorMode, ['cat-skin'], () => settings.get_string('cat-skin') !== 'pixel');

        const customRow = new Adw.ActionRow({title: _('Custom Color')});
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const syncColor = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string('cat-custom-color')) && !rgba.equal(colorButton.rgba))
                colorButton.rgba = rgba;
        };
        syncColor();
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.rgba;
            const hex = '#' + [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            if (hex !== settings.get_string('cat-custom-color'))
                settings.set_string('cat-custom-color', hex);
        });
        settings.connect('changed::cat-custom-color', syncColor);
        customRow.add_suffix(colorButton);
        customRow.activatable_widget = colorButton;
        appearance.add(customRow);
        bindVisible(settings, customRow, ['cat-skin', 'cat-color-mode'],
            () => settings.get_string('cat-skin') !== 'pixel' && settings.get_string('cat-color-mode') === 'custom');

        const classicIdle = switchRow(settings, 'classic-idle', _('Classic Color When Idle'), _('Switch back to the classic color while the cat sleeps'));
        appearance.add(classicIdle);
        bindVisible(settings, classicIdle, ['cat-skin', 'cat-color-mode'],
            () => settings.get_string('cat-skin') !== 'pixel' && settings.get_string('cat-color-mode') !== 'classic');

        appearance.add(switchRow(settings, 'enable-blinking', _('Blinking'), _('Blink occasionally while awake')));

        const panel = new Adw.PreferencesGroup({title: _('Top Bar')});
        general.add(panel);
        panel.add(comboRow(settings, 'panel-position', _('Position'), [
            ['left', _('Left')], ['center', _('Center')], ['right', _('Right')],
        ]));
        panel.add(spinRow(settings, 'panel-index', _('Index'), {min: -1, max: 50, subtitle: _('Order within the chosen area (-1 = last)')}));

        const input = new Adw.PreferencesGroup({title: _('Input and Behavior')});
        general.add(input);
        const devices = [['all', _('All Keyboards (Auto)')], ...scanKeyboards().map(d => [d.path, d.label])];
        const current = settings.get_string('selected-device-path');
        if (!devices.some(d => d[0] === current))
            devices.push([current, current]);
        input.add(comboRow(settings, 'selected-device-path', _('Keyboard'), devices,
            _('Auto uses libinput for every keyboard; a specific device uses evtest')));
        input.add(spinRow(settings, 'waiting-timeout', _('Sleep Timeout'), {min: 1, max: 10, subtitle: _('Seconds of inactivity before the cat falls asleep')}));
        input.add(spinRow(settings, 'paw-hold-time', _('Paw Hold Time'), {min: 0, max: 100, step: 5, subtitle: _('Keep the paw down a little longer after release (ms)')}));
        input.add(switchRow(settings, 'double-slam', _('Double Slam'), _('Space and Enter slam both paws')));
        input.add(switchRow(settings, 'mouse-enabled', _('Mouse Interaction'), _('Paws react to clicks and scrolling')));
        input.add(switchRow(settings, 'show-metrics', _('Typing Metrics'), _('Live WPM and accuracy. Only key timing is used; key contents are never stored.')));
        const inBar = switchRow(settings, 'metrics-in-bar', _('Show Metrics in Top Bar'));
        input.add(inBar);
        const windowRow = spinRow(settings, 'metrics-window-sec', _('Metrics Window'), {min: 5, max: 120, step: 5, subtitle: _('Sliding window in seconds')});
        input.add(windowRow);
        for (const r of [inBar, windowRow])
            bindVisible(settings, r, ['show-metrics'], () => settings.get_boolean('show-metrics'));

        const sounds = new Adw.PreferencesGroup({title: _('Sounds')});
        general.add(sounds);
        sounds.add(switchRow(settings, 'sound-enabled', _('Key Sounds'), _('Soft bongo hit as you type')));
        const soundRows = [
            comboRow(settings, 'sound-profile', _('Sound Profile'), [['bongo', _('Bongo')], ['pop', _('Pop')]]),
            spinRow(settings, 'sound-volume', _('Volume'), {min: 0, max: 100, step: 5, subtitle: _('Needs pw-play or paplay; without them sounds play at system volume')}),
            switchRow(settings, 'sound-on-mouse', _('Sounds on Mouse Clicks')),
        ];
        for (const r of soundRows) {
            sounds.add(r);
            bindVisible(settings, r, ['sound-enabled'], () => settings.get_boolean('sound-enabled'));
        }

        // ------------------------------------------------------------------
        const desktopPage = new Adw.PreferencesPage({title: _('Desktop Widget'), icon_name: 'user-desktop-symbolic'});
        window.add(desktopPage);
        const desktop = new Adw.PreferencesGroup({
            title: _('Desktop Widget'),
            description: _('A larger cat on the desktop, below all windows. Drag it with the left mouse button; right-click toggles sleep.'),
        });
        desktopPage.add(desktop);
        desktop.add(switchRow(settings, 'desktop-widget-enabled', _('Show on Desktop')));
        desktop.add(spinRow(settings, 'desktop-widget-size', _('Width'), {min: 80, max: 600, step: 10, subtitle: _('Pixels')}));
        desktop.add(spinRow(settings, 'desktop-background-opacity', _('Background Opacity'), {min: 0, max: 100, step: 5, subtitle: _('%')}));
        desktop.add(switchRow(settings, 'desktop-show-metrics', _('Show Metrics')));
        const resetRow = new Adw.ActionRow({title: _('Reset Position')});
        const resetButton = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => {
            settings.set_int('desktop-widget-x', -1);
            settings.set_int('desktop-widget-y', -1);
        });
        resetRow.add_suffix(resetButton);
        desktop.add(resetRow);

        // ------------------------------------------------------------------
        const aboutPage = new Adw.PreferencesPage({title: _('Setup & About'), icon_name: 'help-about-symbolic'});
        window.add(aboutPage);

        const status = checkInputRequirements(settings.get_string('selected-device-path'), settings.get_boolean('mouse-enabled'));
        const setup = new Adw.PreferencesGroup({
            title: _('Setup'),
            description: _("Add your user to the 'input' group to detect keyboard activity. After running the command, reboot for the change to take effect (a quick logout/login may not be enough)."),
        });
        aboutPage.add(setup);
        const ok = v => v ? '✔' : '✘';
        setup.add(new Adw.ActionRow({
            title: _('libinput CLI'),
            subtitle: `${ok(!status.inputToolMissing || status.requiredTool !== 'libinput')} ${_('Fedora: libinput-utils · Arch/Debian/Ubuntu: libinput-tools')}`,
        }));
        let accessText = _('OK');
        if (status.notInInputGroup)
            accessText = _("Not in the 'input' group");
        else if (status.reloginNeeded)
            accessText = _("In the 'input' group, but this session predates it — reboot to apply");
        setup.add(new Adw.ActionRow({
            title: _('Keyboard access'),
            subtitle: `${ok(!status.notInInputGroup && !status.reloginNeeded)} ${accessText}`,
        }));
        const cmdRow = new Adw.ActionRow({title: SETUP_COMMAND, subtitle: _('Add to input group')});
        cmdRow.add_css_class('monospace');
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Copy')});
        copy.add_css_class('flat');
        copy.connect('clicked', () => {
            copy.get_clipboard().set(SETUP_COMMAND);
            window.add_toast(new Adw.Toast({title: _('Copied')}));
        });
        cmdRow.add_suffix(copy);
        setup.add(cmdRow);

        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        aboutPage.add(behavior);
        behavior.add(switchRow(settings, 'show-hints', _('Show Hints'), _('Usage tips in the menu')));

        const usage = new Adw.PreferencesGroup({title: _('Usage Guide')});
        aboutPage.add(usage);
        usage.add(new Adw.ActionRow({title: _('Left-click'), subtitle: _('Open the menu')}));
        usage.add(new Adw.ActionRow({title: _('Right-click'), subtitle: _('Toggle sleep mode')}));

        const credits = new Adw.PreferencesGroup({title: _('Credits')});
        aboutPage.add(credits);
        for (const [title, subtitle, uri] of [
            ['Loc Huynh', _('Original DankMaterialShell plugin (MIT)'), 'https://github.com/hthienloc/dms-plugins'],
            ['@StrayRogue', _('Creator of the original Bongo Cat artwork'), 'https://x.com/StrayRogue'],
            ['StrawberryMatchaArt', _('Creator of the Pixel Doodle Bongo Cat artwork'), 'https://www.etsy.com/shop/StrawberryMatchaArt'],
        ]) {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
            credits.add(row);
        }
    }
}
