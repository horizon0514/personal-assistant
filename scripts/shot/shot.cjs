const { app, BrowserWindow, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");

const TARGET = process.env.SHOT_TARGET;
const OUT = process.env.SHOT_OUT;
const THEME = process.env.SHOT_THEME || "dark";
const STUB = process.env.SHOT_STUB === "1";
const CLICK = process.env.SHOT_CLICK === "1";
const W = Number(process.env.SHOT_W || 1280);
const H = Number(process.env.SHOT_H || 820);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  nativeTheme.themeSource = THEME;
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: true,
    frame: false,
    backgroundColor: THEME === "dark" ? "#0b0c0e" : "#fafafa",
    webPreferences: {
      preload: STUB ? path.resolve(__dirname, "stub-preload.cjs") : undefined,
      contextIsolation: !STUB,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    }
  });

  await win.loadFile(TARGET);
  await wait(1800);

  if (CLICK) {
    try {
      await win.webContents.executeJavaScript(
        "(()=>{const b=document.querySelector('nav .overflow-auto button');if(b){b.click();return true;}return false;})()"
      );
    } catch (e) {
      /* ignore */
    }
    await wait(1400);
  }

  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  // eslint-disable-next-line no-console
  console.log("wrote", OUT);
  app.quit();
});
