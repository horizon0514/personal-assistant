# @pa/ctx-trust

Trust & Governance —— 风险分级/审批/权限/注入隔离。挂 pi beforeToolCall 的守门人(核心域)

已实现:`createGatekeeper`(风险分级 → 策略 → 只读自动放行 / 需审批异步等待 / 拒绝拦截),挂 pi 的 beforeToolCall。注入隔离原语(markUntrusted/detectInjection/信任边界条款)在 `domain-core`。职责与模型见 [`research/domain-model.md`](../../research/domain-model.md)。
