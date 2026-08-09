import { encodeRgbaPng } from '../../scripts/host/raster-png-codec.mjs';
import { makeMultiPagePdf } from '../pdf-fixture.js';

export const pngFixture = encodeRgbaPng({
  width: 4,
  height: 4,
  pixels: Buffer.alloc(4 * 4 * 4, 200),
});
export const psFixture = Buffer.from('%!PS-Adobe-3.0\n(Hello) show\nshowpage\n', 'latin1');
export const cadFixture = Buffer.from(JSON.stringify({
  title: 'CAD',
  entities: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 50 }],
}), 'utf8');
export const printerMarksFixture = makeMultiPagePdf(['trimmed page'], {
  cropBoxes: [[0, 0, 612, 792]],
  bleedBoxes: [[0, 0, 612, 792]],
  trimBoxes: [[9, 9, 603, 783]],
});
