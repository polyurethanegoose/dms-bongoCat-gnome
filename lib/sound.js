// Port of services/BongoSoundService.qml.
//
// QML had QtMultimedia's SoundEffect with per-sound volume. Doing audio
// in-process in GNOME Shell is dangerous: connecting to PipeWire/PulseAudio
// is synchronous, and if the audio server is not up yet (e.g. during login)
// the whole compositor freezes. So every hit is played by a short-lived
// helper process (`pw-play`, else `paplay`); the shell never waits on it.
// Without either tool we fall back to Meta.SoundPlayer (libcanberra, runs in
// its own thread, but has no volume control).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const FILES = {key1: 'key.wav', key2: 'key_alt.wav', big: 'space.wav'};
const PROFILES = {bongo: '', pop: 'pop_'};
// Ignore hits closer together than this (same as the QML de-dup window).
const DEDUP_MS = 25;
// Don't pile up helper processes if something goes wrong with the audio server.
const MAX_RUNNING = 6;

export class SoundPlayer {
    constructor(soundDir) {
        this._dir = soundDir;
        this._alt = false;
        this._lastPlay = 0;
        this._running = 0;
        this._cancellable = new Gio.Cancellable();
        this._backend = null; // resolved lazily on first play
    }

    _resolveBackend() {
        if (GLib.find_program_in_path('pw-play'))
            return 'pw-play';
        if (GLib.find_program_in_path('paplay'))
            return 'paplay';
        return 'canberra';
    }

    play(isBigHit, profile, volume) {
        if (this._cancellable.is_cancelled())
            return;
        const now = Date.now();
        if (now - this._lastPlay < DEDUP_MS)
            return;
        this._lastPlay = now;

        this._backend ??= this._resolveBackend();
        this._alt = !this._alt;
        const sample = isBigHit ? 'big' : (this._alt ? 'key1' : 'key2');
        const path = `${this._dir}/${PROFILES[profile] ?? ''}${FILES[sample]}`;
        const vol = Math.max(0, Math.min(1, volume));

        if (this._backend === 'canberra') {
            global.display.get_sound_player().play_from_file(
                Gio.File.new_for_path(path), 'Bongo Cat', null);
            return;
        }
        if (this._running >= MAX_RUNNING)
            return;

        const argv = this._backend === 'pw-play'
            ? ['pw-play', `--volume=${vol.toFixed(2)}`, path]
            : ['paplay', `--volume=${Math.round(vol * 65536)}`, path];
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._running++;
            proc.wait_async(this._cancellable, (p, res) => {
                this._running--;
                try {
                    p.wait_finish(res);
                } catch {}
            });
        } catch (e) {
            console.warn(`[BongoCat] ${argv[0]} failed, falling back to libcanberra: ${e.message}`);
            this._backend = 'canberra';
        }
    }

    destroy() {
        this._cancellable.cancel();
    }
}
