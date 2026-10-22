import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MobileCommand } from "@ai-workstation/protocol";

import { cleanupStaleCommandImages, materializeCommandImages } from "./image-attachments.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52]);

test("materializes image attachments and adds readable paths to the prompt", async () => {
  const command: MobileCommand = {
    protocolVersion: 1,
    commandId: `command_image_${crypto.randomUUID()}`,
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_image_1",
    action: {
      kind: "message",
      text: "分析截图",
      attachments: [{
        id: "image_1",
        kind: "image",
        name: "screen.png",
        mediaType: "image/png",
        data: pngBytes.toString("base64"),
      }],
    },
  };

  const materialized = await materializeCommandImages(command);
  assert.equal(materialized.action.kind, "message");
  if (materialized.action.kind !== "message") return;
  const path = materialized.action.text.match(/\/[^\n]+\.png/)?.[0];
  assert.ok(path);
  assert.deepEqual(await readFile(path), pngBytes);
  assert.match(materialized.action.text, /screen\.png/);
  await rm(join(path, ".."), { recursive: true, force: true });
});

test("rejects an attachment whose bytes do not match its declared media type", async () => {
  const command = {
    protocolVersion: 1,
    commandId: `command_image_${crypto.randomUUID()}`,
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_image_invalid",
    action: {
      kind: "message",
      text: "分析截图",
      attachments: [{ id: "image_1", kind: "image", name: "fake.png", mediaType: "image/png", data: Buffer.from("not a png").toString("base64") }],
    },
  } as MobileCommand;

  await assert.rejects(materializeCommandImages(command), /内容与声明格式不一致/);
});

test("removes attachment directories after the retention window", async () => {
  const directory = join(tmpdir(), "ai-workstation-remote", "attachments", `stale_${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "image.png"), pngBytes);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(directory, old, old);

  await cleanupStaleCommandImages();

  await assert.rejects(stat(directory), { code: "ENOENT" });
});
