import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFallbackText } from '../scripts/host/office-extractor.mjs';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(content), 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test('ZIP reader accepts bounded safe stored entries and rejects unsafe paths', () => {
  const archive = storedZip([['word/document.xml', '<w:t>Local</w:t>']]);
  assert.equal(readZipEntries(archive).get('word/document.xml').toString(), '<w:t>Local</w:t>');
  assert.throws(() => readZipEntries(storedZip([['../escape.txt', 'no']])), { code: 'INVALID_ARCHIVE_PATH' });
});

test('deterministic extractors preserve OOXML, OpenDocument, and passive text content', () => {
  assert.equal(extractFallbackText(storedZip([['word/document.xml', '<w:document><w:p><w:t>DOCX LOCAL</w:t></w:p></w:document>']]), '.docx'), 'DOCX LOCAL');
  assert.equal(extractFallbackText(storedZip([['ppt/slides/slide1.xml', '<p:sld><a:t>PPTX LOCAL</a:t></p:sld>']]), '.pptx'), 'PPTX LOCAL');
  assert.equal(extractFallbackText(storedZip([
    ['xl/sharedStrings.xml', '<sst><si><t>XLSX LOCAL</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>'],
  ]), '.xlsx'), 'XLSX LOCAL');
  assert.equal(extractFallbackText(storedZip([['content.xml', '<office:text><text:p>ODF LOCAL</text:p></office:text>']]), '.odt'), 'ODF LOCAL');
  assert.equal(extractFallbackText(Buffer.from('{\\rtf1\\ansi RTF\\par LOCAL}'), '.rtf'), 'RTF\nLOCAL');
  assert.equal(extractFallbackText(Buffer.from('<html><body><p>HTML LOCAL</p></body></html>'), '.html'), 'HTML LOCAL');
});

test('fixed OOXML tag extraction handles large text nodes without pattern construction', () => {
  const payload = 'local '.repeat(175_000);
  const archive = storedZip([[
    'word/document.xml',
    `<w:document><w:p><w:t>${payload}&amp;more</w:t></w:p></w:document>`,
  ]]);
  assert.equal(extractFallbackText(archive, '.docx'), `${payload}&more`);
});

test('legacy Office formats keep a typed local-engine requirement', () => {
  assert.throws(() => extractFallbackText(Buffer.from('legacy'), '.doc'), { code: 'LEGACY_OFFICE_FORMAT_REQUIRES_LIBREOFFICE', status: 422 });
});
