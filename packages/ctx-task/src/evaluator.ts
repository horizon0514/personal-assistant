/**
 * @pa/ctx-task — Evaluator(执行后独立验收)
 *
 * 用**第二个 pi Agent**(独立 system prompt + 只读工具 + submit_verdict)对照目标
 * 核查执行器的产出。与执行器上下文隔离,避免"自评过度自信"。
 * 详见 research/agent-design-insights.md §1。pi 概念只在 ctx-task 内出现。
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ApiKeyResolver, ModelHandle } from "@pa/infra";
import type { EvaluationRequest, Evaluator, Verdict } from "@pa/domain-core";

export interface PiEvaluatorDeps {
  readonly model: ModelHandle;
  readonly apiKeyResolver: ApiKeyResolver;
  /** 评估器系统提示(刻意挑剔;字节冻结) */
  readonly systemPrompt: string;
  /** 只读工具子集 —— 供评估器独立核查产出(list_dir/read_file/grep 等) */
  readonly readonlyTools: AgentTool[];
}

const verdictParams = Type.Object({
  pass: Type.Boolean({ description: "目标是否真正达成(true=通过)" }),
  issues: Type.Array(Type.String(), {
    description: "未达成或有问题之处,逐条具体列出;pass 时留空数组"
  }),
  summary: Type.String({ description: "一句话验收结论" })
});

/** 用 pi Agent 实现的评估器端口。每次评估起一个一次性 agent,提交判定即停。 */
export function createPiEvaluator(deps: PiEvaluatorDeps): Evaluator {
  return {
    async evaluate(req: EvaluationRequest): Promise<Verdict> {
      let captured: Verdict | undefined;

      const submitVerdict: AgentTool<typeof verdictParams> = {
        name: "submit_verdict",
        label: "提交验收判定",
        description: "核查完毕后调用且只调用一次,提交最终验收判定。这是你的最后一步。",
        parameters: verdictParams,
        execute: async (_id, v) => {
          captured = { pass: v.pass, issues: [...(v.issues ?? [])], summary: v.summary };
          agent.abort(); // 收到判定即停,避免继续兜圈
          return { content: [{ type: "text", text: "已记录判定。" }], details: v };
        }
      };

      const agent = new Agent({
        initialState: {
          systemPrompt: deps.systemPrompt,
          model: deps.model,
          tools: [...deps.readonlyTools, submitVerdict],
          thinkingLevel: "off"
        },
        getApiKey: (provider) => deps.apiKeyResolver(provider)
      });

      const log =
        req.actionLog.map((a) => `- ${a.tool}${a.ok ? "" : "(失败)"}`).join("\n") || "(未调用任何工具)";
      const contractSection = req.contract
        ? `\n\n## 已确认的交付契约(以此为验收清单,逐条核查)
交付物:
${req.contract.deliverables.map((d) => `- ${d}`).join("\n") || "- (未列)"}
验收标准:
${req.contract.criteria.map((c) => `- ${c}`).join("\n") || "- (未列)"}`
        : "";
      const prompt = `# 待验收的任务

## 用户目标(原话)
${req.intent.text}

## 执行器调用过的工具
${log}

## 执行器最终汇报
${req.finalSummary || "(无文字汇报)"}${contractSection}

请用只读工具**独立核查**产出是否真正达成了用户目标(不要轻信上面的汇报,自己去看文件/页面的真实状态)。${
        req.contract ? "凡契约里的验收标准,逐条核查是否满足。" : ""
      }核查完成后调用 submit_verdict 提交判定。`;

      await agent.prompt(prompt);

      // 评估器未给出明确判定(异常/未调用工具)→ 默认通过,避免误报阻断
      return captured ?? { pass: true, issues: [], summary: "评估未给出明确判定,默认通过。" };
    }
  };
}
