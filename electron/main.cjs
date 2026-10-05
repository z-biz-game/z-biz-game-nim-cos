// Desktop shell: the game is a browser build, so Electron serves it over the same
// zero-dependency static server instead of file:// (ES module imports need an origin).
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startServer } = require('../server.cjs');

// 母题要一直管到窗口外：没打包的 Electron 用的是 Electron 自己的图标，任务栏和 Dock
// 上根本认不出这是这个游戏。缺文件也不许拦开窗 —— 少一张图标，功能一颗不少。
const ICON = path.join(__dirname, '..', 'assets', 'icons', 'icon-512.png');

async function createWindow() {
  const server = await startServer({ port: 0 });
  const { port } = server.address();
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 780,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: '尼姆堆 · NIM',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform === 'darwin' && app.dock && app.dock.setIcon) {
    try {
      app.dock.setIcon(ICON);
    } catch (err) {
      /* 未打包时 Dock 图标拿不到就用系统的，不影响开局 */
    }
  }
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  win.on('closed', () => server.close());
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
