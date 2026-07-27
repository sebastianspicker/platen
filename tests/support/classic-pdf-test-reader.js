import { assert, sourceSha256 } from '../host-pdfkit-test-core.js';

export class ClassicPdfTestReader {
  #data;
  #text;
  #xref = new Map();
  #xrefOffset;
  #root;
  #objectCache = new Map();

  constructor(data) {
    this.#data = data;
    this.#text = data.toString('latin1');
    const startXrefs = [...this.#text.matchAll(/startxref\s+(\d+)\s+%%EOF/gu)];
    assert.ok(startXrefs.length > 0, 'classic PDF must end with startxref');
    this.#xrefOffset = Number(startXrefs.at(-1)[1]);
    assert.equal(
      this.#text.slice(this.#xrefOffset, this.#xrefOffset + 4),
      'xref',
      'startxref must address a classic xref table',
    );
    const trailerOffset = this.#text.indexOf('trailer', this.#xrefOffset + 4);
    assert.ok(trailerOffset > this.#xrefOffset, 'classic xref table must have a trailer');
    this.#parseXref(this.#text.slice(this.#xrefOffset + 4, trailerOffset));
    const startXrefOffset = this.#text.lastIndexOf('startxref');
    const trailer = this.#text.slice(trailerOffset, startXrefOffset);
    const root = /\/Root\s+(\d+)\s+(\d+)\s+R\b/u.exec(trailer);
    assert.ok(root, 'classic trailer must identify the catalog');
    this.#root = { objectNumber: Number(root[1]), generation: Number(root[2]) };
  }

  #parseXref(value) {
    const lines = value.trim().split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length;) {
      const header = /^(\d+)\s+(\d+)$/u.exec(lines[lineIndex].trim());
      assert.ok(header, `invalid classic xref subsection: ${lines[lineIndex]}`);
      const firstObject = Number(header[1]);
      const count = Number(header[2]);
      lineIndex += 1;
      for (let entryIndex = 0; entryIndex < count; entryIndex += 1, lineIndex += 1) {
        const entry = /^(\d{10})\s+(\d{5})\s+([fn])\b/u.exec(lines[lineIndex].trim());
        assert.ok(entry, `invalid classic xref entry: ${lines[lineIndex]}`);
        if (entry[3] === 'n') {
          this.#xref.set(firstObject + entryIndex, {
            offset: Number(entry[1]),
            generation: Number(entry[2]),
          });
        }
      }
    }
  }

  rootReference() {
    return { ...this.#root };
  }

  object(reference) {
    const entry = this.#xref.get(reference.objectNumber);
    assert.ok(entry, `missing xref entry for object ${reference.objectNumber}`);
    assert.equal(
      entry.generation,
      reference.generation,
      'xref generation must match the reference',
    );
    const header = new RegExp(
      `^${reference.objectNumber}\\s+${reference.generation}\\s+obj\\b`,
      'u',
    ).exec(this.#text.slice(entry.offset));
    assert.ok(header, `xref offset must address object ${reference.objectNumber}`);
    const cached = this.#objectCache.get(reference.objectNumber);
    if (cached) return cached;
    const bodyStart = entry.offset + header[0].length;
    const nextObjectOffset = [...this.#xref.values()]
      .map(({ offset }) => offset)
      .filter((offset) => offset > entry.offset)
      .sort((left, right) => left - right)[0] ?? this.#xrefOffset;
    const bodyEnd = this.#text.lastIndexOf('\nendobj', nextObjectOffset);
    assert.ok(bodyEnd > bodyStart, `object ${reference.objectNumber} must terminate`);
    const value = {
      body: this.#data.subarray(bodyStart, bodyEnd),
      text: this.#text.slice(bodyStart, bodyEnd).trim(),
    };
    this.#objectCache.set(reference.objectNumber, value);
    return value;
  }

  skipWhitespace(value, start) {
    let cursor = start;
    while (cursor < value.length) {
      if (/\s/u.test(value[cursor])) {
        cursor += 1;
        continue;
      }
      if (value[cursor] === '%') {
        while (cursor < value.length && !/[\r\n]/u.test(value[cursor])) cursor += 1;
        continue;
      }
      break;
    }
    return cursor;
  }

  token(value, start = 0) {
    const cursor = this.skipWhitespace(value, start);
    const reference = /^(\d+)\s+(\d+)\s+R\b/u.exec(value.slice(cursor));
    if (reference) return { raw: reference[0], end: cursor + reference[0].length };
    const opener = value.slice(cursor, cursor + 2) === '<<' ? '<<' : value[cursor];
    const closer = opener === '<<' ? '>>'
      : opener === '[' ? ']'
        : opener === '(' ? ')'
          : opener === '<' ? '>' : null;
    if (closer) {
      let depth = 1;
      let index = cursor + opener.length;
      while (index < value.length && depth > 0) {
        if (opener === '(' && value[index] === '\\') {
          index += 2;
          continue;
        }
        if (value.slice(index, index + opener.length) === opener) {
          depth += 1;
          index += opener.length;
          continue;
        }
        if (value.slice(index, index + closer.length) === closer) {
          depth -= 1;
          index += closer.length;
          continue;
        }
        index += 1;
      }
      assert.equal(depth, 0, `unterminated PDF token beginning with ${opener}`);
      return { raw: value.slice(cursor, index), end: index };
    }
    const scalar = /^[^\s\[\]<>()]+/u.exec(value.slice(cursor));
    assert.ok(scalar, `invalid PDF token at offset ${cursor}`);
    return { raw: scalar[0], end: cursor + scalar[0].length };
  }

  valueForKey(dictionary, key) {
    const match = new RegExp(`/${key}(?![A-Za-z0-9])`, 'u').exec(dictionary);
    assert.ok(match, `dictionary must contain /${key}`);
    return this.token(dictionary, match.index + match[0].length).raw;
  }

  optionalValueForKey(dictionary, key) {
    const match = new RegExp(`/${key}(?![A-Za-z0-9])`, 'u').exec(dictionary);
    return match ? this.token(dictionary, match.index + match[0].length).raw : null;
  }

  reference(value) {
    const match = /^(\d+)\s+(\d+)\s+R\b/u.exec(value.trim());
    assert.ok(match, `expected indirect reference, received ${value}`);
    return { objectNumber: Number(match[1]), generation: Number(match[2]) };
  }

  arrayReferences(value) {
    let array = value.trim();
    if (!array.startsWith('[')) array = this.object(this.reference(array)).text;
    assert.ok(
      array.startsWith('[') && array.endsWith(']'),
      'expected direct or indirect reference array',
    );
    return [...array.matchAll(/(\d+)\s+(\d+)\s+R\b/gu)].map((match) => ({
      objectNumber: Number(match[1]),
      generation: Number(match[2]),
    }));
  }

  streamHash(indirectObject) {
    const marker = /stream\r?\n/u.exec(indirectObject.text);
    if (!marker) return null;
    const lengthValue = this.valueForKey(
      indirectObject.text.slice(0, marker.index),
      'Length',
    );
    const length = /^\d+$/u.test(lengthValue)
      ? Number(lengthValue)
      : Number(this.object(this.reference(lengthValue)).text.trim());
    assert.ok(Number.isSafeInteger(length) && length >= 0, 'stream length must be a bounded integer');
    const bodyText = indirectObject.body.toString('latin1');
    const bodyMarker = /stream\r?\n/u.exec(bodyText);
    const bytes = indirectObject.body.subarray(
      bodyMarker.index + bodyMarker[0].length,
      bodyMarker.index + bodyMarker[0].length + length,
    );
    assert.equal(bytes.length, length, 'stream bytes must match /Length');
    return `stream:${length}:${sourceSha256(bytes)}`;
  }

  canonicalValue(value, depth = 0, active = new Set()) {
    assert.ok(depth <= 8, 'appearance graph depth must remain bounded');
    const trimmed = value.trim();
    if (/^\d+\s+\d+\s+R\b/u.test(trimmed)) {
      const reference = this.reference(trimmed);
      assert.ok(!active.has(reference.objectNumber), 'appearance graph must not cycle');
      const child = this.object(reference);
      const childStream = this.streamHash(child);
      if (childStream) return childStream;
      active.add(reference.objectNumber);
      const result = this.canonicalValue(child.text, depth + 1, active);
      active.delete(reference.objectNumber);
      return result;
    }
    if (trimmed.startsWith('<<')) {
      return this.#canonicalDictionary(trimmed, depth, active);
    }
    if (trimmed.startsWith('[')) {
      return this.#canonicalArray(trimmed, depth, active);
    }
    return trimmed.replace(/\s+/gu, ' ');
  }

  #canonicalDictionary(value, depth, active) {
    const entries = [];
    let cursor = 2;
    while ((cursor = this.skipWhitespace(value, cursor)) < value.length - 2) {
      const key = this.token(value, cursor);
      assert.ok(key.raw.startsWith('/'), 'appearance dictionary keys must be names');
      const child = this.token(value, key.end);
      entries.push(`${key.raw}=${this.canonicalValue(child.raw, depth + 1, active)}`);
      cursor = child.end;
    }
    return `dict:{${entries.sort().join(',')}}`;
  }

  #canonicalArray(value, depth, active) {
    const children = [];
    let cursor = 1;
    while ((cursor = this.skipWhitespace(value, cursor)) < value.length - 1) {
      const child = this.token(value, cursor);
      children.push(this.canonicalValue(child.raw, depth + 1, active));
      cursor = child.end;
    }
    return `array:[${children.join(',')}]`;
  }

  decodedStringDigest(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('<')) {
      let hex = trimmed.slice(1, -1).replace(/\s+/gu, '');
      if (hex.length % 2 === 1) hex += '0';
      return sourceSha256(Buffer.from(hex, 'hex'));
    }
    assert.ok(trimmed.startsWith('('), 'annotation contents must be a PDF string');
    return sourceSha256(Buffer.from(this.#decodedLiteralString(trimmed)));
  }

  #decodedLiteralString(value) {
    const bytes = [];
    for (let index = 1; index < value.length - 1; index += 1) {
      const byte = value.charCodeAt(index);
      if (byte !== 0x5c) {
        bytes.push(byte);
        continue;
      }
      index += 1;
      const escaped = value[index];
      if (escaped === '\r' && value[index + 1] === '\n') {
        index += 1;
        continue;
      }
      if (escaped === '\r' || escaped === '\n') continue;
      const simple = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c };
      if (Object.hasOwn(simple, escaped)) {
        bytes.push(simple[escaped]);
        continue;
      }
      if (/[0-7]/u.test(escaped)) {
        let octal = escaped;
        while (octal.length < 3 && /[0-7]/u.test(value[index + 1] ?? '')) {
          octal += value[++index];
        }
        bytes.push(Number.parseInt(octal, 8));
        continue;
      }
      bytes.push(escaped.charCodeAt(0));
    }
    return bytes;
  }
}
