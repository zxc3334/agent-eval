# 多轮状态纠正 — Gold

按顺序对状态应用显式 changes，并深复制每轮快照，避免历史引用被后续修改污染。对照覆盖旧状态回流、快照别名与无关偏好丢失。

solve.ts 是独立可执行参考解，只读取工作目录 input.json 的固定任务资料；不读取 acceptance、fixture 预制答案或 verifier 输出。产物由已有独立 verifier 判分。

此例不调用外网、模型或真实 adapter；校准通过只证明固定任务可解与所列错误对照可检出。
