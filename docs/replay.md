# 重放

同一张 `replay-ready` 卡，从 `base_commit` 起跑两遍：一遍装上指定 skill，一遍不装。适配器是 **Cursor Agent**。with / without 只差这一份 skill，其余配置相同。这里不算分。

```sh
pnpm eval replay <task-id> --variant with-skill=<path> --variant without --repo-dir <checkout>
pnpm eval replay <task-id> --case without --variant with-skill=<path> --variant without --repo-dir <checkout>
pnpm eval replay <task-id> --repeat 2 --variant with-skill=<path> --variant without --repo-dir <checkout>
pnpm eval replay <task-id> --failed-from <run-id>
pnpm eval replay <task-id> --resume <run-id>
```

`--repo-dir` 是含有 base commit 的本地 git 仓库。命令不会去克隆后来的历史。缺 verify 不会拒绝重放。草稿不能重放，错误里带 `not_replay_ready` 的原因。

## Cursor Agent

入口写死为 `agent`。参数固定是：

```text
agent --print --output-format stream-json --trust --mode agent --workspace <dir> -- <agent-input>
```

没有 `--force`，也不替人回答提问。`--agent-bin` 只换可执行文件的路径，给测试用；参数和事件契约不变。

stdout 是一行一个 JSON：

| type | 含义 |
| --- | --- |
| `system` / `init` | 会话开始 |
| `user` | 第一条是交给 agent 的提示回显，之后的才是人实际插入的话 |
| `assistant` | 模型文本 |
| `tool_call` | 工具调用。`AskQuestion` 记为 intervention-request |
| `interaction` / `request` | agent 向人提问，记为 intervention-request |
| `interaction` / `response` | 人回答了，记为 actual-intervention |
| `result` | 结束。`usage.input_tokens` / `output_tokens` 有数字才记下，缺了是 `unknown`，不是 0 |

测到的 `0` 会保留。没测到的用量不会写成 0。

## 工作区和输入

每个 variant 有自己的目录，里面是一次真实 `git fetch` + `checkout`，HEAD 就是卡上的 base。只取这个 commit 和它的祖先，不取之后的提交，也不留 remote。

交给 agent 的只有 AgentInput：`task_id`、需求原文、`repo.id`、`repo.host`、`base_commit`。merge SHA、合入 diff、插手记录、verify 路径都不在提示里，也不写进 workspace。

`with-skill` 把 `--variant with-skill=<path>` 复制到 workspace 的 `.cursor/skills/<name>/`。`without` 不放这份 skill。两边的 `config.json` 里，除了 `skills`，参数、模型和提示哈希都相同。

## 证据

```text
runs/<run-id>/
  run.json
  state.json
  variants/<without|with-skill>/
    config.json
    agent-input.json
    prompt.txt
    invocation.json
    events.jsonl
    interventions.json
    usage.json
    result.json
    workspace/
```

`--repeat N` 大于 1 时，每一遍在 `variants/<name>/attempts/<n>/`，目录下的 `result.json` 是汇总。`result.json` 里的 `score` 固定是 `unavailable`。卡上没有 verify 时 `verify` 是 `omitted`。即使写了 verify 路径，这一票也不执行它。

Ctrl-C 或 SIGTERM 会停掉 agent 进程组，已经写下的文件留着，`result.status` 是 `interrupted`。`--resume <run-id>` 接着同一个 run：完成了的 variant 跳过，中断的那次挪到 `partials/` 再重跑。`--failed-from <run-id>` 另开一个 run，只重跑没完成的 variant，原来的证据不动。`--case without` 或 `--case with-skill` 只跑一个 variant。

## 不做

不算分，不出对比。不自动回答 agent 的提问。不多模型，也不再接第二个 adapter。
