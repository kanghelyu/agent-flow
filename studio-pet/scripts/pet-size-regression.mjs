#!/usr/bin/env node
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const project = resolve(import.meta.dirname, '..');
function findElectron() {
  const candidates = [
    process.env.ELECTRON_BIN,
    join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'),
    join(project, 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(project, 'node_modules', 'electron', 'dist', 'electron'),
    join(project, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['electron'], { encoding: 'utf8' });
  const found = String(lookup.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return found || null;
}
const electron = findElectron();
const sizes = [0.2, 0.4, 0.6, 1, 2, 3];
const states = [
  ['idle'],
  ['typing'],
  ['rearup'],
  ['hunt'],
  ['startle'],
  ['mochi'],
  ['paper', 'Gray'],
];
const stableAspectStates = new Set(['idle', 'typing', 'rearup']);
const outputDir = mkdtempSync(join(tmpdir(), 'agent-flow-pet-size-'));

function pngRgba(path) {
  const input = readFileSync(path);
  if (input.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${path} is not a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`Expected an 8-bit RGBA PNG, received depth=${bitDepth}, colorType=${colorType}`);
  }

  const rows = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let source = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = rows[source++];
    const row = rows.subarray(source, source + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? out[x - 4] : 0;
      const above = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 0) out[x] = row[x];
      else if (filter === 1) out[x] = (row[x] + left) & 0xff;
      else if (filter === 2) out[x] = (row[x] + above) & 0xff;
      else if (filter === 3) out[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upperLeft);
        out[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 0xff;
      } else throw new Error(`Unsupported PNG filter ${filter}`);
    }
    source += stride;
    previous = out;
  }

  return { width, height, pixels };
}

function alphaBounds(path) {
  const { width, height, pixels } = pngRgba(path);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] < 16) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error(`No opaque pixels in ${path}`);
  return { width: maxX - minX + 1, height: maxY - minY + 1, x: minX, y: minY };
}

function render(state, size, pattern) {
  const output = join(outputDir, `${state}-${pattern || 'default'}-${size}.png`);
  const args = [`--user-data-dir=${join(outputDir, 'profile')}`, project, '--shot', `--state=${state}`, `--size=${size}`, '--at=80', `--shot-output=${output}`];
  if (pattern) args.push(`--pattern=${pattern}`);
  const result = spawnSync(electron, args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 30000,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0 || !existsSync(output)) {
    throw new Error(`${state} ${size}x screenshot failed:\n${result.stdout}\n${result.stderr}`);
  }
  if (/\[r\] Uncaught|render-process-gone/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`${state} ${size}x renderer error:\n${result.stdout}\n${result.stderr}`);
  }
  return alphaBounds(output);
}

function dispose() {
  rmSync(outputDir, { recursive: true, force: true });
}

try {
  if (!electron) throw new Error('Electron runtime not found. Set ELECTRON_BIN or install the pet dependencies.');
  for (const [state, pattern] of states) {
    const label = pattern ? `${state}/${pattern}` : state;
    const bounds = sizes.map((size) => render(state, size, pattern));
    const reference = bounds[sizes.indexOf(1)];
    const referenceAspect = reference.width / reference.height;
    for (let i = 0; i < bounds.length; i += 1) {
      const current = bounds[i];
      const aspect = current.width / current.height;
      const aspectDelta = Math.abs(aspect / referenceAspect - 1);
      const maxAspectDelta = sizes[i] === 0.2 ? 0.45 : 0.18;
      if (stableAspectStates.has(state) && aspectDelta > maxAspectDelta) {
        throw new Error(`${label} ${sizes[i].toFixed(2)}x: aspect ratio drifted from ${referenceAspect.toFixed(3)} to ${aspect.toFixed(3)}`);
      }
    }
    const small = bounds[0];
    const large = bounds[bounds.length - 1];
    const widthRatio = large.width / small.width;
    const heightRatio = large.height / small.height;
    const minHeightRatio = state === 'paper' ? 1.4 : 2.4;
    if (widthRatio < 2.4 || heightRatio < minHeightRatio) {
      throw new Error(`${label}: expected 3.00x to be visibly larger than 0.20x; got ${small.width}x${small.height} -> ${large.width}x${large.height}`);
    }
    const summary = bounds.map((bound, i) => `${sizes[i].toFixed(2)}x=${bound.width}x${bound.height}`).join(', ');
    console.log(`${label}: ${summary}`);
  }
} finally {
  dispose();
}
