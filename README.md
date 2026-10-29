# agent-eval · 本地冒烟、Case schema v2 与校验

独立 TypeScript 评测仓库。当前只测本地确定性 **stub**，不代表 jackson-bot 的能力；真实产品以后仅经 adapter 接入。已含 E0/E1/E2、E3a schema v2、E3b brief 与 case 脚手架，本波增加 E3c schema-only 校验与 AgentInput 防泄漏测试，不接模型，不需要 API key、Docker 或 bot。

## 安装与第一轮

需要 **Node.js 24+、pnpm、macOS 或 Linux**。使用 Node 原生 TypeScript 执行，运行时无第三方依赖；开发依赖仅 TypeScript 和 Node 类型。锁文件固定版本。

```sh
pnpm install
pnpm eval --suite smoke --agent stub
```

smoke 有两个协议样例：`smoke-pass` 输出 `hello`，`smoke-fail` 输出 `wrong`。两例的硬断言都期望 `hello`，因此默认是 **1 pass + 1 fail，退出码 1**，这是预期结果。stub 只读取公开 AgentInput，输出 answer；独立 verifier 用深相等硬断言判定结果，stub 不读取验收文件、不直接返回成绩。

终端逐例打印状态、耗时、断言名、期望/实际值和证据路径，同时打印本轮 run 目录。默认串行，单例结束后立即输出，随后继续其余 case；`--fail-fast` 在首个非 pass 后停止。

| 退出码 | 含义 |
| --- | --- |
| 0 | 所有尝试均通过；没有待重跑 case 也返回 0，报告比例为 N/A |
| 1 | 存在硬断言 fail，没有运行故障 |
| 2 | 配置、环境、agent、协议、超时、verifier 故障或运行中断；混合结果优先 2 |

## Case schema v2 与公开/私有边界

`src/types.ts` 定义协议，`src/config.ts` 在运行前加载并校验。`schema_version: 2` 是格式版本，`version: "1.0.0"` 是 case 内容版本，两者独立。v1 文件必须按下表迁移；不隐式兼容无版本 suite。已有 smoke 与 faults 全部迁至 v2。

| 文件 | v2 内容 | 可见范围 |
| --- | --- | --- |
| `case.json` | `schema_version`、`id`、`version`、`type`（`positive`/`negative`）、文件引用、`artifact_allowlist`、`budgets`，可选 `inject`、`requirement_id`、`brief` | harness 元数据，不整体传给 agent |
| `brief.md` | 目标行为、退化信号、验收标准及需求来源；由 `case.json.brief` 引用 | 私有设计材料，不传给 agent |
| `input.json` | `prompt` | 公开任务 |
| `fixture.json` | 本地 fixture；当前 stub 使用 `answer`、可选 `delay_ms` | 公开环境材料 |
| `initial-state.json` | `initial_state` 指向的 JSON 对象；无状态用 `{}` | 公开初始状态 |
| `acceptance.json` | `gold: {answer}`、`criteria`、`error_examples: [{answer, reason}]`、`reviewed: boolean` | 私有验收材料，仅 harness/verifier |

`case.json` 示例（完整可运行实例见 `cases/smoke/smoke-pass/`）：

```json
{
  "schema_version": 2,
  "id": "smoke-pass",
  "version": "1.0.0",
  "type": "positive",
  "input": "input.json",
  "fixture": "fixture.json",
  "initial_state": "initial-state.json",
  "artifact_allowlist": ["answer.json", "resource.json"],
  "budgets": {"timeout_ms": 2000, "max_steps": 1},
  "acceptance": "acceptance.json"
}
```

公开 `AgentInput` 仅含 `prompt`、`fixture`、`initial_state`、`artifact_allowlist`、`budgets`。loader 逐字段构造并序列化到 `workspace/input.json`，不将 case、验收或实验对象整体展开。fixture 与初始状态的内容均视为公开，编写时不能放 Gold 或私有答案；stub 的 fixture.answer 是用于演示的确定性响应，验收真值独立保存在 acceptance 中。

私有 `acceptance.json` 的 Gold、criteria、错误对照和 reviewed 不复制到工作目录，也不属于 AgentInput。`reviewed: false` 表示尚未经人工确认，不阻止本地迭代；现有样例均为 false。`type` 表达用例类别，negative 不反转判分，仍由 criteria 判断。Gold 和错误对照在 E3a 仅存储和校验结构，尚不执行 Oracle/校准。

suite 必须引用精确 case 版本，拒绝范围、latest、缺版本和重复 id：

