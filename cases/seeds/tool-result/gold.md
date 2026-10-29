# 工具参数与结果使用 — Gold

本地确定性 quote fixture 取代服务调用。记录请求与返回值，然后计算金额；参数错误与忽略返回值分别作为对照。

solve.ts 是独立可执行参考解，只读取工作目录 input.json 的固定任务资料；不读取 acceptance、fixture 预制答案或 verifier 输出。产物由已有独立 verifier 判分。

此例不调用外网、模型或真实 adapter；校准通过只证明固定任务可解与所列错误对照可检出。
