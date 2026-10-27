# 有界错误恢复 — Gold

循环受 max_attempts 限制，仅暂时错误继续；成功 break 后保存一次。第三条响应是停止条件诱饵。有界性由完整 trace 硬断言检验，不依赖目前只作元数据的 max_steps；工具记录不是外部副作用证明。

solve.ts 是独立可执行参考解，只读取工作目录 input.json 的固定任务资料；不读取 acceptance、fixture 预制答案或 verifier 输出。产物由已有独立 verifier 判分。

此例不调用外网、模型或真实 adapter；校准通过只证明固定任务可解与所列错误对照可检出。