```json
{
  "schema_version": 2,
  "cases": [
    {"id": "smoke-pass", "version": "1.0.0"},
    {"id": "smoke-fail", "version": "1.0.0"}
  ]
}
```

当前目录仍为 `cases/<suite>/<id>/`；loader 检查清单版本与 case.version 完全相等，不匹配时在启动 run 前报错（exit 2）。本波不提供多版本仓库或不可变内容存储；编辑后仍可即时重跑，正式变更 case 版本时需同步更新 suite，旧 run 保留当时完整快照和 `case_refs`。

`budgets.timeout_ms` 是已有进程超时限制（1–300000ms），`max_steps` 必须为正整数；本地 stub 固定执行一个响应步骤，多步 agent 的计步协议不在本波。`artifact_allowlist` 是输出文件名列表，当前协议必须包含 `answer.json`；只将白名单中的已生成文件复制到 artifacts，stdout/stderr 由 harness 单独保留。workspace 保留全部执行现场。当前只支持单层文件名，不支持 glob 或目录。

模型、adapter、产品配置独立保存在实验文件，默认 `experiments/stub.json`：

```json
{"adapter": "stub", "model": null, "product": {}}
```

可用 `pnpm eval --experiment <本地JSON路径>` 切换；`--agent stub` 必须与实验 adapter 一致。实验配置只进入 run 的 `config.json`，不进入 AgentInput；当前只执行 stub，model/product 是记录用元数据，不调用模型或产品。失败重跑继承实验文件路径并重新读取，可显式覆盖；watch 也监听该文件。

## 看失败与证据

每次生成独立的 `runs/<时间戳-UUID>/`，不会覆盖历史结果：

```text
config.json                 本轮选例及精确版本、实验配置、来源 run、完整公开/私有快照
state.json                  是否中断、run 级错误
summary.json                各状态计数、通过率、评分覆盖率、未尝试 case、退出码
report.md                   可离线阅读的逐例报告
cases/<case-id>/
  snapshot.json             本例配置及输入快照
  events.jsonl              带时间戳的阶段、断言、错误事件
  result.json               状态、耗时、断言证据或故障阶段/原因
  workspace/                本轮独立执行目录（保留用于复核）
  artifacts/                stdout.log、stderr.log 与产物白名单中的已生成文件
```

失败直接打开终端所列 `artifacts/answer.json`；运行故障打开 `events.jsonl` 和 stdout/stderr。状态区分 `pass`、`fail`、`agent_error`、`timeout`、`verifier_error`、`environment_error`。协议异常归为 `agent_error`，阶段为 `protocol`。故障不填断言成绩，不冒充零分。

run 目录整体属于评测者：config/snapshot、verifier 事件、result 和 report 含私有答案或评分证据，不可作为公开 AgentInput。这里保证数据投影与文件布局的边界，不提供阻止恶意子进程读取宿主文件的安全沙箱。

报告口径：**全部尝试通过率 = pass / attempted**，**完成评分覆盖率 = (pass + fail) / attempted**。未尝试 case 单独列出，不混入分母；没有尝试时比例为 `null`/N/A。

```sh
# 使用 CLI 打印的 run-id；不依赖当前 case 文件即可重建报告
pnpm eval report <run-id>
```

`report` 成功生成返回 0，不复用原 run 的评测退出码。已有证据不变，仅重建 summary/report。

## 添加 case（E3b）

从仓库根目录运行：

```sh
pnpm eval case new greeting --requirement REQ-001
# 可选：独立 suite 和 cases 根目录；不存在时自动创建
pnpm eval case new greeting --requirement REQ-001 --suite local --cases-dir /tmp/my-eval-cases
```

默认写入 `cases/smoke/greeting/`，生成 `case.json`、`brief.md`、`input.json`、`fixture.json`、`initial-state.json`、`acceptance.json`。命令仅生成文件，不运行 adapter；成功退出 0，并打印路径与待办提示。自动创建或更新所在 suite 的 `suite.json`，追加 `{ "id": "greeting", "version": "1.0.0" }`，保留原有引用和其他清单字段。已有目录或清单中的同名 ID 会报错（exit 2），不会覆盖；已有无效 suite 也会报错，请先修复。

`case.json.requirement_id` 是稳定的需求标识，与 brief 中的 `requirement_id` 一致；同一个需求可以关联多个 case。ID 使用字母数字开头，其余字符只允许字母数字、`_`、`-`，不能把 URL 或路径作为 ID；Notion 需求链接填写在 brief 正文中。旧 E3a case 无需补这些可选元数据，新脚手架始终生成 `requirement_id` 和 `brief` 引用。

