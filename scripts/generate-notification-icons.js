'use strict';

// Web App Manifest（renderer/manifest.webmanifest）の icons 用 PNG を生成するワンショットの
// ビルドスクリプト（issue #396）。外部の画像編集ツール・npm パッケージを使わず、Node 標準の
// zlib だけで単色背景 + 白いベルのシルエットという最小限の PNG を組み立てる。
//
// 生成物（renderer/icons/icon-192.png, icon-512.png）は git 管理下のバイナリとしてコミットし、
// このスクリプトは「後でアイコンを描き直したくなったときの再現手段」として残す
// （通常のビルド手順には組み込まない。npm run 経由でも呼ばない）。
//
// 背景色はモバイルページのアクセントカラー（renderer/mobile.css の --accent: #2563eb）に合わせ、
// ホーム画面・通知シェード上で vk-terminals の他の画面と統一感を持たせる。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x25, 0x63, 0xeb, 0xff]; // --accent
const FG = [0xff, 0xff, 0xff, 0xff]; // 白

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// pixelFn(x, y) は [r,g,b,a]（0-255）を返す。
function buildPng(width, height, pixelFn) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0; // フィルタなし
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[pos++] = r; raw[pos++] = g; raw[pos++] = b; raw[pos++] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// maskable アイコン（Android のアダプティブアイコン）の safe zone（中央 80% 直径の円内に主要
// コンテンツを収める）に合わせ、ベルのシルエットを中央 60% 相当の大きさに収める。
function bellPixel(cx, cy, r, x, y) {
  const dx = x - cx;
  const dy = y - cy;
  // ベル本体（釣鐘型）: 上半分は半径 r の円、下半分は少し広がる台形で近似する。
  const bodyR = dy < 0 ? r * (1 - Math.abs(dy) / (r * 2.2)) : r;
  const inBody = (dy >= -r * 1.15 && dy <= r * 0.65) && Math.abs(dx) <= bodyR * (dy < 0 ? 0.72 : 1);
  // 台座（ベル下端の縁）
  const inRim = dy > r * 0.55 && dy <= r * 0.78 && Math.abs(dx) <= r * 1.15;
  // 下部の舌（clapper）
  const clapperDx = dx;
  const clapperDy = dy - r * 1.05;
  const inClapper = (clapperDx * clapperDx + clapperDy * clapperDy) <= (r * 0.16) * (r * 0.16);
  return inBody || inRim || inClapper;
}

function makeIcon(size) {
  const cx = size / 2;
  const cy = size / 2 + size * 0.03;
  const r = size * 0.24;
  return buildPng(size, size, (x, y) => (bellPixel(cx, cy, r, x, y) ? FG : BG));
}

const outDir = path.join(__dirname, '..', 'renderer', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const buf = makeIcon(size);
  const outPath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${buf.length} bytes)`);
}
