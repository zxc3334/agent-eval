# agent-eval · 本地冒烟、Case schema v2 与校验

独立 TypeScript 评测仓库。支持本地确定性 **stub** 和 **Oracle 参考解**，不代表 jackson-bot 的能力；真实产品以后仅经 adapter 接入。已含 M1、E3–E6c，复用同一 verifier。不接模型，不需要 API key、Docker 或 bot。

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
| `gold.md` + `solve.ts` | 参考解说明与独立执行代码；Oracle 按固定文件名加载 | 私有参考材料，只在 Oracle 模式执行，不传给被测 adapter |
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

私有 `acceptance.json` 的 Gold、criteria、错误对照和 reviewed 不复制到工作目录，也不属于 AgentInput。`reviewed: false` 表示尚未经人工确认，不阻止本地迭代；现有样例均为 false。`type` 表达用例类别，negative 不反转判分，仍由 criteria 判断。旧 `acceptance.gold.answer` 保留结构兼容，但不作为 Oracle 输出来源或判分依据。E5a 执行独立 `solve.ts`；E5b 的错误对照校准与正式 suite 门禁见文末。

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

默认目录为 `cases/<suite>/<id>/`；E6c 允许引用附加 `source`（例如 `{"id":"fixed-retrieval","version":"1.0.0","source":"seeds"}`），从 `cases/<source>/<id>/` 复用原 case。source 只能是单个目录标识符，不能是绝对路径或包含路径分隔符，符号链接不能逃出所属目录。loader 检查清单版本与 case.version 完全相等，不匹配时在启动 run 前报错（exit 2）。本波不提供多版本仓库或不可变内容存储；编辑后仍可即时重跑，正式变更 case 版本时需同步更新 suite，旧 run 保留当时完整快照和含 source 的 `case_refs`。

`budgets.timeout_ms` 是已有进程超时限制（1–300000ms），`max_steps` 必须为正整数；本地 stub 固定执行一个响应步骤，多步 agent 的计步协议不在本波。`artifact_allowlist` 是输出文件名列表，当前协议必须包含 `answer.json`；只将白名单中的已生成文件复制到 artifacts，stdout/stderr 由 harness 单独保留。workspace 保留全部执行现场。当前只支持单层文件名，不支持 glob 或目录。

模型、adapter、产品配置独立保存在实验文件，默认 `experiments/stub.json`：

```json
{"adapter": "stub", "model": null, "product": {}}
```

可用 `pnpm eval --experiment <本地JSON路径>` 切换；`--agent stub|oracle` 必须与实验 adapter 一致。`--agent oracle` 默认选择 `experiments/oracle.json`。实验配置只进入 run 的 `config.json`，不进入 AgentInput；model/product 是记录用元数据，不调用模型或产品。失败重跑继承实验文件路径并重新读取，可显式覆盖；watch 也监听该文件。

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

`case.json` 的 `inject` 支持 `agent_error`、`protocol_error`、`timeout`、`verifier_error`、`environment_error`，仅供 harness 故障注入，不属于 AgentInput。`fixture.json` 可设置 `delay_ms` 制造慢调用。input、fixture、initial_state 和 acceptance 在启动前验证。旧 `{ "id": "名称", "type": "equals", "expected": 任意JSON值 }` 仍兼容，自动规范化为 `answer.json` 的 `answer` 字段、hard 模式。完整协议及 E4b 类型见下文。

支持 `--cases-dir <path>` 和 `--runs-dir <path>`，用于隔离本地实验或测试。输出目录不能直接等于 cases、suite 或 case 根目录；可使用其下独立的 `runs/` 子目录。run-id、suite、case-id 限制为字母数字、下划线、短横线，路径配置限制在 case 目录内。

测试使用真实 CLI 和本地子进程，覆盖硬断言红绿、0/1/2、混合故障、离线报告、fail-fast、超时/Ctrl-C 子孙进程清理、单例/失败集合重跑、watch 排队/合并/恢复和旧证据不变。

## E4b：结构化字段与文件断言

```sh
pnpm eval validate --schema-only --suite fields  # 5 cases，退出 0
pnpm eval --suite fields --agent stub           # 2 pass + 3 fail，预期退出 1
pnpm eval --suite fields --case fields-pass-b --agent stub  # 退出 0
```

