import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = join(projectRoot, "apps", "cursor-relay-extension");

export async function packageCursorRelay(outputPath) {
  const extensionManifest = JSON.parse(await readFile(join(extensionSource, "package.json"), "utf8"));
  const stage = await mkdtemp(join(tmpdir(), "cursor-relay-vsix-"));

  try {
    await mkdir(join(stage, "extension"), { recursive: true });
    await cp(join(extensionSource, "package.json"), join(stage, "extension", "package.json"));
    await cp(join(extensionSource, "extension.js"), join(stage, "extension", "extension.js"));
    await cp(join(projectRoot, "LICENSE"), join(stage, "extension", "LICENSE"));
    await writeFile(join(stage, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
`);
    await writeFile(join(stage, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${extensionManifest.name}" Version="${extensionManifest.version}" Publisher="${extensionManifest.publisher}" />
    <DisplayName>${extensionManifest.displayName}</DisplayName>
    <Description xml:space="preserve">${extensionManifest.description}</Description>
    <Tags>cursor,local,relay</Tags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`);
    await mkdir(dirname(outputPath), { recursive: true });
    await rm(outputPath, { force: true });
    if (process.platform === "win32") {
      const zipPath = `${outputPath}.zip`;
      await rm(zipPath, { force: true });
      execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Compress-Archive -Path (Join-Path $args[0] '*') -DestinationPath $args[1] -CompressionLevel Optimal -Force",
        stage,
        zipPath,
      ], { stdio: "inherit", windowsHide: true });
      await rename(zipPath, outputPath);
    } else {
      execFileSync("zip", ["-qr", outputPath, "."], { cwd: stage });
    }
    return extensionManifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error("Usage: node scripts/package-cursor-relay.mjs <output.vsix>");
    process.exit(2);
  }
  const manifest = await packageCursorRelay(resolve(outputPath));
  console.log(`Cursor relay ${manifest.version} packaged at ${resolve(outputPath)}`);
}
