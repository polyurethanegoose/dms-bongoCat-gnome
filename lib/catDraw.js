// Pure Cairo drawing of the cat. No St/Clutter imports, so it can be unit
// tested with plain `gjs` outside of GNOME Shell (see tools/render-preview.js).
import Cairo from 'cairo';

import {GLYPHS} from './catGlyphs.js';

export const POSES = ['idle', 'left', 'right', 'both', 'blink', 'sleep'];

// Pixel sprites are 32x25 (and @4x = 128x100).
const PIXEL_W = 32;
const PIXEL_H = 25;

export function aspectRatio(skin) {
    return skin === 'pixel' ? PIXEL_W / PIXEL_H : GLYPHS.width / GLYPHS.height;
}

const _surfaceCache = new Map();

function _surface(path) {
    let s = _surfaceCache.get(path);
    if (!s) {
        s = Cairo.ImageSurface.createFromPNG(path);
        _surfaceCache.set(path, s);
    }
    return s;
}

export function clearSurfaceCache() {
    _surfaceCache.clear();
}

/**
 * Draw the cat into a cairo context.
 *
 * @param {Cairo.Context} cr
 * @param {object} p
 * @param {number} p.width - area width
 * @param {number} p.height - area height
 * @param {string} p.skin - 'classic' | 'pixel'
 * @param {string} p.pose - one of POSES
 * @param {number[]} p.rgba - [r,g,b,a] 0..1 (classic skin only)
 * @param {number} p.alpha - overall opacity 0..1
 * @param {number} p.yOffset - vertical offset in px
 * @param {string} p.skinDir - directory with <pose>.png / <pose>@4x.png (pixel skin)
 */
export function drawCat(cr, p) {
    const aspect = aspectRatio(p.skin);
    // Fit the cat's frame into the area, preserving aspect ratio.
    let h = Math.min(p.height, p.width / aspect);
    let w = h * aspect;

    if (p.skin === 'pixel') {
        _drawPixel(cr, p, w, h);
        return;
    }

    const s = h / GLYPHS.height;
    cr.save();
    cr.translate((p.width - w) / 2, (p.height - h) / 2 + (p.yOffset || 0));
    cr.scale(s, s);
    cr.newPath();
    for (const c of GLYPHS.poses[p.pose] ?? GLYPHS.poses.idle) {
        switch (c[0]) {
        case 'M': cr.moveTo(c[1], c[2]); break;
        case 'L': cr.lineTo(c[1], c[2]); break;
        case 'C': cr.curveTo(c[1], c[2], c[3], c[4], c[5], c[6]); break;
        case 'Z': cr.closePath(); break;
        }
    }
    const [r, g, b, a] = p.rgba;
    cr.setSourceRGBA(r, g, b, a * (p.alpha ?? 1));
    cr.setFillRule(Cairo.FillRule.WINDING);
    cr.fill();
    cr.restore();
}

function _drawPixel(cr, p, w, h) {
    // Crisp pixel art: when there is room for an integer upscale of the 32x25
    // source, use nearest-neighbour. Below that (small panels), downscale the
    // @4x sprite with a smooth filter so no rows/columns are dropped.
    const k = Math.floor(h / PIXEL_H);
    let surf, scale, filter;
    if (k >= 1) {
        surf = _surface(`${p.skinDir}/${p.pose}.png`);
        scale = k;
        filter = Cairo.Filter.NEAREST;
    } else {
        surf = _surface(`${p.skinDir}/${p.pose}@4x.png`);
        scale = h / (PIXEL_H * 4);
        filter = Cairo.Filter.GOOD;
    }
    const sw = surf.getWidth() * scale;
    const sh = surf.getHeight() * scale;
    cr.save();
    cr.translate(Math.round((p.width - sw) / 2),
        Math.round((p.height - sh) / 2 + (p.yOffset || 0)));
    cr.scale(scale, scale);
    cr.setSourceSurface(surf, 0, 0);
    cr.getSource().setFilter(filter);
    cr.paintWithAlpha(p.alpha ?? 1);
    cr.restore();
}
