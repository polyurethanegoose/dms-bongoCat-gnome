// Port of shared/InputEventListener.qml.
//
// GNOME Shell has no public API for observing key presses that go to other
// (Wayland) clients, so - exactly like the DMS original - we spawn
// `libinput debug-events --show-keycodes` (all keyboards) or `evtest <dev>`
// (one keyboard) and parse their stdout line by line. Both need read access
// to /dev/input/event*, i.e. the user must be in the `input` group.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {checkInputRequirements} from './system.js';

const RESTART_DELAYS_MS = [1000, 3000, 10000, 30000];

/** One long-running line-oriented child process. */
class LineProcess {
    constructor(argv, onLine, onExit) {
        this._argv = argv;
        this._onLine = onLine;
        this._onExit = onExit;
        this._cancellable = new Gio.Cancellable();
        this.lastError = '';

        this._proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._readLoop(this._proc.get_stdout_pipe(), onLine);
        this._readLoop(this._proc.get_stderr_pipe(), line => {
            if (line.trim())
                this.lastError = line.trim();
        });
        this._proc.wait_async(this._cancellable, (proc, res) => {
            try {
                proc.wait_finish(res);
            } catch {
                return; // cancelled -> we stopped it on purpose
            }
            this._onExit?.(proc.get_if_exited() ? proc.get_exit_status() : -1, this.lastError);
        });
    }

    // Read in chunks rather than line by line: `libinput debug-events` prints
    // a line for every pointer motion (up to ~1000/s with gaming mice), and
    // one main-loop dispatch per line would steal time from the compositor.
    // Low priority keeps frame drawing and real input handling ahead of us.
    _readLoop(stream, onLine, pending = new Uint8Array(0)) {
        stream.read_bytes_async(16384, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res);
            } catch {
                return; // cancelled or pipe closed
            }
            if (bytes.get_size() === 0)
                return; // EOF
            // GJS's TextDecoder has no streaming mode, so split on the newline
            // byte first and only decode complete lines (keeps UTF-8 intact).
            const chunk = bytes.toArray();
            const buf = new Uint8Array(pending.length + chunk.length);
            buf.set(pending);
            buf.set(chunk, pending.length);
            const end = buf.lastIndexOf(0x0a);
            if (end < 0) {
                this._readLoop(stream, onLine, buf);
                return;
            }
            pending = buf.slice(end + 1);
            const lines = new TextDecoder().decode(buf.subarray(0, end)).split('\n');
            for (const line of lines) {
                // Cheap pre-filter: motion events are the bulk and never matter.
                if (line.includes('POINTER_MOTION'))
                    continue;
                try {
                    onLine(line);
                } catch (e) {
                    console.error(`[BongoCat] line handler failed: ${e}`);
                }
            }
            this._readLoop(stream, onLine, pending);
        });
    }

    stop() {
        this._onExit = null;
        this._cancellable.cancel();
        this._proc.force_exit();
    }
}

