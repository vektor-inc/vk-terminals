'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveElectronRebuildBin } = require('../scripts/postinstall');

test('resolveElectronRebuildBin: hoisted electron-rebuild bin を親 node_modules/.bin から解決する', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-postinstall-'));

  try {
    const appDir = path.join(tempDir, 'app');
    const packageDir = path.join(appDir, 'node_modules', 'vk-terminals');
    const scriptsDir = path.join(packageDir, 'scripts');
    const hoistedBinDir = path.join(appDir, 'node_modules', '.bin');
    const binName = process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild';
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
