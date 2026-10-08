// Keep the Windows orange-V ICO as the canonical app-icon source.
// Generate consistent PNG (Linux/Tauri) and ICNS (macOS) without dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const iconRoot = resolve(root, "src-tauri/icons");
const checkOnly = process.argv.includes("--check");
const ico = readFileSync(resolve(iconRoot, "icon.ico"));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getPngsFromIco(input) {
  assert(input.readUInt16LE(0) === 0 && input.readUInt16LE(2) === 1, "Expected a valid ICO header");
  const count = input.readUInt16LE(4);
  assert(input.length >= 6 + 16 * count, "Truncated ICO directory");
  const images = new Map();
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const width = input[at] || 256;
    const height = input[at + 1] || 256;
    const length = input.readUInt32LE(at + 8);
    const offset = input.readUInt32LE(at + 12);
    assert(width === height && offset + length <= input.length, "Invalid ICO image bounds");
    const png = input.subarray(offset, offset + length);
    assert(png.subarray(0, 8).equals(pngSignature), "ICO must contain PNG images, not DIB/BMP");
    assert(png.readUInt32BE(16) === width && png.readUInt32BE(20) === height, "ICO/PNG sizes differ");
    images.set(width, png);
  }
  assert(images.has(16) && images.has(32), "Windows ICO must supply 16px and 32px artwork");
  return images;
}

function icnsChunk(type, png) {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
}

function makeIcns(images) {
  // Apple's PNG-based ICNS variants: icp4=16x16, icp5=32x32.
  const chunks = [icnsChunk("icp4", images.get(16)), icnsChunk("icp5", images.get(32))];
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, part) => sum + part.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function generateOrCheck(path, expected) {
  if (checkOnly) {
    let actual;
    try { actual = readFileSync(path); } catch { throw new Error("Missing generated icon: " + path); }
    assert(actual.equals(expected), "Icon differs from Windows icon.ico: " + path + ". Run npm run icons:generate");
  } else {
    writeFileSync(path, expected);
  }
}

const images = getPngsFromIco(ico);
generateOrCheck(resolve(iconRoot, "icon.png"), images.get(32));
generateOrCheck(resolve(iconRoot, "icon.icns"), makeIcns(images));
console.log(checkOnly ? "Icon parity check PASS (ICO/PNG/ICNS)" : "Generated matching PNG and macOS ICNS from Windows ICO");
