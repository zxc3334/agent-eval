# 可选 verify 判分

重放不算分。卡上有 verify 路径时，用这条命令对每个 variant 的工作区跑一份**钉死版本**的 verify。没有 verify 时分数是 `unavailable`，不是 fail。

```sh
pnpm eval verify <task-id> --run <run-id> [--verify <bundle>] [--repo-dir <dir>]
pnpm eval verify <task-id> --variant <name>=<workspace> [--verify <bundle>] [--repo-dir <dir>]
```

`--run` 接着一次 replay，给每个 variant 工作区打分。`--variant` 直接给夹具工作区，不必先跑 agent。`--verify` 指向工作区**外面**的钉死 bundle。不写时，卡上的 `path` 从任务目录或仓库根解析，不会到 variant 工作区里去找。

历史工作区里后来才加的 verify 不在 base 上。同一比较里的每个 variant，以及合入参照，都用这一份 pin 和 features-map。

## 阶段

bundle 里按顺序执行 `phases/launch`、`doctor`、`drive`、`evidence`、`cleanup`。技能自己判断做没做成。Harness 不另写断言，也不按 diff 像不像打分。

阶段退出 `0` 表示这一阶段走完。退出 `75` 表示这次无法判分，分数是 `unavailable`。其它非 0 是 verifier 崩溃，分数是 `verifier error`。Ctrl-C 是 `interrupted`。

Evidence 阶段写出 `skill-result.json`：pinned features-map 里的每一条都要有一行，`passed` 是布尔值，并指向已经落盘的证据文件。行里不能自报 `mode`。`hard` 才决定 pass 还是 feature fail。`diagnostic` 失败只留在证据里，不改分数。缺行、坏 JSON、证据文件不存在，都是 `verifier error`，不会记成 fail 或 pass。

## 分数和退出码

只有这五种：`pass`、`feature fail`、`verifier error`、`unavailable`、`interrupted`。

| 分数 | 退出码 |
| --- | --- |
| `pass`，或 `unavailable` | 0 |
| `feature fail` | 1 |
| `verifier error` | 2 |
| `interrupted` | 3 |

卡上 verify 是 `none`、省略、`todo` 或 `unavailable` 时，不跑阶段，`score=unavailable`，退出码 0。这和 feature fail 的 1 不同。夹具路径因此仍算成功。error 和 unavailable 不会被写成 fail 或 pass。几个 variant 里只要有 verifier error，退出码就是 2，即使另一个 variant 是 feature fail。

## 合入参照

卡上有 merge SHA 时，用同一份 pin 在合入树上再跑一遍，作为参照线，不是 gold。variant 相对 base 改过的文件和 merge 相对 base 改过的文件，交集写在 `overlap.json`。这是证据，不是分数，也没有相似度。

没有 merge（chat-only、`N/A`、没写）时，参照是 `unavailable`，不跑合入树。

## 证据

```text
runs/<run-id>/
  verify/comparison.json
  verify/pin.json
  verify/features-map.json
  verify/bundle/                 本次比较钉死的那一份
  variants/<name>/verify/
    result.json
    input.json
    overlap.json                 仅在有 merge 时
    phases/<launch|doctor|drive|evidence|cleanup>/
    evidence/skill-result.json
    evidence/validated.json      技能输出通过协议之后
  reference/verify/result.json
  reference/workspace/           仅在参照真的跑了合入树时
```

`--repeat` 的每一次在 `variants/<name>/attempts/<n>/verify/`。replay 自己的 `result.json` 仍是 `unavailable`；判分在旁边的 `verify/result.json`。

仓库里的 `tracks/skill/fixtures/verify-mini` 是微型 fixture verify，用来演示 pass、feature fail、verifier error、unavailable 和 interrupted。它不是目标仓的 verify，也不要求 jackson-bot 创建 verify。

证据完整度不在这次判分里计算。`score=unavailable` 时，指标里的证据完整度是 N/A，见 [metrics.md](metrics.md)。
