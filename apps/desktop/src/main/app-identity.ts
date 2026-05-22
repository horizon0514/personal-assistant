/**
 * 应用身份与数据目录 —— 必须在任何读取 userData 的模块(agent / app-settings /
 * key-store …)之前执行,因此本模块要作为 main 的「第一个」import 引入。
 *
 * 背景:打进包的 package.json 里 name 是 "@pa/desktop" 且无 productName,
 * electron 默认会用它作为 app 名与 userData 目录名,导致开发态与正式版
 * 共用 `Application Support/@pa/desktop`,对话记录与记忆互相串。
 *
 * 处理:
 *  - 统一把 app 名设为 "Akari"(影响菜单、关于、userData 目录)。
 *  - 开发态(!isPackaged)改用独立目录 "Akari (dev)",与正式版数据隔离。
 */
import { join } from "node:path";
import { app } from "electron";

app.setName("Akari");

if (!app.isPackaged) {
  app.setPath("userData", join(app.getPath("appData"), "Akari (dev)"));
}
