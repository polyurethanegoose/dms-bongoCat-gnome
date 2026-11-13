// Colour helpers. DMS has a Material theme with Theme.primary; the closest
// GNOME equivalent is the system accent colour. If the key is missing we fall
// back to the classic Adwaita blue.
import Gio from 'gi://Gio';

// libadwaita accent palette (light/dark neutral "standalone" variants).
const ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
    orange: '#ed5b00', red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};

export function parseHex(hex, fallback = [1, 1, 1, 1]) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec((hex ?? '').trim());
    if (!m)
        return fallback;
    const n = parseInt(m[1], 16);
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a];
}

export class AccentWatcher {
    constructor(onChange) {
        this._settings = null;
        this._id = 0;
        const source = Gio.SettingsSchemaSource.get_default();
        const schema = source?.lookup('org.gnome.desktop.interface', true);
        if (schema?.has_key('accent-color')) {
            this._settings = new Gio.Settings({settings_schema: schema});
            this._id = this._settings.connect('changed::accent-color', () => onChange());
        }
    }

    get hex() {
        return ACCENTS[this._settings?.get_string('accent-color')] ?? ACCENTS.blue;
    }

    get rgba() {
        return parseHex(this.hex);
    }

    destroy() {
        if (this._id)
            this._settings.disconnect(this._id);
        this._settings = null;
    }
}
