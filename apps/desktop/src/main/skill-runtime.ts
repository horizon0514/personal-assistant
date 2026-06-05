/**
 * Skill 共享运行时(skill-runtime)
 *
 * 背景:Skill 是「纯数据 + 可选脚本」的长尾能力层。带脚本的 Skill(如 word-redact 的本地 NER 检测)
 * 需要 node 依赖(transformers.js / onnxruntime)。与其让每个 Skill 各自打包、或升格成 cap-* 原语,
 * 不如**由 app 提供一个所有脚本 Skill 共用的运行时**:一次装好,人人白嫖,新增脚本 Skill 不碰核心。
 *
 * 机制(实测定型):
 * - ESM 的 `import` **不认 NODE_PATH**,但会沿脚本所在目录树**向上找 node_modules**。
 *   故只需在 skills 根挂一个符号链接 `<skillsDir>/node_modules -> <runtime>/node_modules`,
 *   `<skillsDir>/<任意skill>/x.mjs` 里的 `import "@huggingface/transformers"` 即可解析。一个链接覆盖全部。
 * - 依赖按需就位:首个脚本 Skill 存在时才装(写 package.json + `npm install`),装好打 `.ready` 标记;
 *   之后零成本。沿用 cap-office/cap-document「按需、版本子目录、临时态不被误用」的取舍。
 * - 依赖集变化 → 目录名(内容哈希)变 → 自动走新目录重装,旧的不被误用。
 *
 * 取舍/后续:此版用运行时 `npm install` 就位(dev 直接可用;打包后若机器无 npm 会失败并优雅降级)。
 * 与 ocr-runtime 一致的进一步优化是改为从本 app 版本的 Release 下预构建 tar 包(含各平台原生 onnxruntime),
 * 那需 release workflow 产出对应附件;此处先留 npm 路径,接口不变。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionOnce } from "@pa/infra";

const IS_WINDOWS = process.platform === "win32";

/** 共享运行时里预置的依赖集(脚本 Skill 常用库)。新增带依赖的脚本 Skill 时,在此加一行即可,多数还共用。 */
export const SKILL_RUNTIME_DEPS: Readonly<Record<string, string>> = {
  "@huggingface/transformers": "4.2.0" // 本地 NER / 嵌入等:onnxruntime 在 node 内跑,纯本地
};

/** 依赖集的短哈希 → 运行时目录名:依赖一变即换目录重装,旧目录天然失效。 */
function depsHash(): string {
  return createHash("sha1").update(JSON.stringify(SKILL_RUNTIME_DEPS)).digest("hex").slice(0, 12);
}

/** 某个 skill 目录是否带脚本(.mjs/.js/.cjs)——据此判断「是否需要运行时」,不带脚本的纯 CLI-wrapper Skill 不触发安装。 */
function hasScript(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => /\.(mjs|cjs|js)$/i.test(f));
  } catch {
    return false;
  }
}

/** skills 根下是否存在任何带脚本的 Skill。无 → 无需运行时(直接跳过,不浪费一次几百 MB 安装)。 */
export function anySkillNeedsRuntime(skillsDir: string): boolean {
  try {
    return readdirSync(skillsDir).some((entry) => {
      const sub = join(skillsDir, entry);
      try {
        return lstatSync(sub).isDirectory() && hasScript(sub);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** 在 skills 根挂(或修正)指向运行时 node_modules 的符号链接,让所有 skill 脚本的 import 都能解析到。 */
function linkSkillsNodeModules(skillsDir: string, modulesDir: string): void {
  const link = join(skillsDir, "node_modules");
  try {
    if (existsSync(link) || lstatSync(link)) {
      // 已是指向同一目标的符号链接 → 不动;否则(陈旧链接/残留)清掉重建。
      try {
        if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === modulesDir) return;
      } catch {
        /* 读链接失败 → 当作陈旧,下面清掉 */
      }
      rmSync(link, { recursive: true, force: true });
    }
  } catch {
    /* link 不存在 → 直接建 */
  }
  symlinkSync(modulesDir, link, IS_WINDOWS ? "junction" : "dir");
}

/** 跑 `npm install` 把依赖装进运行时目录;成功 resolve,失败带错误信息 resolve(绝不抛)。 */
function npmInstall(cwd: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd,
      shell: true, // 跨平台找到 npm / npm.cmd
      env: { ...process.env }
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      if (stderr.length < 8_000) stderr += c;
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) =>
      code === 0 ? resolve({ ok: true }) : resolve({ ok: false, error: stderr.trim() || `npm 退出码 ${code}` })
    );
  });
}

export interface EnsureResult {
  readonly ok: boolean;
  /** 就绪时:运行时的 node_modules 绝对路径。 */
  readonly modulesDir?: string;
  readonly error?: string;
  /** 本次因「没有脚本 Skill」而跳过(非错误)。 */
  readonly skipped?: boolean;
}

/**
 * 确保 Skill 共享运行时就位,并在 skills 根挂好 node_modules 符号链接。
 * 幂等 + 并发去重 + 优雅降级:没有脚本 Skill 直接跳过;npm 缺失/装失败只回报,不抛、不拖垮启动。
 * 「按需 + 去重 + 防半成品 + 进度」的外层走公共 provisionOnce;本函数只管 populate(装依赖)与挂链接。
 *
 * @param runtimeRoot 运行时缓存根(如 <userData>/skill-runtime),内部按依赖哈希分子目录。
 * @param skillsDir   Skill 根目录(如 <userData>/skills)。
 * @param onProgress  进度回报(首次安装耗时,亮给用户)。
 */
export async function ensureSkillRuntime(opts: {
  runtimeRoot: string;
  skillsDir: string;
  onProgress?: (note: string) => void;
}): Promise<EnsureResult> {
  const { runtimeRoot, skillsDir, onProgress } = opts;
  if (!anySkillNeedsRuntime(skillsDir)) return { ok: true, skipped: true };

  const dir = join(runtimeRoot, depsHash());
  const modulesDir = join(dir, "node_modules");
  const ready = join(dir, ".ready");

  const r = await provisionOnce(dir, {
    isReady: () => existsSync(ready),
    firstRunNote: "首次使用脚本 Skill:正在准备本地运行时(下载依赖,约几十 MB,仅此一次)…",
    onProgress,
    populate: async (note) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify(
          { name: "akari-skill-runtime", private: true, type: "module", dependencies: SKILL_RUNTIME_DEPS },
          null,
          2
        )
      );
      const inst = await npmInstall(dir);
      if (!inst.ok) throw new Error(inst.error ?? "npm install 失败");
      writeFileSync(ready, ""); // 装成功才打标记:半成品目录(无 .ready)下次会重装,不被误用
      note("本地运行时已就绪。");
    }
  });
  if (!r.ok) return { ok: false, error: r.error };

  // 就绪(无论本次新装还是早已装好):确保 skills 根的 node_modules 符号链接在位。
  try {
    linkSkillsNodeModules(skillsDir, modulesDir);
  } catch (e) {
    return { ok: false, error: `链接 node_modules 失败: ${String(e)}` };
  }
  return { ok: true, modulesDir };
}
