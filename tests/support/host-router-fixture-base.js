import { Readable, Writable } from 'node:stream';

class MockResponse extends Writable {
  chunks = []; statusCode = null; headers = {};
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  get body() { return Buffer.concat(this.chunks); }
}

function request({ method = 'GET', url = '/', headers = {}, body = [] } = {}) {
  const stream = Readable.from(Array.isArray(body) ? body : [body]);
  stream.method = method; stream.url = url; stream.headers = { host: '127.0.0.1:4173', ...headers };
  return stream;
}

export async function invoke(handler, options) {
  const response = new MockResponse();
  await handler(request(options), response);
  if (!response.writableFinished) await new Promise((resolve) => response.once('finish', resolve));
  return response;
}
