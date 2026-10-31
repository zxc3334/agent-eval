# 插手和返工

`task mark` 把聊天导出、PR 评审，或卡上已有的候选，标成确认过的事件。计数定义在 `packages/core/src/marks.ts`。历史基线仍用这套函数。重放事件流上的插手列和返工轮见 [metrics.md](metrics.md)，不把 request 再加进 actual。

## 单位

| 名字 | 含义 | 代码 |
| --- | --- | --- |
| intervention（插手） | 一次经确认的人工介入 | `MARK_UNITS.intervention` |
| rework round（返工轮） | 一组相关修改，直到下一次提交或验证边界 | `MARK_UNITS.rework_round` |

没有 verify 时，「验证」可以是人工确认（`human-confirm`）或之后的一次跑（`later-run`）。边界还可以是 `submit` 或 `verify`。本票不要求卡上有 verify。

同一来源里，一次确认里连续标成返工的行合成一轮。带 `boundary` 的那一行结束本轮，下一行另起一轮。直接 `--note` 默认单独成一轮；`--round <id>` 并进已有的一轮。

## unknown ≠ 0

没有导入历史、只有未确认候选、或状态是 `unknown` / `todo` / `unavailable` / `N/A` 时，基线是 `unknown`，不是 0。

`sharedBaseline()` 只在 `status: none`（有人确认过这次没有）时返回数字 `0`。显示仍写 `none`，不写 `0`，也不写 `count`。

R3 的 `fixup` / `review` 候选放在 `private.candidates`。`suggested` 只是提示，不算确认。被 `task mark` 勾选之后才进入 `private.interventions.records` 或 `private.rework.records`，这时才计入基线。

## 去重

键是 `dedupeKey(source, turn)`，也就是 source 加 turn/stable id。同一导出再读一次不会多出一条。直接追加的稳定 id 来自类型和 note，同一句再执行一次是 no-op。

## provenance

确认过的记录和候选都带：

- `source`、`turn`：去重键的两半
- `provenance.kind`：`pr`、`issue`、`chat`、`file`
- `provenance.ref`：导出路径或 URL
- `origin`：`fixup`、`review`、`chat`、`pr-review`、`manual`

`resolveProvenance(record)` 把这些收成 R8 用的一条：`dedupe_key`、`source`、`turn`、`kind`、`ref`。

## 导出文件

只读本地文件，不访问聊天平台。

- 聊天：`{ "turns": [...] }`，或 `messages` / `steps`。也接受 JSONL，以及 `User:` / `### t01 user` 这种文本。`role` 为 user、human、reviewer（或 `type: USER_INPUT`）才成为候选。助手轮次不会被当成插手。
- PR 评审：`reviews` 和 `comments`，带 `pull_request` URL。
- 候选列表：`candidates` 或 `items`，用来接 R3 已经写好的 fixup/review，本票不实现采集。

三种形状不要混在一个文件里。程序不猜测哪一行是插手。

## CLI

```sh
pnpm eval task mark <id> --from-file export.json --confirm t03:插手,t05:返工
pnpm eval task mark <id> --from-file export.json --select
pnpm eval task mark <id> --note "按钮也要改" --type 返工 --source https://example.invalid/pull/8
```

`--type` 接受 `插手`、`返工`、`intervention`、`rework`。`--select` 对每一行提问，空行或 `skip` 保持未确认。

`task show` 打印 `baseline.interventions` 和 `baseline.rework_rounds`，并在详细模式下打印每条摘录。这两个基线和勾选结果一致。`task list` 的 intervention 列仍然只表示插手：没有历史是 `unknown`，确认过的记录是 `records:N`。

chat-only 卡可以没有 PR 字段。缺 PR 不是错误。

## 不做

不用模型判断插手。不抓取聊天平台接口。不要求 verify。不实现 R3 的采集。
