# agent-eval · M0 本地冒烟

Skill 线 CLI：`pnpm eval --help`，任务卡录入是 `pnpm eval task --help`，重放之后的可选判分是 `pnpm eval verify --help`。三线目录与依赖规则见 [docs/repo-layout.md](docs/repo-layout.md)。任务卡格式见 [docs/task-card.md](docs/task-card.md)。判分见 [docs/verify.md](docs/verify.md)。本页其余 `eval:m0` 命令是已有的 M0 本地冒烟，不是 skill track。

独立 TypeScript 评测仓库。当前只测本地确定性 **stub**，不代表 jackson-bot 的能力；真实产品以后仅经 adapter 接入。本波范围是 E0/E1/E2，不接模型，不需要 API key、Docker 或 bot。

## 安装与第一轮

需要 **Node.js 24+、pnpm、macOS 或 Linux**。使用 Node 原生 TypeScript 执行。M0 冒烟没有运行时依赖；任务卡解析依赖 `yaml`。开发依赖是 TypeScript 和 Node 类型。锁文件固定版本。

```sh
pnpm install
pnpm eval:m0 --suite smoke --agent stub
```

smoke 有两个协议样例：`smoke-pass` 输出 `hello`，`smoke-fail` 输出 `wrong`。两例的硬断言都期望 `hello`，因此默认是 **1 pass + 1 fail，退出码 1**，这是预期结果。stub 只读取 input/fixture，输出 answer；独立 verifier 用深相等硬断言判定结果，stub 不读取验收文件、不直接返回成绩。

终端逐例打印状态、耗时、断言名、期望/实际值和证据路径，同时打印本轮 run 目录。默认串行，单例结束后立即输出，随后继续其余 case；`--fail-fast` 在首个非 pass 后停止。

| 退出码 | 含义 |
| --- | --- |
| 0 | 所有尝试均通过；没有待重跑 case 也返回 0，报告比例为 N/A |
| 1 | 存在硬断言 fail，没有运行故障 |
| 2 | 配置、环境、agent、协议、超时、verifier 故障或运行中断；混合结果优先 2 |

## 看失败与证据

每次生成独立的 `runs/<时间戳-UUID>/`，不会覆盖历史结果：

```text
config.json                 本轮选例、配置来源、来源 run、case/input/fixture/验收快照
state.json                  是否中断、run 级错误
summary.json                各状态计数、通过率、评分覆盖率、未尝试 case、退出码
report.md                   可离线阅读的逐例报告
cases/<case-id>/
  snapshot.json             本例配置及输入快照
  events.jsonl              带时间戳的阶段、断言、错误事件
  result.json               状态、耗时、断言证据或故障阶段/原因
  workspace/                本轮独立执行目录（保留用于复核）
  artifacts/                stdout.log、stderr.log、answer.json、部分产物
```

失败直接打开终端所列 `artifacts/answer.json`；运行故障打开 `events.jsonl` 和 stdout/stderr。状态区分 `pass`、`fail`、`agent_error`、`timeout`、`verifier_error`、`environment_error`。协议异常归为 `agent_error`，阶段为 `protocol`。故障不填断言成绩，不冒充零分。

报告口径：**全部尝试通过率 = pass / attempted**，**完成评分覆盖率 = (pass + fail) / attempted**。未尝试 case 单独列出，不混入分母；没有尝试时比例为 `null`/N/A。

```sh
# 使用 CLI 打印的 run-id；不依赖当前 case 文件即可重建报告
pnpm eval:m0 report <run-id>
```

`report` 成功生成返回 0，不复用原 run 的评测退出码。已有证据不变，仅重建 summary/report。

## 改 case 并单例重跑

```sh
pnpm eval:m0 --suite smoke --agent stub --case smoke-fail
pnpm eval:m0 --case smoke-fail --watch
# 使用上轮 run-id；选择所有非 pass，以及中断/fail-fast 后未尝试的 case
pnpm eval:m0 --failed-from <run-id>
pnpm eval:m0 --failed-from <run-id> --watch
```

