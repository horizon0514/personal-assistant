/** 应用菜单:macOS 原生范式 —— app 菜单含「设置… ⌘,」,并保留标准 编辑/视图/窗口 角色。 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";

export function installAppMenu(openSettings: () => void, checkForUpdates: () => void): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { label: "检查更新…", click: checkForUpdates },
              { label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const }
            ]
          }
        ]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    // 非 mac:把「设置」挂到一个独立菜单,保留 ⌘, 习惯
    ...(!isMac
      ? [
          {
            label: "文件",
            submenu: [
              { label: "检查更新…", click: checkForUpdates },
              { label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings },
              { type: "separator" as const },
              { role: "quit" as const }
            ]
          } as MenuItemConstructorOptions
        ]
      : [])
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