`fields-pass-a` 与 `fields-pass-b` 的措辞、JSON 格式、键顺序、附加元数据均不同，但满足相同硬条件，因此都通过。`fields-missing` 虽然返回 success 关键词却未写文件，`fields-malformed` 写了非法 JSON，`fields-clobbered` 改坏了无关字段；三者均 fail，不能靠答案文字或 `success: true` 获得通过。

完整 Criterion 延续 `id / type / target / params / mode / reason`：

| type | target.field | params | 判断 |
| --- | --- | --- | --- |
| `equals` | JSON Pointer 或顶层字段名 | `{ "expected": 任意有限JSON值 }` | 对选中字段进行严格深相等比较 |
| `json_parseable` | `""`（文档根） | `{}` | 产物存在、为普通文件且可解析为有限 JSON 值 |
| `fields_preserved` | `""`（文档根） | `{ "baseline": 初始文档, "fields": ["/profile", "/enabled"] }` | 指定字段必须存在且与私有 baseline 深相等 |

`target.artifact` 是 `artifact_allowlist` 内的单层 `.json` 输出文件名，不接受路径、目录或 `input.json`。`field` 的空串表示整个文档；`/items/0/name` 可查数组，`~1` 表示 `/`，`~0` 表示 `~`；裸字段名（如 E4a 的 `answer` 或 `a.b`）按一个顶层字面键处理，不做点号分割。只读自有属性，数组按非负标准索引访问。缺字段与值为 null 不同；类型和数组顺序必须相同，对象键顺序、空白和换行不影响判分。

例如，更新主题并保持 profile：

```json
[
  {
    "id": "theme-updated", "type": "equals",
    "target": { "artifact": "config.json", "field": "/theme" },
    "params": { "expected": "dark" }, "mode": "hard",
    "reason": "Theme must become dark."
  },
  {
    "id": "profile-kept", "type": "fields_preserved",
    "target": { "artifact": "config.json", "field": "" },
    "params": { "baseline": { "theme": "light", "profile": { "owner": "Ada" } }, "fields": ["/profile"] },
    "mode": "hard", "reason": "Do not modify the unrelated profile."
  }
]
```

保持检查的 baseline 由 case 作者独立写入私有 acceptance；它不是从当前输出或 Gold 自动推导，也不会新增到 AgentInput。作者应使它与公开初始状态的待保留值一致。只检查 `fields` 列出的值：选中对象会检查其整个子树，未选中的字段可变化或新增；需要禁止对象内新增字段时，应选中该对象。baseline 中缺少指定字段是配置错误（退出 2）。此检查不评估工具调用参数或执行过程中的副作用。

本地 stub 的公开 fixture 可选 `files: { "config.json": "文件文本" }`，只把文本写到白名单产物中；不能覆盖 `answer.json` 或 stub 资源文件 `resource.json`。这支持重放合法、非法和缺失文件样例，不实现真实 adapter。旧 fixture 无需修改。

verifier 在原有独立 worker 中只读 artifacts，同次验证缓存 JSON 解析结果，结果另存于 `cases/<id>/verifier/attempt-*/`。每条断言保留 `expected / actual / passed / evidence` 及 Criterion 元数据；保持检查的 expected/actual 是按字段路径投影的值。无法读取、解析或找到字段时，附加 `problem`，在终端、result.json、report.md 中可见；此时 actual 可为 null，必须结合 passed/problem 判断，不能把它当作真实 null 字段。

硬断言失败决定 fail；diagnostic 失败只提供反馈。缺失或不可解析的被验收产物是断言 fail；worker 异常、超时、缺结果、无效结果仍是 `verifier_error`。原有 adapter 的 `answer.json` 响应协议仍先检查，缺失或破坏响应信封仍归 `agent_error`（protocol 阶段）。JSON 之外的格式、glob/目录、通用 JSON Schema、自动枚举所有无关字段不在 E4b 范围。

## E4c：工具参数与副作用断言

```sh
pnpm eval validate --schema-only --suite tools  # 6 cases，退出 0
pnpm eval --suite tools --agent stub           # 2 pass + 4 fail，预期退出 1
pnpm eval --suite tools --case tools-pass --agent stub  # 退出 0
```

