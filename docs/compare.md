# 对比

同一批任务上，比较不用 skill 和用 skill。读的是 R8 已经写好的 `metrics.json`，不重新数事件。没有 verify 也可以比插手和返工。

```sh
pnpm eval compare --tasks <filter> --a without --b with-skill
pnpm eval compare feedback --task <id> --run <run-id> [--attempt N]
```

`--tasks` 是逗号分隔的任务 id。`*` 匹配全部。shell 会展开星号时要加引号。`--a` 和 `--b` 默认是 `without` 和 `with-skill`。

终端报告同时写到 `runs/comparisons/<a>--<b>/compare.md` 和 `compare.json`。

## 配对

一行是一张卡、一次 run、一遍 repeat。顺序按任务 id、run id、attempt 排，同一批输入每次结果相同。

配对时看的配置是 adapter、入口、参数、模型和提示哈希。skill 列表不算差异，因为这就是要比较的东西。提示、模型或参数不一致时，每个已经测到的数字指标都标 `conflict`，不把整行合成「变好」或「变差」。

缺一边时这一行仍然出现，指标是 `missing`。不是 0，也不是 flat。

## 逐指标

每行分开报这些差值，b 减 a。负的表示 with-skill 更少。

| 指标 | 取值 |
| --- | --- |
| interventions | `actual_human_intervention`。不加 request |
| rework_rounds | 返工轮 |
| duration_ms | 耗时 |
| input_tokens | 输入 token |
| output_tokens | 输出 token |

token 不合成一个总数。没有单独的总标签。

| 结果 | 含义 |
| --- | --- |
| improved | 两边都是数字，且 b 更小 |
| worsened | 两边都是数字，且 b 更大 |
| flat | 两边都是数字、差是 0、两次 attempt 都是 completed |
| unknown | 有一边没测到。差是 `unknown`，不是 0 |
| missing | 这一边的 variant 没有跑 |
| interrupted | 差是 0，但有一次 attempt 是中断。不记成 flat |
| failed | 差是 0，但有一次 attempt 是 error。不记成 flat |
| unscored | 差是 0，但结果状态不是 completed |
| conflict | 配置或 base 对不上。数字仍印出来 |

测到的 0 保持 0。只有 completed 且差是 0 才是 flat。`unknown`、中断、失败、缺测量都不会记成 flat。

## verify

两边分数都是 `pass` 或 `feature fail` 时才比较。`verifier error` 对上一个已打分的结果是 `conflict`，不合成输赢。

任一边是 `unavailable`，或这一边根本没跑，列是 `unavailable`。分数是 `interrupted` 时列是 `interrupted`，不是 unavailable，也不是 flat。没有 verify 的一整批卡仍然可以比插手和返工。

## 恶化和证据

汇总的每个格子等于对应的逐卡行数。恶化列表只收数字指标变差，或 verify 从 pass 变成 feature fail 的行。

每一行给出 run 目录。有事件、结果、`metrics.json` 就链过去。有 `verify/result.json` 才链 R7 证据；没有就写 `verify: unavailable`，不链一个不存在的文件。

## 回灌

```sh
pnpm eval compare feedback --task <id> --run <run-id> --attempt 1
```

变差的那一对会新建一张可重放的卡：需求、仓库、base 从原卡复制。插手或返工变差时写成一条确认过的标记，来源是 `runs/<run-id>`。其它指标保持 `unknown`，不写成 0。

卡的 id 里含有这次 run id，所以 `task list` 能看到来源。同一张卡、同一次 run、同一个 attempt 再跑一次是 `unchanged` / `deduped`，退出码 0，不会多出第二条。

## 不做

不做统计显著性，不做排行榜，不做 Web 页。不要求至少有 N 张带 verify 的卡。
