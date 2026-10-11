// Renders build/icon.svg to build/icon.png (1024²) with Electron's own Chromium.
// electron-builder derives the .icns (macOS) and .ico (Windows) from that PNG; Linux desktops
// want the standard sizes too: for s in 16 24 32 48 64 128 256 512; do sips -z $s $s build/icon.png --out build/icons/${s}x${s}.png; done
// Usage: npx electron scripts/render-icon.cjs
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const dir = path.join(__dirname, '..', 'build')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({width: SIZE, height: SIZE, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: {offscreen: true, zoomFactor: 1}})
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8')
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  const image = (await win.webContents.capturePage({x: 0, y: 0, width: SIZE, height: SIZE})).resize({width: SIZE, height: SIZE})
  fs.writeFileSync(path.join(dir, 'icon.png'), image.toPNG())
  console.log('build/icon.png', image.getSize())
  app.quit()
})