工具调用记录放在 allowlist 内的 JSON 产物中。`target.field` 选择调用数组，可以是文档根 `""` 或 `/calls` 等 E4b JSON Pointer。每条记录必须含非空 `tool` 和对象类型的 `arguments`，额外的 `id`、`success` 等元数据可保留，但不参与判分。例如 `trace.json`：

```json
{
  "calls": [
    { "tool": "search", "arguments": { "query": "alpha", "limit": 5 } },
    { "tool": "get", "arguments": { "id": "item-1" } }
  ]
}
```

三种新类型沿用完整 Criterion 和 `hard | diagnostic`：

| type | params 示例 | 判断 |
| --- | --- | --- |
| `tool_args` | `{ "tool": "search", "field": "/query", "expected": "alpha" }` | 至少有一次该工具调用，且每次调用参数中的指定字段都存在并严格深相等 |
| `no_write` | `{ "read_only_tools": ["search", "get"] }` | 所有调用都属于作者声明的只读工具；未列出的工具一律失败 |
| `no_duplicate_side_effects` | `{ "side_effect_tools": ["send", "write"] }` | 指定副作用工具不能出现相同工具名、深相等参数的重复调用 |

例如参数检查：

```json
{
  "id": "query", "type": "tool_args",
  "target": { "artifact": "trace.json", "field": "/calls" },
  "params": { "tool": "search", "field": "/query", "expected": "alpha" },
  "mode": "hard", "reason": "Every search must use the requested query."
}
```

`params.field` 相对于 `arguments` 选择字段，空串检查整个参数对象；可用多个 criterion 检查多个字段。指定字段之外的参数允许变化，整个对象比较则禁止额外参数。工具名精确、区分大小写；不通过名称猜测写操作，也不相信调用记录的 `read_only` 声明。列表必须唯一、元素非空；`read_only_tools: []` 表示禁止任何调用，`side_effect_tools` 不得为空。

重复检查只针对指定副作用工具，同名只读调用可以重复。对象键顺序不影响相等，参数类型、数组顺序和工具名影响相等；调用 ID、时间、成功/失败标记不影响相等。每条记录视作一次尝试，因此重试同样计数，不推测失败调用是否已产生外部效果。合法空数组通过禁写和重复检查，参数检查失败；缺产物、缺字段、非法 JSON、非数组或任意非法调用记录均产生断言失败，不能当空数组跳过。

工具断言继续使用 E4a 的 `expected / actual / passed / evidence`，证据指向原始产物与调用数组。`tool_args.expected` 是要求的字段值，`actual` 是每次匹配调用的 `{index, found, value}`；禁写/重复检查的 `expected` 是空违规列表，`actual` 列出违规调用（零基 `index`、工具名、参数），重复项还带 `first_index`。`problem` 给出失败原因，终端、报告与独立 `verifier/attempt-*` 目录均可查看。worker 异常、超时、缺失或无效结果仍为 `verifier_error`。

`tools-pass` 演示参数、禁写、重复检查与 E4b 字段保留共同通过；`tools-diagnostic` 演示参数诊断失败不影响 hard 判定。另四例分别演示参数错误、禁止写调用、重复副作用、非法调用记录。`tools-duplicate` 将禁写设为 diagnostic，单独展示重复副作用 hard gate。所有记录都通过原有 `fixture.files` 静态重放，stub 不执行这些工具。

此检查基于提供的调用记录，不证明记录完整或外部系统未变化。case 作者负责正确声明工具策略；没有纳入 `side_effect_tools` 的工具不参与重复检查。语义相同但参数不同、不同工具别名、跨 run 去重和真实副作用捕获不在 E4c 范围。

## 本波边界

E4c 在已有 E4a/E4b 上增加工具参数、禁写和重复副作用断言，沿用 E3c schema-only 校验和 AgentInput 隔离。借鉴 Harbor 的独立 verifier/产物分离与 Workbench 的需求→case→证据，不采用二者 runtime。E4c 阶段未实现 Oracle；后续 E5a/E5b 和 E6 种子接线见下文。仍不实现真实 adapter、跨 run baseline 对比、公共榜、云并行、线上 QQ 或模型调用。

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

