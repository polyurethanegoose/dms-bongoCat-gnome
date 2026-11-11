// Port of services/BongoSoundService.qml.
//
// QML had QtMultimedia's low-latency SoundEffect with per-sound volume.
// GNOME Shell's only built-in player (Meta.SoundPlayer / libcanberra) has no
// volume control, so we prefer GStreamer (loaded lazily; if it is missing the
// extension still works) and fall back to Meta.SoundPlayer without volume.
import Gio from 'gi://Gio';

const POOL_SIZE = 3; // overlapping playbacks per sample, for fast typing
const FILES = {key1: 'key.wav', key2: 'key_alt.wav', big: 'space.wav'};
const PROFILES = {bongo: '', pop: 'pop_'};

export class SoundPlayer {
    constructor(soundDir) {
        this._dir = soundDir;
        this._gst = null;
        this._pools = {}; // `${profile}/${sample}` -> {elements, next}
        this._alt = false;
        this._destroyed = false;
    }

    async init() {
        try {
            const {default: Gst} = await import('gi://Gst?version=1.0');
            if (this._destroyed)
                return;
            if (!Gst.is_initialized())
                Gst.init(null);
            this._gst = Gst;
            for (const [profile, prefix] of Object.entries(PROFILES)) {
                for (const [sample, file] of Object.entries(FILES))
                    this._pools[`${profile}/${sample}`] = this._makePool(`${this._dir}/${prefix}${file}`);
            }
        } catch (e) {
            console.warn(`[BongoCat] GStreamer unavailable, using libcanberra without volume control: ${e}`);
            this._gst = null;
        }
    }

    _makePool(path) {
        const Gst = this._gst;
        const uri = Gio.File.new_for_path(path).get_uri();
        const elements = [];
        for (let i = 0; i < POOL_SIZE; i++) {
            const el = Gst.ElementFactory.make('playbin', null);
            if (!el)
                throw new Error('playbin element not available');
            el.uri = uri;
            el.flags = 0x2; // GST_PLAY_FLAG_AUDIO only, no video sink
            // Nobody reads this bus; flushing stops messages piling up.
            el.get_bus().set_flushing(true);
            el.set_state(Gst.State.PAUSED); // preroll -> low latency on first hit
            elements.push(el);
        }
        return {elements, next: 0};
    }

    play(isBigHit, profile, volume) {
        if (this._destroyed)
            return;
        this._alt = !this._alt;
        const sample = isBigHit ? 'big' : (this._alt ? 'key1' : 'key2');
        if (!(profile in PROFILES))
            profile = 'bongo';

        if (!this._gst) {
            const file = Gio.File.new_for_path(`${this._dir}/${PROFILES[profile]}${FILES[sample]}`);
            global.display.get_sound_player().play_from_file(file, 'Bongo Cat', null);
            return;
        }

        const Gst = this._gst;
        const pool = this._pools[`${profile}/${sample}`];
        const el = pool.elements[pool.next];
        pool.next = (pool.next + 1) % pool.elements.length;
        el.volume = Math.max(0, Math.min(1, volume));
        el.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, 0);
        el.set_state(Gst.State.PLAYING);
    }

    destroy() {
        this._destroyed = true;
        if (this._gst) {
            for (const pool of Object.values(this._pools))
                pool.elements.forEach(el => el.set_state(this._gst.State.NULL));
        }
        this._pools = {};
        this._gst = null;
    }
}
