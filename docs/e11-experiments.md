# 本地实验记录

复制 `experiments/feedback.template.json` 为本地文件，填写假设、需求 ID、基线与候选 run ID 和预期变更。此记录用于说明实验，不替代 `--experiment` 使用的 adapter 配置，也不需要服务端或数据库。每个 run ID 必须与实际生成的 run 一致；记录本身不会启动 adapter 或调用模型。

比较时使用 `pnpm eval compare <baseline-run-id> <candidate-run-id> --experiment-record <文件> --runs-dir <目录>`（如有受控变量，再指定 `--vary`）。比较报告会保留记录和对照证据；结论仍以兼容性检查及实际运行结果为准，预期变更不是结果。