- E4b：https://app.notion.com/p/405e1347ee9781a0b537f7e698d07323
- E4c：https://app.notion.com/p/405e1347ee978167b1a8ebc1fc601055


## E5a：从固定初态执行 Oracle，再由同一 verifier 判定

```sh
pnpm eval --suite smoke --agent oracle   # 2 pass，exit 0
pnpm eval --suite fields --agent oracle  # 5 pass，wording-hint 诊断失败仍可见，exit 0
pnpm eval --suite tools --agent oracle   # 6 pass，exit 0
pnpm eval --suite smoke --agent stub     # 保留 1 pass + 1 fail，exit 1
pnpm typecheck
pnpm test
```

现有 18 个 case（含 faults）均提供 `gold.md` 与 `solve.ts`。负例的 stub fixture 用于暴露错误，Oracle 则生成满足任务要求的参考产物；Oracle 通过不等于被测 agent 通过。`case new` 同样生成两个文件，参考解默认输出与验收期望不同的占位值，先呈现失败，作者独立编辑后再验证。旧 v2 case 可继续运行 stub；选择 Oracle 时缺少或空白参考文件会在启动 run 前报错，退出码 2。`validate --schema-only` 仍只做结构校验，不执行参考解、不要求历史 case 补 Gold。

执行链为：加载并快照固定初态与参考源码 → 在全新 workspace 写入 OracleInput → 子进程执行 solve.ts → 收集白名单产物 → 校验 answer.json 协议 → 调用 `src/verifier.ts::verify`。最后一段是 stub 与 Oracle 共用的 runner 分支，未增加第二套评分逻辑。`success: true`、Gold 文档及 `acceptance.gold.answer` 均不能直接产生 pass；只由 hard 断言决定 pass/fail，diagnostic 继续报告而不阻断。

OracleInput 仅有 `prompt`、`initial_state`、`artifact_allowlist`、`budgets`，不含 stub fixture、acceptance 或 verifier 配置。solve.ts 应为自包含、使用 Node 内置模块的脚本，从当前目录的 input.json 读取初态，并写 answer.json（必须有 answer 字段）及所需文件。参考解不得导入 verifier 的业务实现或反读 criteria 生成答案。fields 的参考解直接克隆初态并改 theme，verifier 独立检查字段与基线；tools 的参考解记录一次 search 动作，verifier 独立检查参数、禁写和重复副作用。

每例运行目录分别保存：

| 路径 | 内容 |
| --- | --- |
| `oracle/` | 本次执行的 gold.md、solve.ts、input.json 快照，仅 Oracle 有此目录 |
| `workspace/` | 新建执行目录、公开任务和固定初态、参考解生成的工作文件 |
| `artifacts/` | allowlist 中的普通文件及 stdout/stderr 日志；不接受符号链接产物 |
| `verifier/attempt-*/` | 与普通执行一致的输入 criteria、断言输出和判定 |
| `snapshot.json`、`result.json`、`events.jsonl` | case 快照、最终结果与过程记录 |

参考进程使用 Node 权限限制，只能读取自身源码与 workspace、写入 workspace；不能读取原 case/acceptance/verifier 源码或覆盖 verifier 结果。该边界用于避免意外耦合，不是对恶意程序的 OS 安全沙箱；本波不引入容器、Harbor/Workbench runtime、真实工具调用或网络模型。

超时预算和取消复用已有进程清理路径，参考解是一次进程调用（max_steps 仍沿用现有 one-step 协议）。崩溃或无效 answer 协议为 agent_error，超时为 timeout，verifier 错误保持 verifier_error，均退出 2。faults 中 agent_error/protocol_error/timeout 是 stub 专属注入，Oracle 执行自己的参考解，因此这三例通过；environment_error 与 verifier_error 注入仍生效，Oracle faults 预期 3 pass + 2 error、exit 2。准备阶段失败时尚未执行参考解，不会产生 oracle/ 快照。

支持 `--case`、`--fail-fast`、`--watch` 和 `--failed-from`。watch 会监听参考文件；failed-from 默认继承源 run 的 executor/experiment，读取当前 case 与参考解，再从固定初态重跑；可显式切换 `--agent`。报告可在源 case 不存在时从 run 产物离线重建。