1. 填写 `brief.md`：目标行为描述前提、输入和可观察结果；退化信号描述什么变化算退化；验收标准列出通过条件及对应 criteria ID。补充需求来源链接。brief 仅供评测者，不能当作公开 prompt 传入。
2. 编辑公开材料：在 `input.json.prompt` 写任务，在 `initial-state.json` 写初始状态；当前 stub 的 `fixture.json.answer` 只是模拟响应。公开材料不放私有 Gold、判分提示或错误对照。
3. 独立编辑私有 `acceptance.json` 的 `gold.answer`、`criteria[].expected`、`error_examples`。默认 `type: "positive"`，可按需求改为 `negative`；两者都按 criteria 判分。人工确认后再将 `reviewed` 改为 true；未确认不阻止本地迭代。
4. 单例运行并查看 CLI 输出的断言与证据路径：

```sh
pnpm eval --suite smoke --case greeting --agent stub
# 自定义目录必须在运行时也传入
pnpm eval --suite local --case greeting --cases-dir /tmp/my-eval-cases --agent stub
```

未经编辑的模板符合 v2，但 `TODO_STUB_RESPONSE` 与 `TODO_EXPECTED_ANSWER` 故意不同，所以初次运行预期 **FAIL、退出码 1**。这是脚手架连通性检查，不是实际需求验收。填写后的 brief 验收标准通过 criteria ID 对应 `result.json.assertions`，断言再指向 `artifacts/answer.json`；run 快照保留 `requirement_id`。brief 正文仍在 case 源目录，当前不做独立快照或自动解析。

创建时使用 suite 内 `.case-new.lock` 防止多个脚手架写入者丢失引用，正常结束和报错都会释放。若进程被强制杀死，请确认没有创建进程在运行后，检查遗留 case 目录/清单，再手动删除锁并重试。未提供强制覆盖、自动需求拉取、自动 suite 升版或内容完整性审核；case 内容版本变化仍需同步修改 suite 中的精确版本。

## 只校验文件（E3c）

```sh
pnpm eval validate --schema-only
pnpm eval validate --schema-only --suite faults
pnpm eval validate --schema-only --suite local --cases-dir /tmp/my-eval-cases
```

默认检查 `cases/smoke/suite.json` 引用的全部 case，支持 `--suite` 与 `--cases-dir`。复用执行前的 v2 loader，检查重复 case/criteria ID、文件存在且为普通文件、精确版本与 ID 引用、路径边界和合法预算。成功退出 0，配置错误退出 2；输出文件、字段、原因和 `fix:` 修复提示，例如：

```text
schema_error: /.../case.json: budgets.timeout_ms: expected integer 1..300000; fix: update budgets.timeout_ms to satisfy this requirement
Schema-only smoke: checked 2 case(s), 1 error(s).
```

清单无效时停止遍历；清单有效时继续检查全部引用，每个 case 报首个错误，修复后可再次校验。不扫描未注册目录，case ID 在各 suite 内唯一，criteria ID 在本例内唯一。缺文件诊断指出引用字段及目标路径，JSON 解析失败指出出错文件的 `JSON/read` 字段。

此命令不读取实验配置、不启动 adapter、不执行 verifier/Gold/隐藏测试、不写 run 或报告；`reviewed: false` 和尚未填写的 E3b 模板仍可通过结构校验。结构通过不表示答案正确。运行类参数（如 `--agent`、`--experiment`、`--watch`、`--case`、`--runs-dir`）会被拒绝，避免误以为它们生效。

路径检查同时检查相对路径和符号链接解析后的边界：suite 在 cases 根内，case 在所属 suite 内，文件在所属 case 内。公开 input/fixture/initial_state 不得指向私有 acceptance/brief 的同一文件（含符号链接与硬链接）。防泄漏测试在私有 Gold、隐藏测试、counterexamples 及路径中注入独立标记，并检查 loader 对象及真正写给 stub 的 `workspace/input.json`；私有元数据不会通过对象展开进入 payload。隐藏测试仅作为私有扩展元数据测试隔离，不新增隐藏测试格式或执行器。公开 prompt、fixture.answer、initial_state 仍由作者负责；不会扫描自然语言内容、任意 JSON 值或推断手工复制的私有答案，也不提供宿主文件访问沙箱。

## 改 case 并单例重跑

```sh
pnpm eval --suite smoke --agent stub --case smoke-fail
pnpm eval --case smoke-fail --watch
# 使用上轮 run-id；选择所有非 pass，以及中断/fail-fast 后未尝试的 case
pnpm eval --failed-from <run-id>
pnpm eval --failed-from <run-id> --watch
```

