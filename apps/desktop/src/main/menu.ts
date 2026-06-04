/** 应用菜单:macOS 原生范式 —— app 菜单含「设置… ⌘,」,并保留标准 编辑/视图/窗口 角色。 */
import { app, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

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

/**
 * 原生右键菜单:Electron 默认右键什么都不弹(露馅:原生应用都有)。
 * 可编辑处给 剪切/复制/粘贴/全选 + 拼写建议;有选中文字给 复制;否则不弹。
 * 用内置 role,自动带平台快捷键与本地化、自动按可用性灰显。
 */
export function installContextMenu(wc: WebContents): void {
  wc.on("context-menu", (_e, params) => {
    const items: MenuItemConstructorOptions[] = [];

    // 拼写纠正候选(仅可编辑处、且系统给了候选时)置顶
    for (const s of params.dictionarySuggestions) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    }
    if (params.dictionarySuggestions.length > 0) items.push({ type: "separator" });

    if (params.isEditable) {
      items.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" }
      );
    } else if (params.selectionText.trim().length > 0) {
      items.push({ role: "copy" });
    }

    if (items.length === 0) return; // 空白处不弹,免假菜单
    Menu.buildFromTemplate(items).popup();
  });
}
