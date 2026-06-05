/**
 * 随包 Skill 播种(seed-skills)
 *
 * app 只扫 <userData>/skills(单一 SKILLS_DIR,skill-runtime 的 node_modules 符号链接也挂在此根),
 * 但我们随仓库维护的内置 Skill(如 word-redact)在 app 资源里、不在 userData 里 —— 不播种则终端用户拿不到。
 * 这里启动时把内置 Skill 拷进 userData/skills:
 * - 内置(managed)带 `.akari-managed` 标记(存内容哈希);源变了才刷新,不变零成本。升级随 app 版本自然更新。
 * - 用户自加 / 自改的(无标记)**绝不触碰**。
 * - 刷新内置时**保留其目录内的 .models**(模型权重缓存),避免每次升级重下。
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

const MARKER = ".akari-managed";
/** 拷贝 / 哈希时一律跳过:运行时依赖、模型缓存、我们自己的标记。 */
const SKIP = new Set(["node_modules", ".models", MARKER]);

/** 内置 skills 源目录:打包后在 resources/skills;dev 指 repo 根 skills/。找不到 → null(跳过播种)。 */
function bundledSkillsDir(): string | null {
  const dir = app.isPackaged
    ? join(process.resourcesPath, "skills")
    : join(app.getAppPath(), "..", "..", "skills");
  return existsSync(dir) ? dir : null;
}

/** 目录内容哈希(排除 SKIP):判断内置 skill 是否需要刷新。 */
function hashDir(dir: string): string {
  const h = createHash("sha1");
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else {
        h.update(r);
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir, "");
  return h.digest("hex").slice(0, 16);
}

/** 拷一个内置 skill 到目标,排除 node_modules/.models/marker(按 basename 任意层级)。 */
function copySkill(src: string, dst: string): void {
  cpSync(src, dst, {
    recursive: true,
    filter: (s) => !SKIP.has(s.split(/[\\/]/).pop() ?? "")
  });
}

/**
 * 把内置 Skill 播种 / 刷新到 skillsDir(= <userData>/skills)。幂等、不抛(单个失败只告警不拖垮启动)。
 * 调用时机:mkdir(SKILLS_DIR) 之后、ensureSkillRuntime / 首次 scanSkills 之前,确保播种完的脚本能被看到。
 */
export function seedBundledSkills(skillsDir: string): void {
  const src = bundledSkillsDir();
  if (!src) return;
  mkdirSync(skillsDir, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(src);
  } catch {
    return;
  }

  for (const name of entries) {
    const from = join(src, name);
    try {
      if (!statSync(from).isDirectory() || SKIP.has(name)) continue;
    } catch {
      continue;
    }
    const to = join(skillsDir, name);
    const marker = join(to, MARKER);
    const hash = hashDir(from);

    try {
      if (!existsSync(to)) {
        copySkill(from, to);
        writeFileSync(marker, hash);
        continue;
      }
      // 已存在:无标记=用户自加/自改的,绝不动;有标记=内置,哈希一致则跳过,变了才刷新。
      if (!existsSync(marker)) continue;
      if (readFileSync(marker, "utf8").trim() === hash) continue;

      // 刷新:保住 .models(权重缓存),清旧内置文件,重拷,写新哈希。
      const models = join(to, ".models");
      const stash = join(skillsDir, `.${name}.models.stash`);
      const hasModels = existsSync(models);
      if (hasModels) renameSync(models, stash);
      rmSync(to, { recursive: true, force: true });
      copySkill(from, to);
      if (hasModels) renameSync(stash, join(to, ".models"));
      writeFileSync(marker, hash);
    } catch (e) {
      console.warn(`[seed-skills] 播种/刷新 ${name} 失败: ${String(e)}`);
    }
  }
}
