# tracks/skill

当前唯一实施线。CLI 挂了 `noop`（证明壳能挂载）、`task`（录入、列出、查看、校验，从已合 PR 只读导入任务卡，并确认插手 / 返工）、`replay`（Cursor Agent 从 base commit 起跑 with-skill / without）、`verify`（钉死版本的可选判分；没有 verify 时 `score=unavailable`）、`metrics`（每个 variant 一份指标；没有 verify 时证据完整度是 N/A）和 `compare`（同一批任务的 with / without 差值；verify 列可以是 unavailable）。

包名 `@agent-eval/skill`，入口导出 `skillTrack`。可以依赖 `packages/core`。不要 import `tracks/agent` 或 `tracks/model`。

导入不写 Origin，也不写 GitHub。插手 / 返工的确认在 `task mark`，口径见 `docs/marks.md`。重放见 `docs/replay.md`。可选 verify 判分见 `docs/verify.md`。重放之后的指标见 `docs/metrics.md`。用 / 不用 skill 的对比见 `docs/compare.md`。
