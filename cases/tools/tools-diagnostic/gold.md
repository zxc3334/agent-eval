# Gold: tools-diagnostic

## 参考行为

从 initial_state 读取 owner，记录一次 search({query: "alpha"}) 到 trace.json。该记录不含写操作，也不会重复副作用。它是本地结构化参考动作的产物，不调用真实工具。

即使此例的 stub fixture 故意错误，参考解仍生成正确的任务产物；Oracle 的通过不能说明 stub 或真实 agent 已通过。

## 执行与证据

`pnpm eval --suite tools --case tools-diagnostic --agent oracle`

本目录的 solve.ts 为独立可执行参考解，只使用 Node 内置 I/O。runner 将固定输入和源码快照保存到每次运行的 oracle/，在全新 workspace/ 中执行，然后将白名单输出复制到 artifacts/，交给普通运行使用的同一 verifier；判定与证据保存在 verifier/ 和 result.json。

参考解不读取 acceptance.json、gold.answer 或 criteria，不导入 verifier 的字段选择、工具参数比较或判分实现。success 仅是输出协议，不代表通过。Gold 文档不参与判分；reviewed 保持原值，本票不增加审核门禁。
