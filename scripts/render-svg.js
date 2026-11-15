// Renders an SVG to PNG(s) with Electron: electron scripts/render-svg.js <in.svg> <out.png> <size> [<out2.png> <size2> ...]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [, , input, ...rest] = process.argv.filter((a) => a !== '.');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(input, 'utf8');
  for (let i = 0; i < rest.length; i += 2) {
    const size = Number(rest[i + 1]);
    const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: false } });
    const html = `<html><body style="margin:0;background:transparent"><img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(rest[i], img.toPNG());
    win.destroy();
  }
  app.quit();
});
