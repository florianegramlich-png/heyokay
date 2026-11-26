import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../app/manifest';

// Android installs the web app from its manifest (Chrome needs a name, standalone display and 192 + 512 px icons).

test('installable on Android: name, standalone, start page, theme', () => {
  const m = manifest();
  assert.equal(m.name, 'Hey-Okay');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.theme_color, '#0F1430');
});

test('192 and 512 px icons exist with the size they claim, plus a maskable one', () => {
  const m = manifest();
  for (const size of [192, 512]) assert.ok(m.icons!.some((i) => i.sizes === `${size}x${size}`), `${size}px`);
  assert.ok(m.icons!.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons!) {
    const file = join(import.meta.dirname, '..', 'public', i.src);
    assert.ok(existsSync(file), i.src);
    const png = readFileSync(file);
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)]; // PNG IHDR
    assert.equal(`${w}x${h}`, i.sizes, i.src);
  }
});