E5a 的 Oracle 执行能力由下述 E5b 校准复用；所有已有 reviewed 值保持不变。


## E5b：错误对照校准与正式 suite 门禁

```sh
pnpm eval validate --suite smoke   # Oracle 2/2；检出 2/2；exit 0
pnpm eval validate --suite fields  # Oracle 5/5；检出 5/5；exit 0
pnpm eval validate --suite tools   # Oracle 6/6；检出 6/6；exit 0
pnpm eval validate --suite faults  # 故意注入环境/verifier 异常，校准失败；exit 2
pnpm eval validate --schema-only   # 仍只做结构校验，不执行、不写凭证
```

`validate --suite <name>` 不读取 experiment、不调用真实 adapter 或模型。它先快照整个 suite，再逐例运行独立 Oracle 和全部错误对照；不会 fail-fast。每次调用同一个 `evaluate → verify` 路径，使用全新的 workspace/artifacts/verifier 目录，固定初态、prompt、预算与 allowlist 相同，不继承前一个尝试的产物。公开 fixture 原样保留在 case 快照中；沿用 E5a，OracleInput 不携带 stub 的预制答案。错误对照只在独立尝试中写入其声明的产物，不修改公开 fixture，也不从 Oracle 输出补全缺失文件。

错误对照在私有 `acceptance.json.error_examples` 中声明：

```json
{
  "answer": "wrong",
  "reason": "Greeting differs from the task requirement.",
  "expected_failed_criteria": ["answer-equals"]
}
```

可附加 `files: {"config.json": "{...}"}` 或 `files: {"trace.json": "{...}"}`，内容是完整的输出文件文本，且文件必须在 case 的 artifact_allowlist 中；answer.json 由 answer 字段生成，不能通过 files 覆盖。声明的 criterion IDs 必须非空、唯一且指向 hard 条件。只有实际 hard 失败集合**精确等于**声明集合，且 verifier 正常返回 fail，才算成功检出；额外失败、错位失败、意外通过、异常、超时或缺失 verifier 结果均使校准失败。diagnostic 仍记录但不改变 Oracle 通过或错误对照检出，保持 E4a/b/c 的语义。

旧 v2 的 `{answer, reason}` 可继续用于本地执行和 schema-only；正式校准要求补齐 expected_failed_criteria，且至少有一个对照。现有样例已补齐声明（fields/tools 的原对照未提供文件，声明全部因文件缺失而失败的 hard 条件）。`case new` 会生成声明，但 Oracle 仍是故意失败的占位实现。

正式 suite 在 suite.json 添加 `"formal": true`。省略或 false 保持本地草稿行为，smoke/fields/tools/faults 默认仍是本地 suite。正式运行前会校验**全部成员**，`--case`、`--failed-from` 和 Oracle 执行均不能绕过门禁；未通过时退出 2，且不开始 agent run。`case new` 拒绝直接向正式 suite 注册未审核模板。

审核步骤：

1. 在本地 suite 编写 brief、独立 Oracle、验收标准和错误对照。
2. 执行 `pnpm eval validate --suite <name>`，查看报告中的可解性、检出及对应 artifacts/verifier 证据。
3. 校准全通过后人工设置 acceptance.json 的 `reviewed: true`，再将 suite 标为 `formal: true`。校准不会替代人工审核，也不会自动更改 reviewed。
4. 修改后再次校准。仅写 reviewed=true、只跑 Oracle 或只跑 schema-only 都不能产生有效的校准凭证。

每例的 `.calibration.json` 保存通过/失败状态、内容 SHA-256、Oracle 结论、成功检出数、时间和证据路径。哈希覆盖 case 配置、公开 input/fixture/initial_state、验收（不含 reviewed 布尔值）、可选 brief、gold.md、solve.ts 以及校准/执行/verifier 实现。内容变化即失效，不能通过不改 version 或保留 mtime 规避；只切换 reviewed 不改变哈希。每次校准先撤销旧成功凭证；执行中变更文件或中断不能留下本次有效凭证。这是可信本地作者流程的审核记录，不是对恶意篡改凭证的数字签名。凭证应与 case 一起交付；报告/尝试产物保存在 runs-dir，默认 runs/。

