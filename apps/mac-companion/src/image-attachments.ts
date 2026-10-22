import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageAttachment, MobileCommand } from "@ai-workstation/protocol";

const maxImageBytes = 5 * 1_024 * 1_024;
const attachmentRetentionMs = 24 * 60 * 60 * 1_000;
const attachmentsRoot = join(tmpdir(), "ai-workstation-remote", "attachments");
const extensionByMediaType: Record<ImageAttachment["mediaType"], string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
}

function hasExpectedImageSignature(mediaType: ImageAttachment["mediaType"], contents: Buffer): boolean {
  if (mediaType === "image/png") {
    return contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/jpeg") return contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff;
  if (mediaType === "image/gif") return contents.subarray(0, 6).toString("ascii") === "GIF87a" || contents.subarray(0, 6).toString("ascii") === "GIF89a";
  return contents.length >= 12
    && contents.subarray(0, 4).toString("ascii") === "RIFF"
    && contents.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function cleanupStaleCommandImages(now = Date.now()): Promise<void> {
  const entries = await readdir(attachmentsRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(attachmentsRoot, entry.name);
    const details = await stat(path).catch(() => undefined);
    if (details && now - details.mtimeMs >= attachmentRetentionMs) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }));
}

function scheduleCommandImageCleanup(directory: string): void {
  const timer = setTimeout(() => {
    void rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }, attachmentRetentionMs);
  timer.unref();
}

export async function materializeCommandImages(command: MobileCommand): Promise<MobileCommand> {
  const action = command.action;
  if ((action.kind !== "message" && action.kind !== "new_task") || !action.attachments?.length) {
    return command;
  }

  void cleanupStaleCommandImages();
  const decoded = action.attachments.map((attachment) => {
    const contents = Buffer.from(attachment.data, "base64");
    if (contents.byteLength === 0 || contents.byteLength > maxImageBytes) {
      throw new Error(`图片 ${attachment.name} 超过 5 MB 或内容无效`);
    }
    if (!hasExpectedImageSignature(attachment.mediaType, contents)) {
      throw new Error(`图片 ${attachment.name} 的内容与声明格式不一致`);
    }
    return { attachment, contents };
  });

  const directory = join(attachmentsRoot, safeSegment(command.commandId));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const saved = await Promise.all(decoded.map(async ({ attachment, contents }, index) => {
    const path = join(directory, `${index + 1}-${safeSegment(attachment.id)}${extensionByMediaType[attachment.mediaType]}`);
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
    return { name: attachment.name, path };
  }));

  const imageList = saved.map(({ name, path }) => `- ${name.replace(/\s+/g, " ")}: ${path}`).join("\n");
  const text = `${action.text}\n\n随附图片（请读取并结合图片内容处理）：\n${imageList}`;
  scheduleCommandImageCleanup(directory);
  return { ...command, action: { ...action, text } };
}
