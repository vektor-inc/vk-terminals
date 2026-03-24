const { app, BrowserWindow, ipcMain, screen } = require('electron');
const pty = require('node-pty');
const path = require('path');
const os = require('os');

let win;
const ptys = new Map();
let nextId = 1;
let firstTerminalCreated = false;

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const winW = Math.min(1400, workAreaSize.width);
  const winH = Math.min(900, workAreaSize.height);
  const x = Math.round((workAreaSize.width - winW) / 2);
  const y = Math.round((workAreaSize.height - winH) / 2);

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: '#0d1117',
    title: 'Terminals',
  });

  win.loadFile('renderer/index.html');
  // win.webContents.openDevTools(); // uncomment to debug
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const [, p] of ptys) {
    try { p.kill(); } catch (e) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, p] of ptys) {
    try { p.kill(); } catch (e) {}
  }
});

ipcMain.handle('terminal:create', (event, cwd) => {
  const id = String(nextId++);
  const shell = process.env.SHELL || '/bin/zsh';
  const resolvedCwd = cwd || '/Users/kurudrive/.claude';

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env, TERM_PROGRAM: 'ClaudeTerminals' },
  });

  ptyProcess.onData((data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:data', id, data);
    }
  });

  ptyProcess.onExit(() => {
    ptys.delete(id);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:exit', id);
    }
  });

  ptys.set(id, ptyProcess);

  // 起動後に自動でclaudeを実行
  setTimeout(() => {
    if (ptys.has(id)) {
      ptyProcess.write('claude\r');
    }
  }, 200);

  // claude起動後にタスク管理スキルを呼び出す（最初の1回のみ）
  if (!firstTerminalCreated) {
    firstTerminalCreated = true;
    setTimeout(() => {
      if (ptys.has(id)) {
        ptyProcess.write('スキルでタスク管理を呼び出して\r');
      }
    }, 4000);
  }

  return { id, cwd: resolvedCwd };
});

ipcMain.on('terminal:input', (event, id, data) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});

ipcMain.on('terminal:resize', (event, id, cols, rows) => {
  const p = ptys.get(id);
  if (p) {
    try { p.resize(Math.max(2, cols), Math.max(2, rows)); } catch (e) {}
  }
});

ipcMain.on('terminal:kill', (event, id) => {
  const p = ptys.get(id);
  if (p) {
    try { p.kill(); } catch (e) {}
    ptys.delete(id);
  }
});
