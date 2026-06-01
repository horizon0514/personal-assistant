/**
 * 本地 JSON 持久化助手。与 ctx-memory 风格一致:同步读写、目录惰性创建。
 * 量大再考虑 SQLite;当前数据小、需可见可删,JSON 足够。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** 写纯文本(目录惰性创建)。用于落盘可读文本工件,如执行轨迹。 */
export function writeText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
