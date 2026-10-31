# tracks/skill

当前唯一实施线。CLI 挂了 `noop`（证明壳能挂载）和 `task`（录入、列出、查看、校验，以及从已合 PR 只读导入任务卡）。

包名 `@agent-eval/skill`，入口导出 `skillTrack`。可以依赖 `packages/core`。不要 import `tracks/agent` 或 `tracks/model`。

本波不做插手标记、重放、verify 判分、指标或对比。导入不写 Origin，也不写 GitHub。
