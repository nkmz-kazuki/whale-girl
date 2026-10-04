const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const assetsDirectory = path.resolve(__dirname, '..', 'assets');
const sizes = [256, 128, 64, 48, 32, 24, 16];

function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(assetsDirectory, 'icon.svg'), 'utf8');
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const window = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL('data:text/html;charset=utf-8,<meta charset="utf-8"><title>Icon export</title>');
  const rendered = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(source)};
    await image.decode();
    return ${JSON.stringify([512, ...sizes])}.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, size, size);
      return { size, data: canvas.toDataURL('image/png').split(',')[1] };
    });
  })()`);
  const images = rendered.map(({ size, data }) => ({ size, png: Buffer.from(data, 'base64') }));
  fs.writeFileSync(path.join(assetsDirectory, 'icon.png'), images[0].png);
  fs.writeFileSync(path.join(assetsDirectory, 'icon.ico'), encodeIco(images.slice(1)));
  console.log(`Exported icon.png (512px), icon.ico (${sizes.join(', ')}px).`);
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
