/**
 * @pa/ctx-task — Sprint Contract 工具(动手前的交付约定)
 *
 * 执行器对多步/有交付物的开放任务,动手前调 propose_contract 起草「交付什么 + 怎样算合格」,
 * 经用户内联确认/微调后锁定;确认后的契约既约束执行器,又作为评估器(evaluator)的验收清单。
 * 详见 research/agent-design-insights.md §4。pi 概念只在 ctx-task 内出现。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { SprintContract } from "@pa/domain-core";

const contractParams = Type.Object({
  deliverables: Type.Array(Type.String(), {
    description: "你打算交付什么 —— 具体到文件路径/产出形态,逐条列出"
  }),
  criteria: Type.Array(Type.String(), {
    description: "怎样算合格 —— 逐条、可核查的验收标准(避免'做得好'这类不可验的话)"
  })
});

export interface ContractToolDeps {
  /** 向用户征求确认;返回确认(可能被用户改过)的契约,用户取消/未确认返回 null */
  confirm: (proposed: SprintContract) => Promise<SprintContract | null>;
  /** 用户确认后回调(供组合根存下,供评估器取用) */
  onConfirmed: (contract: SprintContract) => void;
}

/** 创建 propose_contract 工具。确认 UI / 存储由组合根经 deps 注入。 */
export function createContractTool(deps: ContractToolDeps): AgentTool<typeof contractParams> {
  return {
    name: "propose_contract",
    label: "提交交付契约",
    description:
      "对于多步、要产出交付物的开放任务(如调研出报告、整理出表格),动手前用它提交你打算交付什么 + 怎样算合格,等用户确认后再开干。琐碎/只读/一两步任务无需调用。",
    parameters: contractParams,
    execute: async (_id, { deliverables, criteria }) => {
      const confirmed = await deps.confirm({ deliverables, criteria });
      if (!confirmed) {
        return {
          content: [
            {
              type: "text",
              text: "用户暂未确认契约。先与用户澄清想要的交付物与验收标准,再继续,不要擅自开干。"
            }
          ],
          details: { confirmed: false }
        };
      }
      deps.onConfirmed(confirmed);
      const text = `契约已确认,请严格按此交付:
交付物:
${confirmed.deliverables.map((d) => `- ${d}`).join("\n")}
验收标准:
${confirmed.criteria.map((c) => `- ${c}`).join("\n")}`;
      return { content: [{ type: "text", text }], details: { confirmed: true, contract: confirmed } };
    }
  };
}