例如把 `cases/smoke/smoke-fail/fixture.json` 中 `answer` 改成 `hello`，或修改 `acceptance.json` 中 criteria 的 `expected`，保存后重跑即可看到变化。case 的 `input`、`fixture`、`initial_state`、`acceptance` 都是相对于本例目录的 JSON 文件路径。

`--failed-from` 从旧 run 继承 suite 和 cases 目录，**读取当前磁盘文件**，终端与 config.json 都明确显示配置来源。可通过 `--suite`、`--cases-dir` 显式覆盖。`--case` 与 `--failed-from` 互斥。旧 run 只用于选例和记录来源，不拿旧配置覆盖编辑结果。

watch 每 100ms 检查所选 case 目录及 suite 清单，连续修改静默 150ms 后触发；通常 300ms 内启动重跑。若已有运行，会在 1 秒内显示 queued，等当前轮结束后串行重跑，多次保存合并为一轮。无效 JSON/字段会显示文件与字段，watch 不退出，修复后自动恢复。未选 case 和输出 runs 目录不会触发重跑。每个实际启动的 run 都有新 ID，watch 的 `source_run_id` 指向上一轮；配置校验失败时不启动 run。

运行中 Ctrl-C/SIGTERM 会终止 stub 的 POSIX 进程组（含子孙进程，必要时升级 SIGKILL），保留事件、stdout/stderr、部分产物和报告，清理系统临时执行目录；当前例记 `environment_error`，原因 `interrupted`，返回 2。watch 空闲时 Ctrl-C 正常退出，沿用最后一轮退出码。workspace 是保留的证据，不作为临时垃圾清理。

## 故障注入与开发自检

```sh
pnpm eval --suite faults --agent stub        # 预期退出 2
pnpm eval --suite faults --case timeout      # 可验证部分产物、子孙进程清理
pnpm eval --suite smoke --fail-fast
pnpm test
pnpm typecheck
pnpm eval --help
```

`case.json` 的 `inject` 支持 `agent_error`、`protocol_error`、`timeout`、`verifier_error`、`environment_error`，仅供 harness 故障注入，不属于 AgentInput。`fixture.json` 可设置 `delay_ms` 制造慢调用。input、fixture、initial_state 和 acceptance 在启动前验证。`criteria` 当前只支持 `{ "id": "名称", "type": "equals", "expected": 任意JSON值 }`。

支持 `--cases-dir <path>` 和 `--runs-dir <path>`，用于隔离本地实验或测试。输出目录不能直接等于 cases、suite 或 case 根目录；可使用其下独立的 `runs/` 子目录。run-id、suite、case-id 限制为字母数字、下划线、短横线，路径配置限制在 case 目录内。

测试使用真实 CLI 和本地子进程，覆盖硬断言红绿、0/1/2、混合故障、离线报告、fail-fast、超时/Ctrl-C 子孙进程清理、单例/失败集合重跑、watch 排队/合并/恢复和旧证据不变。

## 本波边界

本波只在已有 E3a loader / E3b scaffold 上增加 E3c schema-only 校验与 AgentInput 防泄漏测试。借鉴 Harbor 的独立 verifier/产物分离与 Workbench 的需求→case→证据，不采用二者 runtime。不实现 E4+ 新 verifier、Gold/Oracle 校准、真实 adapter、baseline 对比、公共榜、云并行、线上 QQ 或默认 LLM judge。

本机验收是 macOS arm64；Linux 使用相同 POSIX 机制但尚未实机验证，Windows 不支持本波进程组清理。不可捕获的 SIGKILL/断电不保证最后一份报告已写完；已写入的证据保留。stub 进程隔离用于生命周期管理，不是执行不可信代码的安全沙箱。

## Issues

议题只记在 Notion，不在 GitHub Issues 开单。

- 索引：https://app.notion.com/p/405e1347ee9781a39505dae9b7f5b189
- E0：https://app.notion.com/405e1347ee978196b7c7e682ddabe7c2
- E1：https://app.notion.com/405e1347ee97810c9934e82b2b8c5f35
- E2：https://app.notion.com/405e1347ee978176b77cc486100195d8
- E3a：https://app.notion.com/p/405e1347ee97813e9172d527cf9a96e9
- E3b：https://app.notion.com/p/405e1347ee9781cda55ce3b07a09388f
- E3c：https://app.notion.com/p/405e1347ee97817c90f8f782dbfd8902
