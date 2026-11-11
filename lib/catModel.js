// The cat's brain: paw state machine, blink/sleep timers and typing metrics.
// Port of the logic duplicated in BongoWidget.qml / BongoDesktopWidget.qml.
// One model is shared by the panel indicator and the desktop widget, so input
// is read once and a key press makes exactly one sound.
import GObject from 'gi://GObject';

import {Timer} from './timer.js';

const STATE_POSES = ['idle', 'left', 'right', 'both'];
const BIG_HIT_KEYS = new Set(['KEY_SPACE', 'KEY_ENTER', 'KEY_KPENTER']);

// Keys that produce no character and must not inflate WPM.
const NON_CHAR_KEYS = new Set([
    'KEY_LEFTSHIFT', 'KEY_RIGHTSHIFT', 'KEY_LEFTCTRL', 'KEY_RIGHTCTRL',
    'KEY_LEFTALT', 'KEY_RIGHTALT', 'KEY_LEFTMETA', 'KEY_RIGHTMETA',
    'KEY_CAPSLOCK', 'KEY_NUMLOCK', 'KEY_SCROLLLOCK',
    'KEY_ESC', 'KEY_ENTER', 'KEY_KPENTER', 'KEY_TAB',
    'KEY_LEFT', 'KEY_RIGHT', 'KEY_UP', 'KEY_DOWN',
    'KEY_HOME', 'KEY_END', 'KEY_PAGEUP', 'KEY_PAGEDOWN', 'KEY_INSERT',
    'KEY_COMPOSE', 'KEY_MENU', 'KEY_SYSRQ', 'KEY_PAUSE', 'KEY_PRINT',
]);

function classifyKey(name) {
    if (name === 'KEY_BACKSPACE' || name === 'KEY_DELETE')
        return 'correction';
    if (NON_CHAR_KEYS.has(name) || /^KEY_F\d+$/.test(name))
        return 'ignore';
    return 'char';
}

