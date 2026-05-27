/**
 * @pa/ctx-task — ask_user 工具(执行中向用户拍板)
 *
 * 执行器遇到需要用户决策才能继续的岔路(多个可行方案、覆盖还是另存、缺关键信息)时调它:
 * 提问 + 可选项,工具内 await 用户回答 —— 在用户回应前暂停整个 agent 循环。
 * 因暂停发生在工具执行内,prompt() 不会提前返回,故验收(evaluator)天然不会误判「任务已完成」。
 * pi 概念只在 ctx-task 内出现。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const askParams = Type.Object({
  question: Type.String({ description: "要问用户的问题,简洁明确" }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "供用户一键选择的选项(可选);能枚举出清晰选项时尽量给,否则留空让用户自由作答"
    })
  )
});

export interface AskUserToolDeps {
  /** 向用户提问并等待回答;返回用户的回答文本(自由输入或所选项)。 */
  ask: (question: string, options: string[]) => Promise<string>;
}

/** 创建 ask_user 工具。提问 UI / 回答通道由组合根经 deps 注入。 */
export function createAskUserTool(deps: AskUserToolDeps): AgentTool<typeof askParams> {
  return {
    name: "ask_user",
    label: "询问用户",
    description:
      "需要用户拍板才能继续时(如有多个可行方案、覆盖还是另存为新版、缺少关键信息)用它提问并等待回答;问完会暂停直到用户回应,不要替用户擅自决定。能枚举出清晰选项时填 options 让用户一键选。",
    parameters: askParams,
    execute: async (_id, { question, options }) => {
      const answer = await deps.ask(question, options ?? []);
      return { content: [{ type: "text", text: `用户回答:${answer}` }], details: { question, answer } };
    }
  };
}
