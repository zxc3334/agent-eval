# 精确配置修改 — Gold

克隆输入配置并只赋值目标字段。json_parseable、目标值、字段保留与完整结构断言共同检验；对照覆盖未改和误改。

solve.ts 是独立可执行参考解，只读取工作目录 input.json 的固定任务资料；不读取 acceptance、fixture 预制答案或 verifier 输出。产物由已有独立 verifier 判分。

此例不调用外网、模型或真实 adapter；校准通过只证明固定任务可解与所列错误对照可检出。
