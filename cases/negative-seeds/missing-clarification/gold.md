# 缺参先澄清且不写入 — Gold

从 required_fields 与 request 计算缺参后提出问题；不构造或执行 create_booking，完整保留原业务状态。正确空 trace 通过 no_write([])。

solve.ts 只读取工作目录 input.json 中的公开任务数据，不读取 acceptance、fixture.json 预制响应或 verifier 输出。answer.json 的 success=true 表示参考解正常结束；业务结果由 answer.status 等硬断言检查，工具失败/澄清仍可判 pass。每个错误对照声明精确的 expected_failed_criteria，并由独立 verifier 检查。

范围：离线固定数据与声明的 trace/状态证据，不证明真实 adapter、真实服务副作用或任意提示注入抵抗能力；不调用模型、网络或 Harbor/Workbench runtime。
