# tracks/skill

当前唯一实施线。CLI 挂了 `noop`（证明壳能挂载）、`task`（录入、列出、查看、校验，从已合 PR 只读导入任务卡，并确认插手 / 返工）和 `replay`（Cursor Agent 从 base commit 起跑 with-skill / without）。

包名 `@agent-eval/skill`，入口导出 `skillTrack`。可以依赖 `packages/core`。不要 import `tracks/agent` 或 `tracks/model`。

本波不做 verify 判分、指标或对比。导入不写 Origin，也不写 GitHub。插手 / 返工的确认在 `task mark`，口径见 `docs/marks.md`。重放见 `docs/replay.md`。
