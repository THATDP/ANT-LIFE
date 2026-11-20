import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serveClientAsset } from '../src/http/staticClient.js';

test('production static client serves the SPA safely with correct caching and MIME headers', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ant-life-client-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<main>ANT LIFE</main>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("ant");');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (!serveClientAsset(request, response, url, root)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await home.text(), '<main>ANT LIFE</main>');
    assert.equal(home.headers.get('cache-control'), 'no-store');

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

    const route = await fetch(`${base}/colony/map`);
    assert.equal(await route.text(), '<main>ANT LIFE</main>', 'unknown extension-free routes fall back to the SPA entry point');

    const missing = await fetch(`${base}/assets/missing.js`);
    assert.equal(missing.status, 404);
    const traversal = await fetch(`${base}/..%2Foutside.txt`);
    assert.equal(traversal.status, 404, 'encoded parent traversal cannot escape the static root');

    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
