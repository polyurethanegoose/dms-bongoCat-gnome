// Minimal stand-in for QML's Timer { interval; repeat; running; onTriggered }.
import GLib from 'gi://GLib';

export class Timer {
    constructor(interval, callback, {repeat = false} = {}) {
        this.interval = interval;
        this.repeat = repeat;
        this._callback = callback;
        this._id = 0;
    }

    get running() {
        return this._id !== 0;
    }

    start() {
        if (!this._id)
            this.restart();
    }

    restart() {
        this.stop();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(this.interval)), () => {
            if (!this.repeat)
                this._id = 0;
            this._callback();
            // Keep this source only if it is still the active one (the
            // callback may have restarted or stopped the timer).
            return this.repeat && this._id === id ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        this._id = id;
    }

    stop() {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
    }

    setRunning(running) {
        if (running)
            this.start();
        else
            this.stop();
    }
}
