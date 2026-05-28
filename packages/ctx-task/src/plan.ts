/**
 * @pa/ctx-task — Work Plan 工具(动手前的开工对齐)
 *
 * 执行器对多步/有交付物的开放任务,动手前调 propose_plan 起草「交付什么 + 怎样算合格」,
 * 经用户内联确认/微调后锁定;确认后的计划既约束执行器,又作为评估器(evaluator)的验收清单。
 * 详见 research/agent-design-insights.md §4。pi 概念只在 ctx-task 内出现。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { WorkPlan } from "@pa/domain-core";

const planParams = Type.Object({
  deliverables: Type.Array(Type.String(), {
    description: "你打算交付什么 —— 文件?文档?还是聊天里直接答?以用户原话为准,逐条列出"
  }),
  criteria: Type.Array(Type.String(), {
    description: "怎样算合格 —— 逐条、可核查的验收标准(避免'做得好'这类不可验的话)"
  })
});

/**
 * 用户对开工对齐卡的回应:
 * - confirm:就这么干 → 锁定计划,继续
 * - feedback:不对,调一下 → 用户给出自然语言反馈,模型应基于反馈重新 propose_plan
 * - cancel:取消 → 先澄清需求,不开干
 */
export type PlanConfirmation =
  | { kind: "confirm"; plan: WorkPlan }
  | { kind: "feedback"; text: string }
  | { kind: "cancel" };

export interface PlanToolDeps {
  /** 向用户征求确认;返回用户的回应(确认/反馈/取消) */
  confirm: (proposed: WorkPlan) => Promise<PlanConfirmation>;
  /** 用户确认后回调(供组合根存下,供评估器取用) */
  onConfirmed: (plan: WorkPlan) => void;
}

/** 创建 propose_plan 工具。确认 UI / 存储由组合根经 deps 注入。 */
export function createPlanTool(deps: PlanToolDeps): AgentTool<typeof planParams> {
  return {
    name: "propose_plan",
    label: "提交开工计划",
    description:
      "对多步、要产出交付物的开放任务(如调研出报告、整理出表格),动手前用它跟用户对齐「交付什么 + 怎样算合格」,等用户确认后再开干。琐碎/只读/一两步任务无需调用。",
    parameters: planParams,
    execute: async (_id, { deliverables, criteria }) => {
      const result = await deps.confirm({ deliverables, criteria });
      if (result.kind === "cancel") {
        return {
          content: [
            {
              type: "text",
              text: "用户取消了开工对齐。先与用户澄清需求再继续,不要擅自开干。"
            }
          ],
          details: { confirmed: false }
        };
      }
      if (result.kind === "feedback") {
        return {
          content: [
            {
              type: "text",
              text: `用户希望调整这次的开工计划,反馈如下:

${result.text}

请基于反馈重新调用 propose_plan 起草新版本,不要直接动手。`
            }
          ],
          details: { confirmed: false, feedback: result.text }
        };
      }
      deps.onConfirmed(result.plan);
      const text = `计划已确认,请严格按此交付:
交付物:
${result.plan.deliverables.map((d) => `- ${d}`).join("\n")}
验收标准:
${result.plan.criteria.map((c) => `- ${c}`).join("\n")}`;
      return { content: [{ type: "text", text }], details: { confirmed: true, plan: result.plan } };
    }
  };
}
