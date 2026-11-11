// Render every pose of both skins to a PNG sheet, without GNOME Shell.
// Usage: gjs -m tools/render-preview.js <extension-dir> <out.png>
import Cairo from 'cairo';
import System from 'system';

const [extDir, out] = ARGV;
const {drawCat, POSES} = await import(`file://${extDir}/lib/catDraw.js`);

const cellW = 120, cellH = 80, sizes = [24, 70];
const rows = [
    {skin: 'classic', dir: ''},
    {skin: 'pixel', dir: 'pixel'},
    {skin: 'pixel', dir: 'pixel_cyberpunk'},
];
const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, cellW * POSES.length, cellH * rows.length * sizes.length);
const cr = new Cairo.Context(surf);
cr.setSourceRGB(0.15, 0.15, 0.17);
cr.paint();
let y = 0;
for (const row of rows) {
    for (const size of sizes) {
        POSES.forEach((pose, i) => {
            cr.save();
            cr.translate(i * cellW + (cellW - size * 1.8) / 2, y + (cellH - size) / 2);
            drawCat(cr, {
                width: size * 1.8, height: size, skin: row.skin, pose,
                rgba: [1, 1, 1, 1], alpha: 1, yOffset: 0,
                skinDir: `${extDir}/assets/skins/${row.dir}`,
            });
            cr.restore();
        });
        y += cellH;
    }
}
surf.writeToPNG(out);
cr.$dispose();
System.exit(0);
