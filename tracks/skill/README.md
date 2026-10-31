# tracks/skill

当前唯一实施线。CLI 挂了 `noop`（证明壳能挂载）和 `task`（录入、列出、查看、校验任务卡，并确认插手 / 返工）。

包名 `@agent-eval/skill`，入口导出 `skillTrack`。可以依赖 `packages/core`。不要 import `tracks/agent` 或 `tracks/model`。

本波不做 Origin 采集、重放、verify 判分、指标或对比。插手 / 返工的确认在 `task mark`，口径见 `docs/marks.md`。