例如把 `cases/smoke/smoke-fail/fixture.json` 中 `answer` 改成 `hello`，或修改 `acceptance.json` 中 `expected`，保存后重跑即可看到变化。case 的 `input`、`fixture`、`acceptance` 都是相对于本例目录的 JSON 文件路径。

`--failed-from` 从旧 run 继承 suite 和 cases 目录，**读取当前磁盘文件**，终端与 config.json 都明确显示配置来源。可通过 `--suite`、`--cases-dir` 显式覆盖。`--case` 与 `--failed-from` 互斥。旧 run 只用于选例和记录来源，不拿旧配置覆盖编辑结果。

watch 每 100ms 检查所选 case 目录及 suite 清单，连续修改静默 150ms 后触发；通常 300ms 内启动重跑。若已有运行，会在 1 秒内显示 queued，等当前轮结束后串行重跑，多次保存合并为一轮。无效 JSON/字段会显示文件与字段，watch 不退出，修复后自动恢复。未选 case 和输出 runs 目录不会触发重跑。每个实际启动的 run 都有新 ID，watch 的 `source_run_id` 指向上一轮；配置校验失败时不启动 run。

运行中 Ctrl-C/SIGTERM 会终止 stub 的 POSIX 进程组（含子孙进程，必要时升级 SIGKILL），保留事件、stdout/stderr、部分产物和报告，清理系统临时执行目录；当前例记 `environment_error`，原因 `interrupted`，返回 2。watch 空闲时 Ctrl-C 正常退出，沿用最后一轮退出码。workspace 是保留的证据，不作为临时垃圾清理。

## 故障注入与开发自检

```sh
pnpm eval:m0 --suite faults --agent stub        # 预期退出 2
pnpm eval:m0 --suite faults --case timeout      # 可验证部分产物、子孙进程清理
pnpm eval:m0 --suite smoke --fail-fast
pnpm test
pnpm typecheck
pnpm eval:m0 --help
```

`case.json` 的 `inject` 支持 `agent_error`、`protocol_error`、`timeout`、`verifier_error`、`environment_error`。`fixture.json` 可设置 `delay_ms` 制造慢调用。`timeout_ms` 为本例 agent 预算（1–300000ms）；input、fixture 和 acceptance 在启动前验证。`criteria` 当前只支持 `{ "id": "名称", "type": "equals", "expected": 任意JSON值 }`。

支持 `--cases-dir <path>` 和 `--runs-dir <path>`，用于隔离本地实验或测试。输出目录不能直接等于 cases、suite 或 case 根目录；可使用其下独立的 `runs/` 子目录。run-id、suite、case-id 限制为字母数字、下划线、短横线，路径配置限制在 case 目录内。

测试使用真实 CLI 和本地子进程，覆盖硬断言红绿、0/1/2、混合故障、离线报告、fail-fast、超时/Ctrl-C 子孙进程清理、单例/失败集合重跑、watch 排队/合并/恢复和旧证据不变。

## 本波边界

本节只约束 M0 冒烟代码：这里只交付 M0 本地协议链路。Skill 线骨架见 [docs/repo-layout.md](docs/repo-layout.md)。借鉴 Harbor 的独立 verifier/产物分离与 Workbench 的需求→case→证据，不采用二者 runtime。不实现 E3+、Gold/Oracle 校准、真实 adapter、baseline 对比、公共榜、云并行、线上 QQ 或默认 LLM judge。

本机验收是 macOS arm64；Linux 使用相同 POSIX 机制但尚未实机验证，Windows 不支持本波进程组清理。不可捕获的 SIGKILL/断电不保证最后一份报告已写完；已写入的证据保留。stub 进程隔离用于生命周期管理，不是执行不可信代码的安全沙箱。

## Issues

议题只记在 Notion，不在 GitHub Issues 开单。

- 索引：https://app.notion.com/p/405e1347ee9781a39505dae9b7f5b189
- E0：https://app.notion.com/405e1347ee978196b7c7e682ddabe7c2
- E1：https://app.notion.com/405e1347ee97810c9934e82b2b8c5f35
- E2：https://app.notion.com/405e1347ee978176b77cc486100195d8