校准 run 的 `config.json.kind` 和 `summary.json.kind` 是 calibration；summary 分列 solvability、detection，并固定 `real_agent_attempted: 0`、`real_agent_pass_rate: null`，没有普通 agent 的 pass_rate 字段。`report.md` 分开展示可解性与检出，包含每个对照的预期/实际失败 ID 和证据路径。可用 `pnpm eval report <run-id>` 离线重建。目录为 `cases/<id>/oracle/cases/<id>/...` 与 `cases/<id>/controls/<序号>/cases/<id>/...`，保留现有 evaluator 的完整产物结构。

退出码：0=全部校准通过；1=Oracle 断言失败或对照检出不符合声明；2=配置/执行/环境/verifier 异常或中断（优先级最高）。运行校准只接受 `--suite`、`--cases-dir`、`--runs-dir`，输出目录必须在 cases 根目录之外；schema-only 的参数约束保持不变。

E5b Issue（Notion）：https://app.notion.com/p/405e1347ee978174b338f102244ef8bd 。本票不包含 E6 seeds、真实 jackson-bot adapter、外网模型或 Harbor/Workbench runtime。

## E6c：种子 smoke / full 本地接线

```sh
pnpm eval:smoke   # e6-smoke：3 条，预期 3 fail，exit 1
pnpm eval:full    # e6-full：8 条，预期 8 fail，exit 1
pnpm validate:e6c # 接线、证据、报告和兼容性断言，预期 exit 0
pnpm validate:e6a # Oracle 5/5、错误对照 12/12，exit 0
pnpm validate:e6b # Oracle 3/3、错误对照 9/9，exit 0
```

`eval:smoke` / `eval:full` 等价于 `pnpm eval --suite e6-smoke|e6-full --agent stub`，可追加 `--runs-dir`、`--case`、`--watch` 等现有参数。旧 `pnpm eval --suite smoke` 仍是两个协议样例；smoke/fields/tools/faults 清单和预期行为保持不变。

smoke 选 `fixed-retrieval`（资料与事实）、`tool-result`（工具参数与产物）和 `fixture-injection`（负例、拒绝越权与状态不变）。full 覆盖 E6a 五条正例和 E6b 三条负例；只有清单，没有 case 副本，不包含 acceptance 中的错误对照。错误对照继续由 `validate:e6a` / `validate:e6b` 单独校准。

**只验证评测链路（仅验评测链路），不代表产品/模型质量。** 种子的原 stub fixture 仍为未实现占位值，因此全部正常完成评分后得到 fail、退出 1；缺产物是硬断言失败，不是运行故障。`validate:e6c` 检查这个预期结果，且检查没有 timeout、agent/environment/verifier error，不把异常退出当作成功。它只在临时副本做校准与模拟审核，不修改原种子。

终端和每份普通运行 `report.md` 显示上述标注，`summary.json` 包含 `evaluation_scope: "pipeline_only"`、`scope_note`、`real_agent_attempted: 0`、`real_agent_pass_rate: null`。`pass_rate` 仅表示当前本地执行结果。报告含逐例断言和 artifacts/verifier 证据路径，`pnpm eval report <run-id>` 可离线重建标注。

两个新 suite 均为 `formal: false`，全部源 case 保持 `reviewed: false`。E5b 的正式审核门禁仍适用于 source 引用的每个成员；本票未授予人工审核。`--failed-from` 继续读取原种子的当前内容，watch 也监听引用目录。真实 adapter、外网模型、E7+ 和 Harbor/Workbench runtime 均未纳入。

E6c Issue（Notion）：https://app.notion.com/p/405e1347ee9781ecab23ecbe1568778a

## E7：独立 trial、冻结产物与容器功能验收

```sh
pnpm validate:e7             # 无 Docker 的边界/生命周期/回归测试，exit 0
pnpm eval:smoke              # 旧 stub 链路仍无需 Docker，预期 exit 1
pnpm eval validate --schema-only --suite e7-code

docker info
docker pull node:24-alpine   # 首次由本地操作者准备镜像；runner 不会自动拉取
pnpm eval:e7                # code-fix pass + code-tamper fail，预期 exit 1
pnpm validate:e7:docker     # 真实 Docker 验收脚本，全部预期符合才 exit 0
```

