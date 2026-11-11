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

/**
 * Whether the *current process* (gnome-shell, whose children inherit its
 * credentials) is in the `input` group. Group changes need a re-login, which
 * is exactly what /proc/self/status reflects. Returns null if unknown.
 */
export function inInputGroup() {
    const status = readText('/proc/self/status');
    const groupFile = readText('/etc/group');
    if (!status)
        return null;
    const groupsLine = status.split('\n').find(l => l.startsWith('Groups:'));
    const gids = new Set((groupsLine ?? '').replace('Groups:', '').trim().split(/\s+/).filter(Boolean));
    const entry = groupFile?.split('\n').find(l => l.startsWith('input:'));
    if (!entry) {
        // Group may live in a userdb/NSS backend; fall back to `id -nG`.
        try {
            const [ok, out] = GLib.spawn_command_line_sync('id -nG');
            if (ok)
                return new TextDecoder().decode(out).trim().split(/\s+/).includes('input');
        } catch {}
        return null;
    }
    const gid = entry.split(':')[2];
    return gids.has(gid);
}

export function requiredTool(devicePath) {
    return devicePath === 'all' ? 'libinput' : 'evtest';
}

/** Probe everything the input listener needs. */
export function checkInputRequirements(devicePath, mouseEnabled) {
    const tool = requiredTool(devicePath);
    const inputToolMissing = !hasProgram(tool);
    const group = inInputGroup();
    const notInInputGroup = group === false;
    const mouseToolMissing = mouseEnabled && devicePath !== 'all' && !hasProgram('libinput');
    return {
        requiredTool: tool,
        inputToolMissing,
        notInInputGroup,
        mouseToolMissing,
        inputBroken: inputToolMissing || notInInputGroup,
    };
}
