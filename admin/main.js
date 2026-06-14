/**
 * KSTR Admin (Electron).
 *
 * Runs the dashboard backend in this same process (so there's no separate
 * server to babysit), opens the admin control panel, and offers a frameless
 * "Stream Mode" window showing the public dashboard for screen-sharing.
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const backendDir = path.resolve(__dirname, '..', 'backend');
const config = JSON.parse(fs.readFileSync(path.join(backendDir, 'config.json'), 'utf8'));
const BASE = `http://127.0.0.1:${config.httpPort}`;

// Boot the backend in-process. Transitive requires resolve from backend/node_modules.
try {
  require(path.join(backendDir, 'server.js'));
} catch (e) {
  console.error('[admin] backend failed to start:', e);
}

let mainWin = null;
let streamWin = null;

function retryLoad(win, url, n = 0) {
  if (!win || win.isDestroyed()) return;
  win.loadURL(url).catch(() => {
    if (n < 60) setTimeout(() => retryLoad(win, url, n + 1), 300);
  });
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1320,
    height: 920,
    title: 'KSTR Admin',
    backgroundColor: '#4f9fdc',
    webPreferences: { contextIsolation: true },
  });
  retryLoad(mainWin, BASE + '/admin');
  mainWin.on('closed', () => (mainWin = null));
}

function openStream() {
  if (streamWin && !streamWin.isDestroyed()) {
    streamWin.focus();
    return;
  }
  streamWin = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'KSTR - Stream',
    backgroundColor: '#4f9fdc',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  streamWin.maximize();
  retryLoad(streamWin, BASE + '/');
  streamWin.on('closed', () => (streamWin = null));
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'KSTR',
        submenu: [
          { label: 'Admin', click: () => (mainWin ? mainWin.focus() : createMain()) },
          { label: 'Stream Mode', accelerator: 'F11', click: openStream },
          {
            label: 'Toggle Stream Fullscreen',
            accelerator: 'F10',
            click: () => streamWin && streamWin.setFullScreen(!streamWin.isFullScreen()),
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
    ])
  );
}

app.whenReady().then(() => {
  buildMenu();
  createMain();
});

app.on('window-all-closed', () => app.quit());

// The admin "OPEN STREAM VIEW" button calls window.open() - route it to the stream window.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => {
    openStream();
    return { action: 'deny' };
  });
});
