/**
 * 模型 API Key 的安全存储(BYO key)。
 * 用 Electron safeStorage 以系统加密原语(macOS Keychain / Windows DPAPI)加密,
 * 密文 base64 后落盘到 userData/secrets.json。零额外依赖、跨平台一致。
 *
 * key 是账号级凭证,全局单份(不按 workspace 隔离),按 provider 索引。
 */
import { app, safeStorage } from "electron";
import { join } from "node:path";
import { readJson, writeJson } from "@pa/infra";

type Secrets = Record<string, string>; // provider → "enc:..."(加密) | "raw:..."(兜底明文)

function file(): string {
  return join(app.getPath("userData"), "secrets.json");
}

function encode(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return "enc:" + safeStorage.encryptString(key).toString("base64");
  }
  // 加密不可用(罕见,如 Linux 无 keyring):退而 base64 明文,避免直接裸存。
  return "raw:" + Buffer.from(key, "utf8").toString("base64");
}

function decode(v: string): string {
  if (v.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(v.slice(4), "base64"));
  if (v.startsWith("raw:")) return Buffer.from(v.slice(4), "base64").toString("utf8");
  return v;
}

export const keyStore = {
  set(provider: string, key: string): void {
    const secrets = readJson<Secrets>(file(), {});
    secrets[provider] = encode(key);
    writeJson(file(), secrets);
  },
  get(provider: string): string | undefined {
    const v = readJson<Secrets>(file(), {})[provider];
    try {
      return v ? decode(v) : undefined;
    } catch {
      return undefined; // 解密失败(如换机器)→ 当作未设置
    }
  },
  clear(provider: string): void {
    const secrets = readJson<Secrets>(file(), {});
    delete secrets[provider];
    writeJson(file(), secrets);
  },
  /** 状态视图:是否已设置 + 末 4 位(不回传完整 key 到渲染层)。 */
  status(provider: string): { set: boolean; last4?: string } {
    const key = this.get(provider);
    return key ? { set: true, last4: key.slice(-4) } : { set: false };
  }
};
