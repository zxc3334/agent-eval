# E8：jackson-bot 接入前置条件

E8 的目标是经 adapter 评测 jackson-bot 的真实产品链路。当前本地检查的产品 checkout 为 `/Users/jackson/Desktop/staging/jackson-bot-codex-scan`，Git HEAD 为 `32c3a9a588e3ac831d57d423c3b707558380d70a`。以下行号对应这个版本；产品路径和 revision 应由运行配置提供，不应假定其他机器存在相同路径。

## 本地产品能力核查

- `main.ts:26` 的启动函数装配生产依赖：`main.ts:38` 在产品根目录创建 `data` 和 `logs`，`main.ts:54` 要求 QQ 凭据，`main.ts:138` 创建 gateway，`main.ts:161` 启动 token 和 gateway。这不是隔离的 headless 入口，不能拿来执行 E8 smoke。
- `app.ts:68` 定义了依赖集合，`app.ts:92` 导出 `handleMessage`；`app.ts:263` 之后的循环调用 backend、执行工具并发出回复。这是可供产品侧构建 headless 入口的现有 seam，但当前没有现成的版本化请求、fixture 注入或事件流入口。
- `agent/tools/registry.ts:14` 的 `ToolRegistry` 是具体实现；其 `execute` 在第 45 行起调用真实的 read、grep、edit 和 shell。`tests/helpers.ts:49` 的测试装配使用临时目录和 fake send，但第 106 行仍构造真实工具注册表，不能证明 mock tools 隔离。
- `app.ts:378` 起记录工具请求时只输出参数摘要；`app.ts:420` 起记录的结果会被截断。现有事件日志不足以提供完整工具参数和结果给评测 verifier。
- `agent/pi/backend.ts:84` 的 `PiBackend` 是产品内部的 pi backend；第 163 行提供 session reset，第 507 行起使用内存 session 和运行时凭据。单独调用该 backend 会绕过产品的消息处理与工具循环，应使用单独的 bare-pi agent ID，不能作为 `jackson-bot-pi` 的真实产品证据。
- 此 checkout 在检查时没有根目录 `node_modules` 和 `dist`。即使安装或构建依赖，也不会补齐上述 headless 和 fixture 注入能力。

## 产品侧最小前置条件

产品侧需要提供可由配置指定的、受支持的 headless entry，并在启动前报告可用能力。它应当：

1. 接收版本化 JSON 请求，允许指定产品模型配置、公开 case 输入和 fixture；每次 start 创建或重置独立 session，并把所有数据和工作目录限制在评测提供的临时目录。
2. 允许替换产品工具执行依赖为 mock tools，注入确定性的工具结果及状态；不得启动 QQ、发送真实消息或使用生产数据。仍应执行产品的消息处理、工具循环与回复路径。
3. 输出版本化 JSONL 事件，完整表达 final、tool_call（含参数）、tool_result、artifact、usage 与 error，以便 adapter 翻译并由独立 verifier 判断。artifact 必须能在临时工作区采集；不要在 adapter 中评分。
4. 说明 entry 所使用的产品 revision、模型和支持的协议及隔离能力，使 preflight 能在缺少能力时明确失败，而不是把缺口记录成产品能力失败。

这些条件满足后，配置实际产品路径、revision、model 和 entry，先运行 preflight，再运行 `pnpm eval --suite smoke --agent jackson-bot-pi`，检查各 case 的 trace、artifact、verifier 结果和 review 状态。能力断言可以失败，但一次可校准的 smoke 需要实际进入 review，不能全部为 agent_error。

目前尚未运行真实产品 smoke；已有测试夹具或协议替身的结果只能证明 adapter 和评测链路，不构成真实产品能力证据。产品缺口未补齐前，E8 保持 incomplete。

## 适配协议和配置

复制 `experiments/jackson-bot-pi.json` 到本地配置，填入绝对 checkout `product.path`、完整 HEAD SHA `product.revision`、相对于 checkout 的 Node 入口 `product.entry` 和非空 `model`；通过 `--experiment <文件>` 指定，或直接修改默认配置。默认配置有意留空，preflight 会指出所缺字段。entry 必须是真实产品提供的入口；不要把 pi backend 的单独调用冒充产品路径。

产品 checkout 必须干净，entry 和根目录 `agent-eval-entry.json` 必须由 Git 跟踪；清单须包含 `{ "protocol_version": 1, "entry": "与配置相同的相对路径", "capabilities": [...] }`。先静态校验清单，再在临时工作目录启动入口；能力声明是产品的承诺，不能防止不可信代码违反约定。入口使用 Node 启动。`--agent-eval-preflight` 应输出一个 JSON 对象：`protocol_version: 1` 和 `capabilities` 数组，包含 `headless`、`fixture_injection`、`mock_tools`、`isolated_storage`、`session_reset`、`jsonl_events`。preflight 校验 checkout HEAD、入口路径和声明能力；声明本身不是操作系统级隔离，产品入口必须可信，并实际遵守隔离承诺。入口使用独立临时 HOME 和 TMPDIR，环境不继承用户密钥。产品如需模型凭据，需要产品侧提供与安全隔离兼容的显式注入机制后再验收。

正常调用从 stdin 接受一条 JSON，包含 `protocol_version`、`session_id`、`model`、`prompt`、`fixture`、`initial_state`、`artifact_allowlist`、`budgets`、`storage_dir`、`mock_tools: true`。不能注入私有 acceptance。stdout 仅输出 JSONL，每条包含 `protocol_version: 1` 和 `type`：

- `final`: `answer`（每次恰好一条）；
- `tool_call`: `tool`、`arguments` 对象；`tool_result`: `tool`、`result`；
- `artifact`: allowlist 中的 `path` 和文本 `content`；`answer.json` 和 `tool_calls.json` 保留给 adapter 翻译；
- `usage`: `usage` 对象；`error`: 非空 `message`，表示运行失败。

adapter 保存 request 和原始事件，翻译 final 与工具调用到 verifier 使用的 artifact，不判断分数。每例单独启动进程、使用新 session 与临时目录，运行后清理临时目录。运行 `pnpm validate:e8` 可检查协议替身，不是产品验收；将产品入口接入后需重新执行真实 smoke 并审阅结果。

现有 `smoke` 是面向 stub 的 draft：其 fixture 中的 `answer` 直接对应断言，不足以校准产品能力。产品入口就绪后还须准备真实工具 fixture、适合产品路径的 smoke case，完成 Oracle/反例校准及人工 review；当前协议替身的通过结果不能替代这些工作。

`product-request.json` 和 `product-events.jsonl` 由 harness 保留为协议证据，不得加入 case 的 artifact allowlist。`product.revision` 对应 checkout HEAD；当前 preflight 拒绝 tracked 文件的未提交更改，并要求 entry 和静态清单已被跟踪，但不会校验产品读取的其他未跟踪文件或构成 OS 安全沙箱。
