# tracks/skill

当前唯一实施线。本波只注册一条 `noop` 命令，证明 CLI 壳能挂载 track。

包名 `@agent-eval/skill`，入口导出 `skillTrack`。可以依赖 `packages/core`。不要 import `tracks/agent` 或 `tracks/model`。

本波没有任务卡、导入、标记、重放、verify、指标或对比。