每个 trial 排他创建 workspace，生成随机 session ID，恢复公开 input、fixture、initial-state。`case.json.clock` 可指定固定 UTC ISO 时间，默认 `2026-01-01T00:00:00.000Z`。Node 的 `Date()`、`new Date()` 与 `Date.now()` 使用固定时间；计时器与 runner 超时仍使用真实时间。shell/其他语言可读取 `AGENT_EVAL_NOW`（毫秒）；这不是修改容器内核时钟，也不阻止受测代码主动重定义自己的时钟。已有目录不会被合并复用。重跑仍由原 suite、`--case`、`--failed-from`、watch 路径处理。

执行器停止后才冻结声明产物。可信本地进程沿用进程组清理；容器路径等待 `docker rm --force` 成功，清理未确认时禁止交接。`artifact-manifest.json` 记录 session、停止标记、文件名、字节数、SHA-256 和缺失项；`frozen/` 保存复制后的只读文件，后续 workspace 写入不会改变它。文件名仍限平铺文件，不支持目录/glob，拒绝越界、符号链接（包括指向白名单内的链接及悬空链接）、硬链接和特殊文件。`artifacts/` 保留原报告所用的兼容副本及日志；容器只挂载 `frozen/`，不挂载兼容副本或日志。

容器缺少任何声明产物都以 `environment_error / artifact_handoff` 停止，不启动 verifier。已有 stub/Oracle 的缺失证据继续交给原 criteria 判 fail，并在清单、终端和报告额外输出明确 handoff diagnostic 与排查命令，保持 E6 的负例和校准语义；非声明必验文件缺失不会新增硬断言。

`--agent container` 是 E7 的本地脚本夹具执行器，不是真实 jackson-bot adapter。需要 `case.json.execution`：

```json
{
  "image": "node:24-alpine",
  "command": ["sh", "-c", "node agent.cjs"],
  "public_files": { "agent.cjs": "agent.cjs", "add.cjs": "add.cjs", "public-test.cjs": "public-test.cjs" },
  "private_tests": "verify.cjs",
  "verifier_command": ["node", "/tests/verify.cjs"]
}
```

公开文件通过显式映射复制进新 workspace，公开输入不能引用私有验收/测试/Gold 的同一文件（也检查链接别名）。agent 容器只挂载该 workspace。runner 将本地镜像引用解析成 image ID，agent 和 verifier 使用同一 ID；不提交或复用 agent 容器。agent 移除、产物冻结后才新建 verifier 容器，只只读挂载冻结产物 `/artifacts` 与新复制的私有测试 `/tests`。两种容器均禁网、根文件系统只读、无额外 capabilities、限制进程数/内存/CPU，不挂评测仓库、Docker socket 或宿主环境变量。结果与日志由宿主收集，独立存于 `verifier/container-*/`；原 JSON criteria 仍由共享 worker 检查数据，代码功能检查只在 verifier 容器执行。

私有脚本退出 0 表示功能通过、1 表示功能不满足，其他状态、OOM、超时、无法确认容器退出等均是运行错误，不能当作通过。runner 还检查 daemon 的实际容器退出状态，不能仅凭 Docker CLI 返回码判定。镜像与私有 verifier 均属于可信本地评测配置；fixture 的 verifier 在受 Node 权限限制的子进程中执行提交代码，该子进程不能读取 `/tests` 或创建子进程。

`cases/e7-code` 的两例均把公开伪测试改成无条件通过。`code-fix` 同时修复加法，`code-tamper` 保留减法错误；二者 `answer.json` 都报告 done，只有隐藏功能检查决定差异。`validate:e7:docker` 再跑一轮确认状态、时钟和文件不串入，并检查缺失文件、指向 `/etc/passwd` 的符号链接、超时均不进入 verifier。每次使用临时 case 副本，证据保存至 `runs/e7-validation-*/validation.json` 及其 trials。Docker 不可用时返回 2，明确失败，不会跳过或回退到宿主执行代码。

