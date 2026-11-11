// Port of shared/BongoCatView.qml as an St.DrawingArea.
//
// The QML view used a Text item with a custom font (classic skin) or an Image
// (pixel skin). We draw both with Cairo instead: the classic glyphs come
// pre-converted to paths (lib/catGlyphs.js), which avoids having to load a
// private font into GNOME Shell's Pango font map.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {aspectRatio, drawCat} from './catDraw.js';
import {parseHex} from './colors.js';

export const CatView = GObject.registerClass(
class CatView extends St.DrawingArea {
    /**
     * @param {object} ctx - shared extension context ({model, settings, accent, path})
     * @param {object} params - St.DrawingArea params
     */
    _init(ctx, params = {}) {
        super._init({y_align: Clutter.ActorAlign.CENTER, ...params});
        this._ctx = ctx;
        this._catHeight = 24;
        this.yOffset = 0;
        this.pose = null; // override pose (null = follow model)
        this.connect('repaint', () => this._repaint());
        this._sync();
    }

    setCatHeight(h) {
        this._catHeight = Math.max(8, Math.round(h));
        this._sync();
    }

    _sync() {
        const skin = this._ctx.settings.get_string('cat-skin');
        this.set_size(Math.round(this._catHeight * aspectRatio(skin)), this._catHeight);
        this.queue_repaint();
    }

    update() {
        this._sync();
    }

    _resolveRgba() {
        const {settings, model, accent} = this._ctx;
        const mode = settings.get_string('cat-color-mode');
        const classicIdle = settings.get_boolean('classic-idle') && model.isWaiting;
        if (!classicIdle && mode === 'accent')
            return accent.rgba;
        if (!classicIdle && mode === 'custom') {
            const c = settings.get_string('cat-custom-color');
            return c ? parseHex(c, accent.rgba) : accent.rgba;
        }
        // Classic: follow the surrounding text colour (panel / menu / desktop CSS).
        const fg = this.get_theme_node().get_foreground_color();
        return [fg.red / 255, fg.green / 255, fg.blue / 255, fg.alpha / 255];
    }

    _repaint() {
        const {settings, model, path} = this._ctx;
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        try {
            const skin = settings.get_string('cat-skin');
            const color = settings.get_string('pixel-skin-color');
            const folder = color === 'white' ? 'pixel' : `pixel_${color}`;
            drawCat(cr, {
                width, height, skin,
                pose: this.pose ?? model.pose,
                rgba: this._resolveRgba(),
                alpha: model.forceSleep ? 0.5 : 1.0,
                yOffset: this.yOffset ?? 0,
                skinDir: `${path}/assets/skins/${folder}`,
            });
        } catch (e) {
            console.error(`[BongoCat] repaint failed: ${e}`);
        } finally {
            cr.$dispose();
        }
    }
});
