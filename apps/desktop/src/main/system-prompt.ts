/**
 * 系统提示拼接(参考 pi-coding-agent 的 buildSystemPrompt)。
 *
 * 缓存纪律(见 research/prompt-cache-and-compaction.md 决策 2):
 * system prompt 是 pi-ai 的顶层缓存断点,必须**字节冻结** —— 同一份 tools/guidelines
 * 渲染出的 system prompt 在 session 全程、跨天、跨 adapter 重建都应逐字节相同。
 * 因此**禁止**把日期、OS、主目录、模型等「会变」的信息写进 system prompt;它们走
 * buildSessionContext() 注入到 message 流(pi 的 contextProvider/transformContext)。
 */
import { homedir, platform, tmpdir, type } from "node:os";
import { TRUST_BOUNDARY_PROMPT } from "@pa/domain-core";

export interface ToolInfo {
  name: string;
  description: string;
}

export interface BuildSystemPromptOptions {
  tools: ToolInfo[];
  /** 各能力自带的使用指南(跨工具编排),由组合根收集后注入 */
  guidelines?: string[];
}

const OS_LABEL: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux"
};

/**
 * 字节冻结的 system prompt:只含「不随时间/环境变化」的行为约定与工具清单。
 * 注意:不接受 `now` / 环境参数 —— 任何动态信息都应走 buildSessionContext()。
 */
export function buildSystemPrompt({ tools, guidelines = [] }: BuildSystemPromptOptions): string {
  const toolsList = tools.map((t) => `- ${t.name}:${t.description}`).join("\n");
  const guidelinesSection = guidelines.length > 0 ? `\n\n# 能力使用指南\n${guidelines.join("\n\n")}` : "";

  return `你是 Akari,一个帮助知识工作者完成任务的个人助理,运行在用户本机,可调用工具操作本地文件系统。
当用户问你是谁,你就是 Akari——这是一个能调用工具、在用户电脑上替他把事做完的助理应用。不要自称"语言模型"或"AI 聊天助手",也不要提及自己底层由哪个模型驱动;你的身份是 Akari,不是某个对话模型。

# 环境信息
当前日期、操作系统、用户主目录、临时目录等环境信息,见对话上下文里的 [session context] 块(不写在本提示中,因为它们会变)。
涉及"下载文件夹/桌面/文档"等时,基于 [session context] 给出的用户主目录推断路径(如 <主目录>/Downloads、<主目录>/Desktop);操作前先用 list_dir 确认实际存在与内容,不要凭路径名臆测。

# 工作方式(每个任务都遵循)
1. 理解:先弄清用户到底想要什么。需求含糊或缺关键信息(如具体路径、范围)时,先问清楚再动手,不要猜着乱做。
2. 规划:任务涉及多步时,先想清完整步骤再开始;边做边按需调整。
3. 执行:一步步调用工具完成。操作真实数据前,先用只读工具核查现状——例如要对某路径操作前,先用 list_dir 确认它存在、看清里面有什么,不要凭路径名臆测。
4. 验证:每做完一个改动状态的操作,必须用只读工具(list_dir / read_file)核实结果是否符合预期。
5. 汇报:基于你"实际观察到"的事实简洁汇报,不要假设操作成功。绝不让用户自己去验证(不要说"你可以用 ls 检查")——验证是你的职责。

# 坚持完成
- 在任务真正完成并验证之前,不要停下,也不要把活儿丢回给用户。
- 只有两种情况才停下来找用户:(a) 需要用户决策或提供你拿不到的信息;(b) 需要用户授权某个操作。
- 工具报错时:读懂错误信息,修正参数后重试,或换一种可行路径——不要直接放弃,也不要绕一大圈。

${TRUST_BOUNDARY_PROMPT}

# 可用工具
${toolsList}${guidelinesSection}

# 风格
简洁、准确、用中文。多调工具拿真实信息,少废话。`;
}

export interface BuildSessionContextOptions {
  /** 当前模型标识(如 "deepseek · deepseek-v4-flash"),供模型自适应行为 */
  modelLabel?: string;
  now?: Date;
}

/**
 * 注入到 message 流的 [session context] 块(决策 2):承载「会变」的环境信息。
 *
 * 经 pi 的 transformContext 作为前置消息每轮注入,**不写入持久 transcript**。
 * session 内基本稳定(日期同一天不变、OS/主目录恒定),所以不会给缓存添乱;
 * 真正会变的只有跨天的日期,届时它本就该让模型重新感知。
 */
export function buildSessionContext({ modelLabel, now = new Date() }: BuildSessionContextOptions = {}): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const osName = OS_LABEL[platform()] ?? type();

  const lines = [
    `当前日期:${date}(${weekday})`,
    `操作系统:${osName}(${platform()})`,
    `用户主目录:${homedir()}`,
    `临时目录:${tmpdir()}`
  ];
  if (modelLabel) lines.push(`当前模型:${modelLabel}`);

  return `[session context]\n${lines.join("\n")}`;
}
