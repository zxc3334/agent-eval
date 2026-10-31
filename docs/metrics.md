# 指标

重放之后采集每个 variant 的指标。没有 verify 也会写出 `metrics.json`。证据完整度在 `score=unavailable` 时是 **N/A**，不是 0。

```sh
pnpm eval metrics <task-id> --run <run-id>
pnpm eval task show <task-id> --run <run-id>
```

`metrics` 读这次 run 里已经落下的事件流、`usage.json`，以及可选的 `verify/result.json`，写出：

```text
runs/<run-id>/variants/<without|with-skill>/metrics.json
runs/<run-id>/variants/<name>/attempts/<n>/metrics.json   仅 --repeat > 1
```

`task show --run` 只打印这些文件。它不重新数事件，也不把两列插手加在一起。还没采集时显示 `metrics: not collected`，不显示 0。

## 插手：request 和 actual 分列

两列都来自同一次 `summarizeCursorStream`（`interventionKind` 对每个事件只给一个种类）。不读 `interventions.json` 再加一遍。

| 列 | 计入 | 不计入 |
| --- | --- | --- |
| `intervention_request` | `interaction` / `request`，以及提问工具（`AskQuestion`） | 人的回答 |
| `actual_human_intervention` | `interaction` / `response`，以及第一条提示回显之后的 `user` 事件 | 未作答的 request |

一条 request 不会同时算进 actual。两列不会合成一个 `interventions` 总数。历史对比只用 actual 这一列，因为卡上的基线只计确认过的插手（见 [marks.md](marks.md)）。

事件流里一个解析出来的事件都没有时，两列都是 `unknown`，不是 0。流里有事件、但没有 request 也没有回答时，是测到的 0。

## 返工轮

一轮 = 一组修改工具调用，到下一个边界为止。`started` 和随后的 `completed` 是同一次修改，不数两次。request 既不开一轮，也不结束一轮。

修改工具是 write / edit / delete / patch（含 `writeToolCall` 这类名字）。提问工具不是修改。

边界，先到先关，同一轮只关一次：

| 边界 | 何时算一轮 |
| --- | --- |
| 人工确认 | 这些修改之后出现一次 actual。算一轮 |
| reverify | 流里的 verify 工具，或这次 attempt 上 R7 的 verify 结果（分数不是 `unavailable` / `interrupted`）。**第一组**自主修改后的那一次收尾 verify 是初次尝试，不算返工。它之后的下一组才算 |
| submit | `result` 事件。只有 verify 没法打分时才用它收尾，并且这一组得是用户驱动的，或者前面已经有过边界 |

没有 verify（分数 `unavailable`）时，仍然数**用户驱动的修改轮**：一次 actual 之后的那一组修改，到 `result` 结束，算一轮。人在修改之后确认，也算一轮。只改文件、没人回答、也没有后续边界，不算返工。

同一组修改不会在「人确认」和「submit」上各算一次。

## 证据完整度

有 verify 要求项、并且分数是 `pass`、`feature fail` 或 `verifier error` 时：

```text
带证据的 feature 行数 / feature 行数
```

`verifier error` 且一行证据都没有，是测到的 **0**。

`score=unavailable` 或 `interrupted`，以及还没跑 verify、重放结果仍是 `unavailable` 时，证据完整度是 **N/A**。即使 feature 列表是空的，也不写成 0。

## 耗时、token、花费

| 字段 | 来源 | 缺失 |
| --- | --- | --- |
| `duration_ms` | 先用 `usage.json` 里的 harness 计时。文件没写这个字段时，才看 `result.duration_ms`。两个都有时只用 harness 的，不相加 | `unknown` |
| `input_tokens` / `output_tokens` | `result.usage` 里的数字，和 R6 同一处 | `unknown` |
| `cost` | `result.usage` 的 `cost`（或 `total_cost`）。不从 token 推算 | `unknown` |

测到的 0 保持 0。没测到的值保持 `unknown`，不会写成 0。

## 历史基线对比

基线来自卡上 R4 确认过的记录，经 `formatBaseline` / `sharedBaseline`。没标过、只有未确认候选、或状态是 `unknown` / `todo` / `unavailable` / `N/A` 时，基线是 `unknown`。有人确认过「这次没有」才是 `none`。`none` 不是数字 0；显示保持 `none`。

每个 variant 的 `comparison`：

| 字段 | replay | baseline | delta |
| --- | --- | --- | --- |
| `interventions` | 本轮 `actual_human_intervention`。不含 request | 卡上确认过的插手次数，或 `none` / `unknown` | 两边都能当数字时，`replay - baseline`。`none` 只在这次减法里按 0。任一端是 `unknown` 时 delta 是 `unknown`，不是 `replay - 0` |
| `rework_rounds` | 本轮返工轮 | 卡上确认过的返工轮，同一套 `none` / `unknown` | 同上 |

正的 delta 表示这次重放比卡上的历史基线多。这是和**历史**比，不是 with-skill 减 without。with / without 的逐卡差值由 `pnpm eval compare` 读取这里的 `metrics.json`，见 [compare.md](compare.md)。

## 不做

不评 skill 触发率或误触率。不因缺 verify 拒绝写 `metrics.json`。多张卡的 with / without 对比不在本文件里画，见 [compare.md](compare.md)。
