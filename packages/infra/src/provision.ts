/**
 * 运行时供给(provision)——「按需就位、只做一次」的公共骨架。
 *
 * 背景:cap-office(下 OfficeCLI 二进制)、cap-document(下 OCR 运行时 + 模型)、
 * skill-runtime(装共享 npm 依赖)三处各自手写了同一套外层逻辑:
 *   keyed 缓存 + 已就绪短路 + 并发去重 + 临时态(tmp/rename 或 .ready 标记)防半成品 + 进度上报 + 不抛优雅降级。
 * 真正不同的只有「怎么 populate」(下个文件 / 解个 tar / 跑 npm install)。
 * 这里把**一模一样的外层**抽出来,各 caller 只提供 isReady() 和 populate()。
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const IS_WINDOWS = process.platform === "win32";

export interface ProvisionResult {
  readonly ok: boolean;
  /** 失败原因(ok=false 时)。 */
  readonly error?: string;
}

/** 进度回报:首次供给可能耗时(下载/安装),亮给用户。 */
export type ProgressFn = (note: string) => void;

/** 同一 key 的并发去重:多处同时触发只真正供给一次。 */
const inflight = new Map<string, Promise<ProvisionResult>>();

/**
 * 确保某资源就位,且只做一次。幂等 + 并发去重 + 不抛(失败回报 error,绝不拖垮调用方)。
 *
 * @param key       供给的唯一标识(通常用目标绝对路径)。并发去重 + inflight 按它归并。
 * @param isReady   是否已就位(如 existsSync(dest) 或 existsSync(.ready))。为真则立即返回 ok。
 * @param populate  真正干活:下载/解压/安装。**自行负责原子落地**(写 tmp 再 rename,或成功后打 .ready),
 *                  失败就抛——外层会捕获成 { ok:false, error }。第一参数是进度回报。
 * @param onProgress 进度回报。
 * @param firstRunNote 首次供给前先报一句(如「正在下载运行时…」)。
 */
export function provisionOnce(
  key: string,
  opts: {
    isReady: () => boolean;
    populate: (onProgress: ProgressFn) => Promise<void>;
    onProgress?: ProgressFn;
    firstRunNote?: string;
  }
): Promise<ProvisionResult> {
  if (opts.isReady()) return Promise.resolve({ ok: true });

  let p = inflight.get(key);
  if (!p) {
    p = (async (): Promise<ProvisionResult> => {
      const note: ProgressFn = opts.onProgress ?? (() => {});
      if (opts.firstRunNote) note(opts.firstRunNote);
      try {
        await opts.populate(note);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/**
 * 原子下载一个文件:fetch → 写 `<dest>.tmp` → rename 到 dest(半成品永不被当成可用)。
 * 供 provisionOnce 的 populate 复用——cap-office 下二进制、cap-document 下模型文件都是这个形状。
 *
 * @param mode 可选权限位(如裸可执行二进制给 0o755)。Windows 上忽略。
 */
export async function atomicDownload(url: string, dest: string, opts?: { mode?: number }): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  if (opts?.mode != null && !IS_WINDOWS) chmodSync(tmp, opts.mode);
  renameSync(tmp, dest);
}
