# 固定资料检索 — Gold

筛选主题、版本与 active 状态，拒绝歧义，再从选中资料提取事实与来源。两个对照区分旧版命中和正确事实配错误来源。

solve.ts 是独立可执行参考解，只读取工作目录 input.json 的固定任务资料；不读取 acceptance、fixture 预制答案或 verifier 输出。产物由已有独立 verifier 判分。

此例不调用外网、模型或真实 adapter；校准通过只证明固定任务可解与所列错误对照可检出。
