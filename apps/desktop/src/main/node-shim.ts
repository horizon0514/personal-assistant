/**
 * node shim:在 <userData>/bin 写一个 `node` 可执行,指向 Electron 自带的 Node(ELECTRON_RUN_AS_NODE)。
 *
 * 为什么:脚本 Skill(如 word-redact 的 detect.mjs)通过 exec_shell 跑 `node x.mjs`。但打包版用户
 * 多半没装 node,且 GUI 启动的 app PATH 通常也不含 nvm/homebrew 的 node → `node` 找不到。
 * Electron 二进制本身就是个 Node(置 ELECTRON_RUN_AS_NODE=1 即以纯 Node 模式运行任意 .mjs/.js)。
 * 把这个 shim 目录前置进 exec_shell 的 PATH(见 cap-shell extraPath),`node x.mjs` 就用 app 自带 Node 跑。
 *
 * 幂等:每次启动重写(execPath 随安装/升级可能变,重写最省心)。dev 也无害(只是多一个能用的 node)。
 */
import { app } from "electron";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** 写好 node shim,返回其所在 bin 目录(交给 cap-shell 前置进 PATH)。 */
export function ensureNodeShim(): string {
  const binDir = join(app.getPath("userData"), "bin");
  mkdirSync(binDir, { recursive: true });
  const exec = process.execPath;

  if (IS_WINDOWS) {
    // cmd 下 `node` 经 PATHEXT 解析到 node.cmd。
    writeFileSync(join(binDir, "node.cmd"), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" %*\r\n`);
  } else {
    const f = join(binDir, "node");
    writeFileSync(f, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exec}" "$@"\n`);
    chmodSync(f, 0o755);
  }
  return binDir;
}