错误包含阶段、原因、可复制的排查命令：`docker_preflight`（`docker version/context show/info`）、`image_prepare`（`docker image inspect/pull`）、`artifact_handoff`（`ls -la` 和查看快照/清单）；容器创建、执行、清理也分别记录阶段。CLI 和报告明确标注可信本地 stub/Oracle **不具备安全沙箱隔离**。Docker 路径仍依赖可信 daemon、镜像和宿主，不宣称抵御内核/daemon 漏洞。

E7 fixture 使用 `formal: false`、`reviewed: false`，专用 Docker 验收不冒充 E5b Oracle 校准或人工审核。既有校准内容哈希纳入新冻结/容器/时钟实现，旧正式凭证需重校准。E8 真实 adapter、外网模型、Harbor/Workbench runtime 迁移未实现。

E7 Issue（Notion）：https://app.notion.com/p/405e1347ee97813a874cee088440fec6

## E9：复现与重复运行

```sh
pnpm validate:e9
pnpm eval --suite smoke --case smoke-pass --agent stub --repeat 3
pnpm eval --rerun <run-id> --runs-dir runs
```

每次运行的 `config.json` 保存有效配置，`manifest.json` 保存 suite、case 引用文件、adapter、verifier、harness 的版本及 SHA-256、产品 revision、模型/采样参数、平台、可取得的本地镜像 ID，以及运行产物哈希。无法取得的值为 `unknown`；manifest 不对自身求哈希。`--rerun` 使用原配置和当前文件，执行前展示差异；无法确定的镜像或产品 revision 会明确标注不能核对。复跑并不保证模型输出逐字一致。修改本地文件或版本后仍可运行，以便观察差异；无效配置仍会被校验拒绝。

`--repeat N` 为每个 case 保留 N 次独立 trial、session 和 workspace；报告列出每次结果及通过次数，并记录未执行的试次。`--fail-fast` 或中断会停止后续试次。agent 与 verifier 使用各自的超时，进度行显示当前 case、阶段、耗时和已知步骤。产品 adapter 将 JSONL `tool_call` 作为步骤，观察到超过预算时终止进程并记录原因；产品仍须自行遵守传入的预算，因为 harness 无法撤销已发生的调用。container 没有计步协议，显示 `unknown`。产品可通过 `usage` 事件提供 input_tokens、output_tokens 和 cost；未提供的值显示 `unknown`，可用的零值仍显示 0。

## E10：显式基线与逐例比较

```sh
pnpm eval baseline set <run-id> --runs-dir runs
pnpm eval compare <baseline-run> <candidate-run> --runs-dir runs
pnpm eval compare <baseline-run> <candidate-run> --vary model --vary product_revision --runs-dir runs
pnpm validate:e10
```

`baseline set` 只接受已有完成清单的 run，在 `runs/baseline.json` 记录当前选择及每次选择的时间和历史。新 run 不修改该记录。比较明确指定两侧 ID，输出终端摘要以及 `runs/comparisons/<baseline>--<candidate>/compare.json`、`compare.md`；再次比较同一对会更新该目录。

比较先检查 suite、case 和 verifier 的内容版本及哈希、执行器和实验身份、重复策略以及配置和环境差异。`--vary` 可重复声明预期变化：`model`、`prompt`（实验配置的 `product.prompt`）、`product_revision`。报告展示声明的变量和其他差异；不兼容时列原因、退出 2，且不输出整体结论。stub、Oracle 和本地容器仅用于评测链路，不代表产品能力；不同执行器不能混用形成能力结论。

逐例按重复试次的通过数分类：`improve`、`regress`、`flat`；任一侧故障或未执行则为 `error-change`，不纳入整体结论。Markdown 对每侧试次提供结果与断言、事件轨迹和产物链接，缺失证据显示 unavailable。比较是离线分析，不运行 agent、不修改产品或基线。

E9 旧清单没有记录实验配置中被投影掉的额外字段：若实验文件摘要发生变化，比较会保守地判为不可核实。E10 新 run 对这些额外字段记录值哈希；产品真实 revision/model 或容器镜像摘要未知时也无法给出整体结论。suite 没有显式 version 时使用清单的内容哈希。
