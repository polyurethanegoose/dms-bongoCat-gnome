// Bongo Cat for GNOME Shell - a port of the DankMaterialShell "bongoCat"
// plugin by Loc Huynh (https://github.com/hthienloc/dms-plugins, MIT).
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AccentWatcher} from './lib/colors.js';
import {CatModel} from './lib/catModel.js';
import {clearSurfaceCache} from './lib/catDraw.js';
import {DesktopWidget} from './lib/desktopWidget.js';
import {BongoIndicator} from './lib/indicator.js';
import {InputListener} from './lib/inputListener.js';
import {SoundPlayer} from './lib/sound.js';

export default class BongoCatExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._model = new CatModel(this._settings);
        this._input = new InputListener();
        this._sound = new SoundPlayer(`${this.path}/assets/sounds`);
        this._sound.init().catch(e => console.error(`[BongoCat] sound init: ${e}`));
        this._accent = new AccentWatcher(() => this._repaintAll());

        this._ctx = {
            settings: this._settings,
            model: this._model,
            input: this._input,
            accent: this._accent,
            path: this.path,
            openPreferences: () => this.openPreferences(),
        };

        // Input -> model
        this._input.connectObject(
            'key', (l, type, keyName) => this._model.handleKey(type, keyName),
            'pointer-button', (l, name, pressed) => this._model.handleMouseButton(name, pressed),
            'scroll', () => this._model.handleScroll(),
            this);
        // Model -> sound
        this._model.connectObject('hit', (m, isBigHit) => {
            this._sound.play(isBigHit,
                this._settings.get_string('sound-profile'),
                this._settings.get_int('sound-volume') / 100);
        }, this);

        this._settings.connectObject(
            'changed::selected-device-path', () => this._configureInput(),
            'changed::mouse-enabled', () => this._configureInput(),
            'changed::panel-position', () => this._addIndicator(),
            'changed::panel-index', () => this._addIndicator(),
            'changed::desktop-widget-enabled', () => this._syncDesktopWidget(),
            'changed::pixel-skin-color', () => clearSurfaceCache(),
            this);

        this._addIndicator();
        this._syncDesktopWidget();
        this._configureInput();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._input.disconnectObject(this);
        this._model.disconnectObject(this);

        this._indicator?.destroy();
        this._indicator = null;
        this._desktop?.destroy();
        this._desktop = null;

        this._input.destroy();
        this._input = null;
        this._model.destroy();
        this._model = null;
        this._sound.destroy();
        this._sound = null;
        this._accent.destroy();
        this._accent = null;
        clearSurfaceCache();
        this._ctx = null;
        this._settings = null;
    }

    _configureInput() {
        this._input.configure(
            this._settings.get_string('selected-device-path'),
            this._settings.get_boolean('mouse-enabled'));
    }

    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = new BongoIndicator(this._ctx);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    _syncDesktopWidget() {
        const enabled = this._settings.get_boolean('desktop-widget-enabled');
        if (enabled && !this._desktop) {
            this._desktop = new DesktopWidget(this._ctx);
        } else if (!enabled && this._desktop) {
            this._desktop.destroy();
            this._desktop = null;
        }
    }

    _repaintAll() {
        this._indicator?.repaint();
        this._desktop?.repaint();
    }
}
