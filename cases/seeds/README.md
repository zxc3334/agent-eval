# E6a：五条正例种子

本目录保存 E6a 原始 case；E6c 的 `e6-smoke` / `e6-full` 清单通过 source 引用复用它们。每例都有独立 requirement_id、brief、公开任务数据、stub fixture、可执行 Gold、硬断言和错误对照。`fixture.json` 是 stub 占位响应，任务的固定资料在 `initial-state.json`；Oracle 不读取 fixture 或 acceptance。

| Case | 验证目标 | 产物 | 错误对照数 |
| --- | --- | --- | --- |
| fixed-retrieval | 主题、版本、来源与事实一致 | retrieval.json | 2 |
| tool-result | 精确参数、记录返回值、据返回值计算金额 | trace.json、order.json | 2 |
| precise-config | 唯一目标修改、其他字段完整保留 | config.json | 2 |
| bounded-recovery | 暂时错误重试、成功即停、最多两次、保存一次 | trace.json、recovery.json | 3 |
| state-correction | 顺序应用纠正、每轮快照、保留无关状态 | history.json、state.json | 3 |

从仓库根目录执行：

```sh
pnpm validate:e6a
pnpm typecheck
pnpm test
```

`validate:e6a` 在 `_codex_out/e6a-validation/check-*/cases/e6a/` 创建独立副本和临时清单，实际运行 `pnpm eval validate --suite e6a --cases-dir <副本> --runs-dir <证据目录>`。它打印可直接重跑的完整命令，保留五例 `.calibration.json`、每个 Oracle/错误对照的独立 artifacts/verifier 证据及汇总报告。预期可解性 5/5、检出 12/12、退出 0。可用 `pnpm validate:e6a /tmp/e6a-checks` 指定输出父目录。

源文件保持 `reviewed: false`，校准不冒充人工审核。集成测试验证正式 suite 在未审核时拒绝启动，在临时副本模拟审核后可以运行，内容修改后再次拒绝。E6c 接线是 `formal: false` 的本地链路检查；如需晋升正式 suite，仍需人工查看证据、确认 reviewed 和有效校准凭证。临时副本的凭证绑定其内容；不要把旧凭证当作修改后的审核依据。

所有工具返回值和多轮消息都是离线固定数据。trace 是参考解/adapter 声明的执行记录，不证明真实服务调用；多轮用例重放本地消息，不验证真实聊天会话。错误对照是 E5b 校准数据，不新增 E6b 负例。`max_steps` 仍是现有协议元数据；有界恢复通过精确 trace 硬断言检验。
