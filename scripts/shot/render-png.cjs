// 把一个 SVG 栅格化为带透明通道的 PNG(无原生栅格化工具时的兜底:用 Chromium 渲染)。
const { app, BrowserWindow } = require("electron");
const fs = require("fs");

const SVG = process.env.RP_SVG;
const OUT = process.env.RP_OUT;
const SIZE = Number(process.env.RP_SIZE || 1024);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, "utf8");
  const html =
    "<!doctype html><html><head><meta charset='utf-8'><style>" +
    "html,body{margin:0;padding:0;background:transparent}" +
    "svg{display:block;width:" + SIZE + "px;height:" + SIZE + "px}" +
    "</style></head><body>" + svg + "</body></html>";

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { offscreen: false }
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await wait(800);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  // eslint-disable-next-line no-console
  console.log("wrote", OUT, img.getSize());
  app.quit();
});
