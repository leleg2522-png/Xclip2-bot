import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'alriz-hosting-test-'));
  const app = express();
  const ctx = vm.createContext({
    app, path, fsp, crypto, Buffer, createReadStream: fs.createReadStream,
    os: { tmpdir: () => directory },
    process: { env: { PUBLIC_BASE_URL: 'https://our-domain.test' } },
  });
  const formats = source.slice(source.indexOf('function detectMime('), source.indexOf('async function toDataUri('));
  const publishing = source.slice(source.indexOf('const MEDIA_DIR ='), source.indexOf('// Sweep expired media'));
  const serving = source.slice(source.indexOf("app.get('/dl/:token'"), source.indexOf('app.listen(PORT'));
  assert.ok(formats && publishing && serving);
  vm.runInContext(compile(`${formats}\n${publishing}\n${serving}`), ctx);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  try {
    for (const [bytes, isVideo, ext, mime] of [
      [jpeg, false, 'jpg', 'image/jpeg'],
      [png, false, 'png', 'image/png'],
      [video, true, 'mp4', 'video/mp4'],
    ] as const) {
      const url: string = await ctx.publishMedia(bytes, isVideo, undefined, true);
      const route = new URL(url).pathname;
      assert.match(route, new RegExp(`^/dl/[a-f0-9]{32}\\.${ext}$`));
      const response = await fetch(origin + route);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('content-disposition'), `inline; filename="output.${ext}"`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal((await fetch(origin + route, { method: 'HEAD' })).status, 200);
      // Extension aliases must point to the same entry; old token-only links still work.
      const legacy = route.replace(/\.[^.]+$/, '');
      assert.equal((await fetch(origin + legacy)).status, 200);
      assert.equal((await fetch(origin + legacy + '.exe')).status, 404);
      assert.equal((await fetch(origin + route + '.extra')).status, 404);
      assert.equal((await fetch(origin + legacy + '.')).status, 404);
      assert.equal((await fetch(origin + legacy + (ext === 'mp4' ? '.jpg' : '.mp4'))).status, 404);
    }
    const oldUrl: string = await ctx.publishMedia(jpeg, false);
    const oldRoute = new URL(oldUrl).pathname;
    assert.match(oldRoute, /^\/dl\/[a-f0-9]{32}$/);
    assert.equal((await fetch(origin + oldRoute)).status, 200);
    vm.runInContext('for (const entry of mediaStore.values()) entry.expiresAt = 0;', ctx);
    assert.equal((await fetch(origin + oldRoute)).status, 404);
    console.log('Alriz reference hosting: real GET/HEAD, correct extensions/MIME/bytes, legacy links, expiry and invalid aliases passed.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fsp.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
