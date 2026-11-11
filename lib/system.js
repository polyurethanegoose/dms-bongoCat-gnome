// System probing shared by the extension and the preferences window.
// Only uses GLib/Gio so it can be imported from prefs.js (which runs in a
// separate GTK process without St/Clutter).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const INCLUDE_PATTERN = 'kanata';
const EXCLUDE_PATTERNS = ['power button', 'video bus', 'speaker', 'headphone', 'lid switch',
    'touchpad', 'extra buttons', 'uinput', 'server', 'hitune', 'inphic', 'instant', 'webcam', 'video'];

function readText(path) {
    try {
        // Gio.File.load_contents reads until EOF, which is needed for procfs
        // files that report a size of 0.
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Port of InputDeviceScanner.qml (which shelled out to an inline python
 * script). Returns [{label, path}] for keyboard-like evdev devices.
 */
export function scanKeyboards() {
    const content = readText('/proc/bus/input/devices');
    if (!content)
        return [];
    const devices = [];
    const seen = new Set();
    for (const section of content.trim().split('\n\n')) {
        let name = '', handlers = '';
        for (const line of section.split('\n')) {
            if (line.startsWith('N: Name=')) {
                const m = line.match(/Name="([^"]+)"/);
                if (m)
                    name = m[1];
            } else if (line.startsWith('H: Handlers=')) {
                handlers = line.split('=')[1] ?? '';
            }
        }
        if (!name || !handlers)
            continue;
        const lower = name.toLowerCase();
        const included = lower.includes(INCLUDE_PATTERN);
        const excluded = EXCLUDE_PATTERNS.some(x => lower.includes(x));
        if (!handlers.includes('kbd') || !(included || (!handlers.includes('mouse') && !excluded)))
            continue;
        const ev = handlers.match(/event(\d+)/);
        if (!ev)
            continue;
        const path = `/dev/input/event${ev[1]}`;
        if (seen.has(path))
            continue;
        seen.add(path);
        devices.push({label: `${name} (event${ev[1]})`, path});
    }
    return devices;
}

export function hasProgram(name) {
    return GLib.find_program_in_path(name) !== null;
}

// Everything here only reads local files: this code runs on GNOME Shell's
// main thread, so it must never spawn processes or wait on other services.

/** The `input` entry from /etc/group (or nss-altfiles' /usr/lib/group). */
function inputGroupEntry() {
    for (const file of ['/etc/group', '/usr/lib/group']) {
        const line = readText(file)?.split('\n').find(l => l.startsWith('input:'));
        if (line) {
            const [, , gid, members = ''] = line.split(':');
            return {gid, members: members.split(',').filter(Boolean)};
        }
    }
    return null;
}

/**
 * Whether the *current process* (gnome-shell, whose children inherit its
 * credentials) is in the `input` group. Returns null if unknown.
 *
 * Note: this can differ from `id $USER`, which reads the user database.
 * On GNOME the shell runs under the systemd user manager (user@UID.service),
 * which keeps its supplementary groups until it is restarted - a quick
 * logout/login can reuse the old manager, so only a reboot (or a logout that
 * lets user@UID.service stop) picks up a new group.
 */
export function inInputGroup() {
    const entry = inputGroupEntry();
    const status = readText('/proc/self/status');
    if (!entry || !status)
        return null;
    const line = status.split('\n').find(l => l.startsWith('Groups:')) ?? '';
    return line.replace('Groups:', '').trim().split(/\s+/).includes(entry.gid);
}

/** Whether the group file lists the user in `input` (what `id $USER` shows). */
export function userDbInInputGroup() {
    const entry = inputGroupEntry();
    return entry ? entry.members.includes(GLib.get_user_name()) : null;
}

/**
 * The real test: can this process open an evdev node for reading?
 * Returns true/false, or null if there are no event devices to try.
 * Also covers setups that grant access via ACLs instead of the group.
 */
export function canReadInputDevices() {
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path('/dev/input').enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return null;
    }
    let tried = false;
    let info;
    while ((info = enumerator.next_file(null))) {
        const name = info.get_name();
        if (!/^event\d+$/.test(name))
            continue;
        tried = true;
        try {
            // Opening an evdev node read-only does not grab it or consume events.
            Gio.File.new_for_path(`/dev/input/${name}`).read(null).close(null);
            enumerator.close(null);
            return true;
        } catch {}
    }
    enumerator.close(null);
    return tried ? false : null;
}

export function requiredTool(devicePath) {
    return devicePath === 'all' ? 'libinput' : 'evtest';
}

/** Probe everything the input listener needs. */
export function checkInputRequirements(devicePath, mouseEnabled) {
    const tool = requiredTool(devicePath);
    const inputToolMissing = !hasProgram(tool);
    const mouseToolMissing = mouseEnabled && devicePath !== 'all' && !hasProgram('libinput');

    // Device access is what actually matters; group membership only decides
    // which hint to show when access fails.
    const readable = canReadInputDevices();
    const processInGroup = inInputGroup();
    const noAccess = readable === false || (readable === null && processInGroup === false);
    // In the group according to the user database, but this session was
    // started before that -> a reboot is needed, not another usermod.
    const reloginNeeded = noAccess && processInGroup !== true && userDbInInputGroup() === true;
    const notInInputGroup = noAccess && !reloginNeeded;

    return {
        requiredTool: tool,
        inputToolMissing,
        notInInputGroup,
        reloginNeeded,
        mouseToolMissing,
        inputBroken: inputToolMissing || notInInputGroup || reloginNeeded,
    };
}
