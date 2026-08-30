import { result, fail, sha256 } from './support.mjs';
import { writeClassicOutlinePdf } from './classic-structure-pdf.mjs';

export function viewerBookmarks(ctx = {}) {
  const titles = Array.isArray(ctx.bookmarks) ? ctx.bookmarks : ['Cover', 'Chapter One', 'Appendix'];
  const outline = titles.slice(0, 50).map((title, i) => ({
    title: String(title).slice(0, 120),
    page: i + 1,
    depth: i === 0 ? 0 : 1,
  }));
  // Real PDF outline dictionary (/Outlines + outline items with /Title + /Dest).
  const written = writeClassicOutlinePdf({ titles: outline.map((entry) => entry.title) });
  const pdf = written.bytes;
  if (!pdf.toString('latin1').includes('/Outlines')) {
    fail('OUTLINE_MISSING', 'Classic outline writer did not emit /Outlines.', 502);
  }
  return result('viewer.bookmarks', {
    method: 'local-classic-pdf-outlines',
    outline,
    count: outline.length,
    outputSha256: written.proof.outputSha256,
    pdf,
    bytes: pdf.length,
    outlineApplied: true,
    hasOutlines: true,
    proof: written.proof,
  });
}