export const CatModel = GObject.registerClass({
    Signals: {
        // Pose / sleep state changed -> views repaint.
        'changed': {},
        // WPM / clean % changed.
        'metrics-changed': {},
        // A paw hit that should make a sound. Arg: isBigHit.
        'hit': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class CatModel extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;

        this.catState = 0;
        this.isBlinking = false;
        this.isWaiting = true;
        this.forceSleep = false;
        this.liveWpm = 0;
        this.cleanPercent = 100;

        this._leftWasLast = false;
        this._kbState = 0;
        this._mouseState = 0;
        this._scrollState = 0;
        this._scrollLeftWasLast = false;
        this._mouseLeftDown = false;
        this._mouseRightDown = false;
        this._mouseOtherDown = false;
        this._charStamps = [];
        this._correctionStamps = [];

        this._waitingTimer = new Timer(5000, () => this._onWaitingTimeout());
        this._pawHoldTimer = new Timer(0, () => {
            if (this._kbState !== 0) {
                this._kbState = 0;
                this._resolveCatState();
            }
        });
        this._scrollThrottle = new Timer(75, () => {});
        this._scrollReleaseTimer = new Timer(150, () => {
            this._scrollState = 0;
            this._resolveCatState();
        });
        this._blinkIntervalTimer = new Timer(this._randomBlinkInterval(), () => {
            this._blinkIntervalTimer.interval = this._randomBlinkInterval();
            this._blinkIntervalTimer.restart();
            this.isBlinking = true;
            this._blinkDurationTimer.restart();
            this.emit('changed');
        }, {repeat: false});
        this._blinkDurationTimer = new Timer(300, () => {
            this.isBlinking = false;
            this.emit('changed');
        });
        this._metricsTicker = new Timer(1000, () => this._pruneAndCompute(), {repeat: true});

        this._settingsIds = [
            settings.connect('changed::show-metrics', () => this._onMetricsConfigChanged()),
            settings.connect('changed::metrics-window-sec', () => this._onMetricsConfigChanged()),
            settings.connect('changed::enable-blinking', () => this._syncTimers()),
            settings.connect('changed::mouse-enabled', () => this.clearMouseState()),
            settings.connect('changed::selected-device-path', () => this.resetMetrics()),
        ];
        this._syncTimers();
    }

    get pose() {
        if (this.forceSleep || this.isWaiting)
            return 'sleep';
        if (this.isBlinking && this.catState === 0)
            return 'blink';
        return STATE_POSES[this.catState] ?? 'idle';
    }

    get isActive() {
        return !this.isWaiting && !this.forceSleep;
    }

    toggleForceSleep() {
        this.forceSleep = !this.forceSleep;
        if (this.forceSleep)
            this.isWaiting = true;
        this._syncTimers();
        this.emit('changed');
    }

    // ---- input entry points -------------------------------------------

    handleKey(type, keyName) {
        const isBigHit = this._settings.get_boolean('double-slam') && BIG_HIT_KEYS.has(keyName);
        if (type === 'press') {
            this._recordKeystroke(keyName);
            this._onKeyPress(isBigHit);
        } else if (type === 'release') {
            this._onKeyRelease(isBigHit);
        } else if (type === 'repeat') {
            this._onKeyRepeat(isBigHit);
        }
    }

    handleMouseButton(buttonName, pressed) {
        if (!this._settings.get_boolean('mouse-enabled'))
            return;
        if (pressed && this._settings.get_boolean('sound-on-mouse'))
            this._playClick(false);
        if (buttonName === 'BTN_LEFT')
            this._mouseLeftDown = pressed;
        else if (buttonName === 'BTN_RIGHT')
            this._mouseRightDown = pressed;
        else
            this._mouseOtherDown = pressed;
        this._updateMousePaws();
    }

    handleScroll() {
        if (!this._settings.get_boolean('mouse-enabled'))
            return;
        this._setWaiting(false);
        this._scrollReleaseTimer.restart();
        this._restartWaitingTimer();
        // Rate-limit the drumming so fast touchpad scrolling doesn't strobe.
        if (this._scrollThrottle.running)
            return;
        this._scrollThrottle.restart();
        this._scrollLeftWasLast = !this._scrollLeftWasLast;
        this._scrollState = this._scrollLeftWasLast ? 1 : 2;
        this._resolveCatState();
    }

    clearMouseState() {
        this._mouseLeftDown = false;
        this._mouseRightDown = false;
        this._mouseOtherDown = false;
        this._mouseState = 0;
        this._scrollState = 0;
        this._scrollReleaseTimer.stop();
        this._resolveCatState();
    }

    // ---- paw state machine ---------------------------------------------

    _resolveCatState() {
        const states = [this._kbState, this._mouseState, this._scrollState].filter(s => s !== 0);
        let next;
        if (states.length === 0)
            next = 0;
        else if (states.includes(3) || (states.includes(1) && states.includes(2)))
            next = 3;
        else
            next = states[0];
        this.catState = next;
        this.emit('changed');
    }

    _onKeyPress(isBigHit) {
        this._setWaiting(false);
        this._playClick(isBigHit);
        let target;
        if (isBigHit) {
            target = 3;
        } else if (this._kbState !== 0) {
            target = 3;
        } else {
            this._leftWasLast = !this._leftWasLast;
            target = this._leftWasLast ? 1 : 2;
        }
        this._kbState = target;
        this._resolveCatState();
        this._restartWaitingTimer();
    }

    _onKeyRelease(isBigHit) {
        let target;
        if (isBigHit)
            target = 0;
        else if (this._kbState === 3)
            target = this._leftWasLast ? 1 : 2;
        else
            target = 0;

        const hold = this._settings.get_int('paw-hold-time');
        if (hold > 0) {
            this._pawHoldTimer.interval = hold;
            this._pawHoldTimer.restart();
        } else {
            this._kbState = target;
            this._resolveCatState();
        }
    }

    _onKeyRepeat(isBigHit) {
        this._setWaiting(false);
        let target;
        if (this._kbState !== 0)
            target = this._kbState;
        else if (isBigHit)
            target = 3;
        else
            target = this._leftWasLast ? 1 : 2;
        this._kbState = target;
        this._resolveCatState();
        this._restartWaitingTimer();
    }

    _updateMousePaws() {
        this._setWaiting(false);
        if ((this._mouseLeftDown && this._mouseRightDown) || this._mouseOtherDown)
            this._mouseState = 3;
        else if (this._mouseLeftDown)
            this._mouseState = 1;
        else if (this._mouseRightDown)
            this._mouseState = 2;
        else
            this._mouseState = 0;
        this._resolveCatState();
        this._restartWaitingTimer();
    }

    _playClick(isBigHit) {
        if (!this._settings.get_boolean('sound-enabled') || this.forceSleep)
            return;
        this.emit('hit', isBigHit);
    }

    // ---- sleep / blink ---------------------------------------------------

    _setWaiting(waiting) {
        if (this.isWaiting === waiting)
            return;
        this.isWaiting = waiting;
        this._syncTimers();
        this.emit('changed');
    }

    _restartWaitingTimer() {
        this._waitingTimer.interval = this._settings.get_int('waiting-timeout') * 1000;
        this._waitingTimer.restart();
    }

    _onWaitingTimeout() {
        // Don't fall asleep while a mouse button is physically held.
        if (this._mouseLeftDown || this._mouseRightDown || this._mouseOtherDown) {
            this._restartWaitingTimer();
            return;
        }
        this._setWaiting(true);
    }

    _randomBlinkInterval() {
        return 6000 + Math.random() * 8000;
    }

    _syncTimers() {
        const blink = this._settings.get_boolean('enable-blinking') && !this.isWaiting && !this.forceSleep;
        this._blinkIntervalTimer.setRunning(blink);
        if (!blink && this.isBlinking) {
            this.isBlinking = false;
            this._blinkDurationTimer.stop();
        }
        this._metricsTicker.setRunning(this._settings.get_boolean('show-metrics'));
    }

    // ---- typing metrics (only timestamps are kept, never key contents) ---

    _recordKeystroke(keyName) {
        if (!keyName || !this._settings.get_boolean('show-metrics'))
            return;
        const kind = classifyKey(keyName);
        if (kind === 'ignore')
            return;
        (kind === 'correction' ? this._correctionStamps : this._charStamps).push(Date.now());
    }

    _pruneAndCompute() {
        const windowMs = this._settings.get_int('metrics-window-sec') * 1000;
        const cutoff = Date.now() - windowMs;
        this._charStamps = this._charStamps.filter(t => t >= cutoff);
        this._correctionStamps = this._correctionStamps.filter(t => t >= cutoff);
        const chars = this._charStamps.length;
        const corrections = this._correctionStamps.length;
        // 5 chars = 1 word; scale the window count up to a per-minute rate.
        const wpm = windowMs > 0 ? Math.round(chars / 5 * 60000 / windowMs) : 0;
        const clean = chars + corrections > 0 ? Math.round(100 * chars / (chars + corrections)) : 100;
        if (wpm !== this.liveWpm || clean !== this.cleanPercent) {
            this.liveWpm = wpm;
            this.cleanPercent = clean;
            this.emit('metrics-changed');
        }
    }

    resetMetrics() {
        this._charStamps = [];
        this._correctionStamps = [];
        this.liveWpm = 0;
        this.cleanPercent = 100;
        this.emit('metrics-changed');
    }

    _onMetricsConfigChanged() {
        this.resetMetrics();
        this._syncTimers();
    }

    destroy() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
        for (const t of [this._waitingTimer, this._pawHoldTimer, this._scrollThrottle,
            this._scrollReleaseTimer, this._blinkIntervalTimer, this._blinkDurationTimer,
            this._metricsTicker])
            t.stop();
    }
});
