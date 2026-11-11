// Logic tests runnable with plain gjs (no GNOME Shell):
//   gjs -m tools/test-logic.js <extension-dir>
// Covers line parsing, the paw state machine, sleep timing, metrics and the
// subprocess line reader.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const dir = ARGV[0];
const {CatModel} = await import(`file://${dir}/lib/catModel.js`);
const {InputListener} = await import(`file://${dir}/lib/inputListener.js`);
const {scanKeyboards, checkInputRequirements} = await import(`file://${dir}/lib/system.js`);

let failures = 0;
function eq(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'}  ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const source = Gio.SettingsSchemaSource.new_from_directory(`${dir}/schemas`, null, false);
const schema = source.lookup('org.gnome.shell.extensions.bongo-cat', false);
const settings = new Gio.Settings({settings_schema: schema, backend: Gio.memory_settings_backend_new()});
settings.set_boolean('mouse-enabled', true);
settings.set_boolean('show-metrics', true);
settings.set_int('waiting-timeout', 1);

const model = new CatModel(settings);
const input = new InputListener();
input._monitorMouse = true;
const hits = [];
input.connect('key', (l, t, k) => model.handleKey(t, k));
input.connect('pointer-button', (l, n, p) => model.handleMouseButton(n, p));
input.connect('scroll', () => model.handleScroll());
settings.set_boolean('sound-enabled', true);
model.connect('hit', (m, big) => hits.push(big));

const feed = line => input._parseLine(line);

eq(model.pose, 'sleep', 'starts asleep');
// libinput format
feed(' event3   KEYBOARD_KEY            +3.221s\tKEY_A (30) pressed');
eq(model.pose, 'left', 'first key press -> left paw');
feed(' event3   KEYBOARD_KEY            +3.300s\tKEY_A (30) released');
eq(model.pose, 'idle', 'release -> idle');
feed(' event3   KEYBOARD_KEY            +3.400s\tKEY_B (48) pressed');
eq(model.pose, 'right', 'next key -> right paw (alternates)');
feed(' event3   KEYBOARD_KEY            +3.410s\tKEY_C (46) pressed');
eq(model.pose, 'both', 'second key while one held -> both');
feed(' event3   KEYBOARD_KEY            +3.500s\tKEY_C (46) released');
eq(model.pose, 'right', 'release one of two -> last paw stays');
feed(' event3   KEYBOARD_KEY            +3.600s\tKEY_B (48) released');
feed(' event3   KEYBOARD_KEY            +3.700s\tKEY_SPACE (57) pressed');
eq(model.pose, 'both', 'space -> double slam');
feed(' event3   KEYBOARD_KEY            +3.800s\tKEY_SPACE (57) released');
eq(hits, [false, false, false, true], 'sound hits (space is big)');

// evtest format
feed('Event: time 1700000000.100000, type 1 (EV_KEY), code 30 (KEY_A), value 1');
eq(model.pose, 'left', 'evtest press');
feed('Event: time 1700000000.200000, type 1 (EV_KEY), code 30 (KEY_A), value 2');
eq(model.pose, 'left', 'evtest repeat keeps paw');
feed('Event: time 1700000000.300000, type 1 (EV_KEY), code 30 (KEY_A), value 0');
eq(model.pose, 'idle', 'evtest release');
feed('    Event type 1 (EV_KEY)');
feed('Event: time 1700000000.400000, type 1 (EV_KEY), code 272 (BTN_LEFT), value 1');
eq(model.pose, 'idle', 'evtest header + mouse buttons ignored');

// mouse via libinput
feed(' event5   POINTER_BUTTON          +5.000s\tBTN_LEFT (272) pressed, seat count: 1');
eq(model.pose, 'left', 'LMB down -> left paw');
feed(' event5   POINTER_BUTTON          +5.010s\tBTN_RIGHT (273) pressed, seat count: 1');
eq(model.pose, 'both', 'LMB+RMB -> both');
feed(' event5   POINTER_BUTTON          +5.100s\tBTN_LEFT (272) released, seat count: 0');
feed(' event5   POINTER_BUTTON          +5.100s\tBTN_RIGHT (273) released, seat count: 0');
eq(model.pose, 'idle', 'buttons released');
feed(' event5   POINTER_SCROLL_WHEEL    +6.000s\tvert 0.00/0.0 horiz 0.00/0.0* (wheel)');
eq(model.pose, 'idle', 'scroll stop ignored');
feed(' event5   POINTER_SCROLL_WHEEL    +6.000s\tvert 15.00/120.0* horiz 0.00/0.0 (wheel)');
eq(['left', 'right'].includes(model.pose), true, 'scroll drums a paw');

// metrics: 3 chars + 1 correction typed above via KEY_A/B/C/SPACE...
model._pruneAndCompute();
eq(model.cleanPercent, 100, 'no corrections -> 100% clean');
feed(' event3   KEYBOARD_KEY            +7.000s\tKEY_BACKSPACE (14) pressed');
model._pruneAndCompute();
eq(model.cleanPercent < 100, true, 'backspace lowers clean %');

// force sleep
model.toggleForceSleep();
eq(model.pose, 'sleep', 'force sleep');
const before = hits.length;
feed(' event3   KEYBOARD_KEY            +8.000s\tKEY_A (30) pressed');
eq(hits.length, before, 'no sound while force-sleeping');
model.toggleForceSleep();

// Falls asleep after waiting-timeout (1s) once everything is released.
feed(' event3   KEYBOARD_KEY            +8.100s\tKEY_A (30) released');
const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
    eq(model.pose, 'sleep', 'sleeps after timeout');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

// Subprocess reader end-to-end, with a fake "libinput" emitting two lines.
const fakeDir = GLib.dir_make_tmp('bongo-XXXXXX');
GLib.file_set_contents(`${fakeDir}/libinput`,
    '#!/bin/sh\nprintf " event5 POINTER_MOTION +1s 1.0/ 2.0\\n event3 KEYBOARD_KEY +1s\\tKEY_Q (16) pressed\\n event3 KEYBOARD_KEY +1s\\tKEY_Q (16) rel"; sleep 0.2; printf "eased\\n"\nsleep 5\n');
GLib.spawn_command_line_sync(`chmod +x ${fakeDir}/libinput`);
GLib.setenv('PATH', `${fakeDir}:${GLib.getenv('PATH')}`, true);
const live = new InputListener();
const seen = [];
live.connect('key', (l, t, k) => seen.push(`${t}:${k}`));
live.configure('all', false);
const loop2 = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
    eq(seen, ['press:KEY_Q', 'release:KEY_Q'], 'subprocess lines parsed');
    live.destroy();
    loop2.quit();
    return GLib.SOURCE_REMOVE;
});
loop2.run();
GLib.spawn_command_line_sync(`rm -rf ${fakeDir}`);

print(`\nKeyboards found here: ${JSON.stringify(scanKeyboards())}`);
print(`Requirements here: ${JSON.stringify(checkInputRequirements('all', false))}`);

model.destroy();
input.destroy();
print(failures ? `\n${failures} FAILED` : '\nALL PASSED');
System.exit(failures ? 1 : 0);