export const InputListener = GObject.registerClass({
    Signals: {
        // type: 'press' | 'release' | 'repeat', keyName: 'KEY_A' ...
        'key': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        'pointer-button': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]},
        'scroll': {},
        // requirement / error status changed
        'status-changed': {},
    },
}, class InputListener extends GObject.Object {
    constructor() {
        super();
        this._devicePath = 'all';
        this._monitorMouse = false;
        this._main = null;
        this._mouse = null;
        this._restartId = 0;
        this._failures = 0;
        // Real probing happens in restart(); don't touch devices at construction.
        this.status = {
            requiredTool: 'libinput', inputToolMissing: false, notInInputGroup: false,
            reloginNeeded: false, mouseToolMissing: false, inputBroken: false,
        };
        this.lastError = '';
    }

    configure(devicePath, monitorMouse) {
        this._devicePath = devicePath || 'all';
        this._monitorMouse = monitorMouse;
        this._failures = 0;
        this.restart();
    }

    restart() {
        this.stop();
        this.status = checkInputRequirements(this._devicePath, this._monitorMouse);
        this.lastError = '';
        this.emit('status-changed');

        if (!this.status.inputToolMissing) {
            const argv = this._devicePath === 'all'
                ? ['libinput', 'debug-events', '--show-keycodes']
                : ['evtest', this._devicePath];
            this._main = this._spawn(argv);
        }
        // evtest only watches the keyboard, so a second libinput process is
        // needed for the mouse in specific-device mode. (The QML original
        // spawned it too, but never wired its output to the paws.)
        if (this._monitorMouse && this._devicePath !== 'all' && !this.status.mouseToolMissing)
            this._mouse = this._spawn(['libinput', 'debug-events']);
    }

    _spawn(argv) {
        try {
            return new LineProcess(argv, line => this._parseLine(line),
                (code, err) => this._onProcessExit(argv, code, err));
        } catch (e) {
            this.lastError = e.message;
            this.emit('status-changed');
            return null;
        }
    }

    _onProcessExit(argv, code, err) {
        console.warn(`[BongoCat] ${argv[0]} exited (${code}): ${err}`);
        this.lastError = err || `${argv[0]} exited with code ${code}`;
        this.emit('status-changed');
        // Device unplugged, permissions changed, ... retry with backoff.
        const delay = RESTART_DELAYS_MS[Math.min(this._failures, RESTART_DELAYS_MS.length - 1)];
        this._failures++;
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartId = 0;
            this.restart();
            return GLib.SOURCE_REMOVE;
        });
    }

    _parseLine(data) {
        if (data.includes('EV_KEY')) {
            // evtest: "Event: time ..., type 1 (EV_KEY), code 30 (KEY_A), value 1"
            const value = data.match(/value\s+(\d+)\s*$/);
            if (!value)
                return; // capability listing in evtest's header
            const code = parseInt(data.match(/code\s+(\d+)/)?.[1] ?? '0');
            // Mouse buttons on combo devices are handled by the libinput mouse process.
            if (code >= 272 && code <= 287)
                return;
            const keyName = data.match(/(KEY_[A-Z0-9_]+)/)?.[1] ?? '';
            const type = {'1': 'press', '0': 'release', '2': 'repeat'}[value[1]];
            if (type)
                this.emit('key', type, keyName);
        } else if (data.includes('KEYBOARD_KEY')) {
            // libinput: " event3  KEYBOARD_KEY  +1.234s  KEY_A (30) pressed"
            const keyName = data.match(/(KEY_[A-Z0-9_]+)/)?.[1] ?? '';
            if (data.includes('pressed'))
                this.emit('key', 'press', keyName);
            else if (data.includes('released'))
                this.emit('key', 'release', keyName);
            else if (data.includes('repeat'))
                this.emit('key', 'repeat', keyName);
        } else if (this._monitorMouse && data.includes('POINTER_BUTTON')) {
            const name = data.match(/(BTN_[A-Z0-9_]+)/)?.[1] ?? 'BTN_OTHER';
            if (data.includes('pressed'))
                this.emit('pointer-button', name, true);
            else if (data.includes('released'))
                this.emit('pointer-button', name, false);
        } else if (this._monitorMouse && data.includes('POINTER_SCROLL')) {
            // Ignore scroll-stop events (zero on both axes).
            const vert = data.match(/vert\s+(-?\d+(?:\.\d+)?)/);
            const horiz = data.match(/horiz\s+(-?\d+(?:\.\d+)?)/);
            if (vert && horiz && parseFloat(vert[1]) === 0 && parseFloat(horiz[1]) === 0)
                return;
            this.emit('scroll');
        } else {
            return;
        }
        // Any successfully parsed event resets the restart backoff.
        this._failures = 0;
    }

    stop() {
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }
        this._main?.stop();
        this._mouse?.stop();
        this._main = null;
        this._mouse = null;
    }

    destroy() {
        this.stop();
    }
});
