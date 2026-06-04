/**
 * 「已记住允许」清单:用户在审批卡点「总是同意」后,该类操作(命令头+子命令)以后免审批。
 * 全局永久(跨 workspace),存 userData/approval-allowlist.json。内存缓存 + 写时落盘。
 *
 * 信任边界(见记忆 injection-defense):这是把审批口子放宽,故
 * - 只记 ask 路径的可记忆操作(shell/office 同类键),复合命令(含管道/重定向)不可记忆;
 * - 面板可查看/逐条移除/清空,不是黑箱。
 */
import { app } from "electron";
import { join } from "node:path";
import { readJson, writeJson } from "@pa/infra";
import type { RememberStore } from "@pa/ctx-trust";

export interface AllowEntry {
  /** 记忆键 id,如 "shell:git commit" */
  id: string;
  /** 展示说明,如 "git commit 命令" */
  label: string;
  /** 记住时间(epoch ms),供面板排序/展示 */
  at: number;
}

function file(): string {
  return join(app.getPath("userData"), "approval-allowlist.json");
}

let cache: AllowEntry[] | null = null;
function load(): AllowEntry[] {
  if (!cache) cache = readJson<AllowEntry[]>(file(), []);
  return cache;
}

export const approvalAllowlist = {
  has(id: string): boolean {
    return load().some((e) => e.id === id);
  },
  add(id: string, label: string): void {
    const list = load();
    if (list.some((e) => e.id === id)) return; // 已在表内,幂等
    list.push({ id, label, at: Date.now() });
    writeJson(file(), list);
  },
  list(): AllowEntry[] {
    return [...load()].sort((a, b) => b.at - a.at);
  },
  remove(id: string): void {
    cache = load().filter((e) => e.id !== id);
    writeJson(file(), cache);
  },
  clear(): void {
    cache = [];
    writeJson(file(), []);
  }
};

/** 注入给守门人的存储端口(只暴露 has/add)。 */
export const rememberStore: RememberStore = {
  has: (id) => approvalAllowlist.has(id),
  add: (id, label) => approvalAllowlist.add(id, label)
};
