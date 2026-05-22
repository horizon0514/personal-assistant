# @pa/ctx-reversibility

Reversibility —— 操作日志/软删除/回滚/diff 预览(核心域)

已实现:`OperationJournal`(追加式)+ 按 capability 注册 reverser(filesystem 已注册)+ `undoLast`;接 afterTool 记账,UI step 行内联「撤销」。职责与模型见 [`research/domain-model.md`](../../research/domain-model.md)。
