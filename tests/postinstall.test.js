'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getElectronRebuildBinCandidates,
  getElectronRebuildBinName,
  resolveElectronRebuildBin,
  resolveElectronRebuildBinDetails,
} = require('../scripts/postinstall');

test('resolveElectronRebuildBin: hoisted electron-rebuild bin を親 node_modules/.bin から解決する', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-postinstall-'));

  try {
    const appDir = path.join(tempDir, 'app');
    const packageDir = path.join(appDir, 'node_modules', 'vk-terminals');
    const scriptsDir = path.join(packageDir, 'scripts');
    const hoistedBinDir = path.join(appDir, 'node_modules', '.bin');
    const binName = getElectronRebuildBinName();
    const hoistedBin = path.join(hoistedBinDir, binName);
    const nestedBin = path.join(packageDir, 'node_modules', '.bin', binName);

    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(hoistedBinDir, { recursive: true });
    fs.writeFileSync(hoistedBin, '#!/bin/sh\n');

    assert.equal(fs.existsSync(hoistedBin), true);
    assert.equal(fs.existsSync(nestedBin), false);

    const resolved = resolveElectronRebuildBin(scriptsDir);

    assert.equal(resolved, hoistedBin);
    assert.equal(fs.existsSync(resolved), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveElectronRebuildBinDetails: bin が見つからない場合は PATH 解決用の裸の bin 名を返す', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-postinstall-'));

  try {
    const startDir = path.join(tempDir, 'app', 'node_modules', 'vk-terminals', 'scripts');
    fs.mkdirSync(startDir, { recursive: true });

    const resolved = resolveElectronRebuildBinDetails(startDir);

    assert.equal(resolved.found, false);
    assert.equal(resolved.bin, getElectronRebuildBinName());
    assert.equal(resolved.searchedPaths.length > 0, true);
    assert.equal(
      resolved.searchedPaths.some((candidate) => fs.existsSync(candidate)),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getElectronRebuildBinName: Windows では .cmd wrapper を返す', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-postinstall-'));

  try {
    const startDir = path.join(tempDir, 'app', 'node_modules', 'vk-terminals', 'scripts');
    fs.mkdirSync(startDir, { recursive: true });

    assert.equal(getElectronRebuildBinName('win32'), 'electron-rebuild.cmd');
    assert.equal(getElectronRebuildBinName('darwin'), 'electron-rebuild');

    const candidates = getElectronRebuildBinCandidates(startDir, 'win32');

    assert.equal(candidates.length > 0, true);
    assert.equal(
      candidates.some((candidate) => candidate.endsWith('electron-rebuild.cmd')),
      true
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getElectronRebuildBinCandidates: 深い startDir でも有限個の候補を返して終了する', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-postinstall-'));

  try {
    const segments = Array.from({ length: 40 }, (_, index) => `deep-${index}`);
    const startDir = path.join(tempDir, ...segments);
    fs.mkdirSync(startDir, { recursive: true });

    const candidates = getElectronRebuildBinCandidates(startDir);

    assert.equal(Array.isArray(candidates), true);
    assert.equal(Number.isFinite(candidates.length), true);
    assert.equal(candidates.length > 0, true);
    assert.equal(candidates.length < 100, true);
    assert.equal(
      candidates[candidates.length - 1],
      path.join(path.parse(startDir).root, 'node_modules', '.bin', getElectronRebuildBinName())
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
