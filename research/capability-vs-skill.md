# Capability(cap-*)还是 Skill?—— 边界与待办

什么时候该把一个能力做成原生 `cap-*` 原语,什么时候做成 Skill(纯数据 + 可选脚本,热插拔)。

## 判定:两根轴

一个能力,**两根轴都低**才该做成 Skill:

1. **是否需要原生深度?** 内核路由的风险分级 / 接 Reversibility journal / 驱动 Electron·CDP / 它本身就是执行底座 / 安全污点标记(防注入)。
2. **是否核心高频到值得原生?** always-on、产品头部功能、guideline 进字节冻结的 system prompt。

> 不要为了范式而迁移。底座与产品核心该原生就原生;只有「技术上能用已有原语拼出来」**且**「不是产品核心」的长尾,才降成 Skill。

## 现有 cap 的判定

| cap | 原生耦合点 | 判定 |
|---|---|---|
| cap-shell | Skill 就跑在它上面;进程组 kill | **必须原生**(执行底座,降成 Skill 会循环依赖) |
| cap-browser | 组合根注入的 Electron webContents/CDP 驱动、登录态、可见光标、防注入污点 | **必须原生**(shell 脚本驱不动浏览器) |
| cap-filesystem | 接 Reversibility journal、plan_file_changes 批量审批、软删回收区 | **必须原生**(可逆是核心横切安全) |
| cap-document | liteparse(Rust napi)+ PaddleOCR(onnxruntime)流水线 | **保持原生**(产品核心、always-on、只读自动跑) |
| cap-office | OfficeCLI 二进制直通 + 按子命令分级 + 常驻清理 | **可迁 Skill**(见下,有取舍) |
| cap-webresearch | `export {}` 空占位 | **生而为 Skill**(见下) |

## 已做(2026-06):公共运行时供给

office / document / skill-runtime 三处在重复同一套「按需下载 + tmp/rename 防半成品 + 并发去重 + 版本子目录 + onProgress + 不抛降级」。已抽成 `@pa/infra` 的 `provisionOnce` + `atomicDownload`,**三处全部接入**:
- **cap-office** `ensureOfficeBinary`:`provisionOnce` + `atomicDownload`(下二进制,带 mode=0o755)。
- **skill-runtime** `ensureSkillRuntime`:`provisionOnce` 包 npm install populate。
- **cap-document** `ensureFile`(模型文件,返 boolean+warn)与 `ensureOcrRuntime`(下 tar→系统 tar 解压→打 .ready,失败抛错以配合 loadPaddleCtor 重置单例):均改用 `provisionOnce`,下载段复用 `atomicDownload`。

> cap-document 含 napi/onnxruntime,**本地无依赖跑不了它的集成测试**;本轮改动为严格行为保持的机械重构(签名/返回/抛错语义不变),需在有依赖的环境 `pnpm -r typecheck` + 跑一次真实 OCR 验证。

## 待办 B:把 cap-office 迁成 Skill(验证范式上限)

cap-office 本质是「包一个 CLI」(doc-comment 自陈「单一直通入口,把 OfficeCLI 子命令透传给模型」),是唯一真候选。迁法:

- **二进制供给**:把 skill-runtime 从「装 npm 依赖」泛化到「也能备平台二进制」,office-as-skill 经它拿到 OfficeCLI;或直接复用 `provisionOnce`+`atomicDownload` 在 skill 首次用时下。
- **风险分级 → safeShell**:`officecli view *` / `get *` / `query *` / `dump *` / `validate *` / `stats *` 声明为只读免审批;写命令(set/add/remove/merge/batch…)自然落到通用 shell 审批。
- **常驻清理**:手册让脚本改完 `close`(word-redact 已这么写)。

**取舍(为什么没有立刻做)**:迁后丢掉专用工具 schema 与「Office 文档操作」UI 标签,写操作走通用 shell 审批卡。office 是 gated、非高频,损失可接受;但收益主要是「验证范式」,优先级低于把基础设施(provision)夯实。先记录,不强迁。

## 待办 C:cap-webresearch 空壳

`packages/cap-webresearch/src/index.ts` 是 `export {}` 占位,且其设想职责(搜索 API + 抓取)与 cap-browser 的 web_search/web_fetch 重叠。
- 选项一:删掉空包,消除「有这能力」的误导。
- 选项二:真要做独立的「搜索 API 调研」,直接做成 Skill(包个搜索 API/CLI 是教科书级 Skill),不复活成 cap-*。
