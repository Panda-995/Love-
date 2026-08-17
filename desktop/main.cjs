const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')

const APP_URL = process.env.LOVE_HOME_URL || 'http://127.0.0.1:3000/'

if (!app.requestSingleInstanceLock()) app.quit()

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7edf9',
    icon: path.join(__dirname, '..', 'public', 'desktop-icon.png'),
    title: 'Love小家',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })
  window.loadURL(APP_URL)
}

app.whenReady().then(createWindow)
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) { if (window.isMinimized()) window.restore(); window.focus() }
})
app.on('window-all-closed', () => app.quit())
