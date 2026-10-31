# tasks

真实任务卡放在 `tasks/<id>/card.yaml`。字段、草稿和 replay-ready、公开/私有分离见 [docs/task-card.md](../docs/task-card.md)。

```sh
pnpm eval task add
pnpm eval task list
pnpm eval task show <id>
pnpm eval task validate [id]
```

| 目录 | 状态 | 说明 |
| --- | --- | --- |
| `e0-e2-stub-smoke` | replay-ready | 本仓已合入的 PR #1。`verify` 为 `none`，插手为 `unknown` |
| `chat-only-draft` | draft | 没有 PR / merge 的 chat-only 形状。base commit 仍是 `todo`，所以还不能重放 |
