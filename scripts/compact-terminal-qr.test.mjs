import assert from "node:assert/strict";
import test from "node:test";
import { compactQrAccessUrl, createQrModules, renderCompactQr } from "./compact-terminal-qr.mjs";

const token = "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456";
const accessUrl = compactQrAccessUrl("https://ample-voice-1234.trycloudflare.com", token);

test("keeps the compact QR token in the URL fragment", () => {
  assert.equal(accessUrl, `HTTPS://AMPLE-VOICE-1234.TRYCLOUDFLARE.COM/#${token}`);
  assert.equal(new URL(accessUrl).pathname, "/");
  assert.equal(new URL(accessUrl).hash, `#${token}`);
});

test("renders the compact QR matrix with a four-module quiet zone", () => {
  const modules = createQrModules(accessUrl);

  assert.ok(modules.length >= 29);
  assert.ok(modules.every((row) => row.length === modules.length));
  for (let offset = 0; offset < 4; offset += 1) {
    assert.ok(modules[offset].every((module) => module === false));
    assert.ok(modules.at(-(offset + 1)).every((module) => module === false));
    assert.ok(modules.every((row) => row[offset] === false));
    assert.ok(modules.every((row) => row.at(-(offset + 1)) === false));
  }
});

test("renders each terminal row on an explicit opaque dark background", () => {
  const output = renderCompactQr(accessUrl);
  const rows = output.split("\n");

  assert.ok(rows.every((row) => row.startsWith("\x1b[38;2;255;255;255;48;2;0;24;64m")));
  assert.ok(rows.every((row) => row.endsWith("\x1b[0m")));
  assert.ok(rows.every((row) => (row.match(/\x1b\[/g) ?? []).length === 2));
  assert.match(output, /[▀▄█]/);
});
