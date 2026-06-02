/**
 * @pa/ctx-skill — Skill 热插拔层
 *
 * 分层原则:Tool 原语保持「少而精」(深度原生集成:fs/browser/memory/shell);
 * 长尾能力(包个 CLI、跑个脚本)一律做成 Skill —— 纯数据(SKILL.md + 可选脚本),
 * 不编译、不打包,丢进 skills 目录即生效。
 *
 * 运行链路:
 *   扫描 skills 目录下每个子目录的 SKILL.md → 摘要注入上下文(每轮重扫=热加载)
 *   → 模型 use_skill(name) 读取操作手册 → 照手册用 exec_shell 等已有工具执行
 *
 * 只有一个通用原语 use_skill;新增 skill 不加任何工具、不碰 agent.ts。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/** 一个已发现的 skill(目录 + 解析出的 frontmatter + 正文操作手册)。 */
export interface Skill {
  /** skill 名(frontmatter.name,缺省用目录名)——use_skill 的入参、提示里的标识 */
  readonly name: string;
  /** 一句话用途(frontmatter.description)——注入上下文供模型判断相关性 */
  readonly description: string;
  /** 操作手册正文(frontmatter 之后的全部内容) */
  readonly body: string;
  /** skill 目录绝对路径(脚本相对它定位) */
  readonly dir: string;
  /**
   * 本 skill 声明「已知安全(只读、无副作用)」的 shell 命令模式(glob,`*` 通配)。
   * 内核不认识各 skill 带的 CLI,命中这些模式的 exec_shell 命令自动跑、不弹审批;
   * 未声明的(发消息/创建/删除/登录等)仍走审批。在 frontmatter 里写成 YAML 列表。
   */
  readonly safeShell: string[];
}

/** 解析 SKILL.md frontmatter:支持单行 `key: value` 与列表块(`key:` 后续缩进 `- item` 行,如 safeShell)。 */
function parseSkill(raw: string, dirName: string, dir: string): Skill {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let body = raw;
  if (m && m[1] !== undefined && m[2] !== undefined) {
    let current: string[] | undefined; // 正在累积的列表(遇到非 `- ` 行即结束)
    for (const line of m[1].split(/\r?\n/)) {
      const listItem = line.match(/^\s+-\s+(.*)$/);
      if (current && listItem) {
        current.push((listItem[1] ?? "").trim().replace(/^['"]|['"]$/g, "")); // 去掉可选引号
        continue;
      }
      current = undefined;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      if (val === "") {
        current = lists[key] = []; // 值为空 → 列表块起头,后续 `- item` 行累积进来
      } else {
        meta[key] = val;
      }
    }
    body = m[2];
  }
  return {
    name: meta.name || dirName,
    description: meta.description || "",
    body: body.trim(),
    dir,
    safeShell: lists.safeShell ?? []
  };
}

/**
 * 扫描 skills 根目录下每个子目录的 SKILL.md。每次调用都读盘 —— 这就是热加载:
 * 新建/修改 skill 后,下一次扫描即生效,无需重启。坏目录静默跳过,不拖垮整体。
 */
export function scanSkills(rootDir: string): Skill[] {
  if (!existsSync(rootDir)) return [];
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const sub = join(rootDir, entry);
    const md = join(sub, "SKILL.md");
    try {
      if (!statSync(sub).isDirectory() || !existsSync(md)) continue;
      out.push(parseSkill(readFileSync(md, "utf8"), entry, sub));
    } catch {
      /* 单个 skill 读失败不影响其他 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 渲染注入上下文的「可用 Skill」清单(渐进披露:只给一句话摘要,正文按需 use_skill 取)。
 * 传 skillsDir 时,附上"如何自己创建 Skill"的说明——能力靠 Skill 热生长,模型该知道这条路。
 */
export function renderSkillsForContext(skills: Skill[], skillsDir?: string): string {
  if (skills.length === 0 && !skillsDir) return ""; // 既无 skill 又不讲创建 → 不污染上下文
  const head = "# 可用 Skill(热插拔能力)";
  const intro =
    "除内置工具外,你还有下列按需加载的 Skill。看到与当前任务相关的,先用 use_skill 读取它的操作手册,再照手册用已有工具(多为 exec_shell)执行;不相关就忽略。";
  const lines = skills.length
    ? skills.map((s) => `- **${s.name}**:${s.description}`).join("\n")
    : "(当前没有已安装的 Skill)";
  // 如何自己造 Skill:这是真能力,不是做不到的事。目录每条消息都会重扫(热加载)。
  const authoring = skillsDir
    ? `\n\n## 你可以自己创建 Skill(沉淀可复用的操作流程)
当某套操作(尤其包某个 CLI、固定步骤)以后还会用到,就把它沉淀成一个 Skill:用 write_file 写 \`${skillsDir}/<英文短名>/SKILL.md\`,带 frontmatter(\`name\`、\`description\`;可选 \`safeShell:\` 列表声明该 CLI 的只读命令好让它们免审批)。
这个目录**每条消息都会被重新扫描**(热加载):写好后**下一条消息**它就出现在上面的清单里;当轮想立刻用,直接 \`use_skill(那个名字)\` 也能按名读盘加载——把操作流程沉淀成 Skill 是一条随时可用的真实路径。`
    : "";
  return `${head}\n${intro}\n${lines}${authoring}`;
}

export interface UseSkillDeps {
  /** 返回当前可用 skill 列表。传 `() => scanSkills(dir)` 即每次调用都热读盘。 */
  list: () => Skill[];
}

const useSkillParams = Type.Object({
  name: Type.String({ description: "要加载的 skill 名(见上下文『可用 Skill』清单中的名字)" })
});

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

/**
 * 创建唯一的 skill 原语 use_skill:按名返回该 skill 的操作手册正文,载入上下文。
 * 模型据此再用 exec_shell 等工具执行。读取性质 → ReadOnly,不走审批。
 */
export function createUseSkillTool(deps: UseSkillDeps): AgentTool<typeof useSkillParams> {
  return {
    name: "use_skill",
    label: "加载 Skill",
    description:
      "按名加载一个 Skill 的操作手册(返回其完整说明)。当上下文『可用 Skill』里有与当前任务相关的条目时调用它,拿到手册后照着用已有工具执行。",
    parameters: useSkillParams,
    execute: async (_id, { name }): Promise<AgentToolResult<unknown>> => {
      const skills = deps.list();
      const hit = skills.find((s) => s.name === name);
      if (!hit) {
        const available = skills.map((s) => s.name).join("、") || "(当前没有已安装的 Skill)";
        return textResult(`未找到 Skill「${name}」。可用:${available}`, { found: false, name });
      }
      const header = `已加载 Skill「${hit.name}」。手册如下(skill 目录:${hit.dir}),照此执行:`;
      return textResult(`${header}\n\n${hit.body}`, { found: true, name: hit.name, dir: hit.dir });
    }
  };
}
