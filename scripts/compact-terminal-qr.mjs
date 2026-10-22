import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const QRMode = require("qrcode-terminal/vendor/QRCode/QRMode");

const alphanumericCharacters = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const light = false;
const quietZone = 4;
const terminalQrColors = "\x1b[38;2;255;255;255;48;2;0;24;64m";
const resetTerminalColors = "\x1b[0m";

function addAlphanumericData(qrcode, input) {
  qrcode.dataList.push({
    mode: QRMode.MODE_ALPHA_NUM,
    getLength: () => input.length,
    write(buffer) {
      let offset = 0;
      while (offset + 1 < input.length) {
        const first = alphanumericCharacters.indexOf(input[offset]);
        const second = alphanumericCharacters.indexOf(input[offset + 1]);
        buffer.put(first * 45 + second, 11);
        offset += 2;
      }
      if (offset < input.length) {
        buffer.put(alphanumericCharacters.indexOf(input[offset]), 6);
      }
    },
  });
}

export function createQrModules(input) {
  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  const fragmentIndex = input.indexOf("#");
  const compactFragment = fragmentIndex > 0
    && [...input.slice(0, fragmentIndex), ...input.slice(fragmentIndex + 1)]
      .every((character) => alphanumericCharacters.includes(character));
  if (compactFragment) {
    addAlphanumericData(qrcode, input.slice(0, fragmentIndex));
    qrcode.addData("#");
    addAlphanumericData(qrcode, input.slice(fragmentIndex + 1));
  } else if ([...input].every((character) => alphanumericCharacters.includes(character))) {
    addAlphanumericData(qrcode, input);
  } else {
    qrcode.addData(input);
  }
  qrcode.make();

  const size = qrcode.getModuleCount() + quietZone * 2;
  return Array.from({ length: size }, (_, row) => (
    Array.from({ length: size }, (_, column) => {
      const qrRow = row - quietZone;
      const qrColumn = column - quietZone;
      return qrRow >= 0
        && qrRow < qrcode.getModuleCount()
        && qrColumn >= 0
        && qrColumn < qrcode.getModuleCount()
        ? qrcode.isDark(qrRow, qrColumn)
        : light;
    })
  ));
}

export function compactQrAccessUrl(tunnelUrl, token) {
  return `${tunnelUrl.toUpperCase()}/#${token}`;
}

export function renderCompactQr(input) {
  const modules = createQrModules(input);
  const size = modules.length;
  if (modules.length % 2 !== 0) modules.push(Array(size).fill(light));

  const rows = [];
  for (let top = 0; top < modules.length; top += 2) {
    let row = terminalQrColors;
    for (let column = 0; column < size; column += 1) {
      const topIsDark = modules[top][column];
      const bottomIsDark = modules[top + 1][column];
      if (!topIsDark && !bottomIsDark) row += "█";
      else if (!topIsDark && bottomIsDark) row += "▀";
      else if (topIsDark && !bottomIsDark) row += "▄";
      else row += " ";
    }
    rows.push(`${row}${resetTerminalColors}`);
  }

  return rows.join("\n");
}
