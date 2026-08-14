export function pdfUtf16BeString(value) {
  const bytes = [0xfe, 0xff];
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    bytes.push(unit >> 8, unit & 0xff);
  }
  return Object.freeze({ type: 'string', bytes: Buffer.from(bytes) });
}
