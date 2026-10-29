# Gold: verifier_error

## 参考行为

从固定空初态执行参考解，写出 answer.json，answer 为 hello。现有 smoke/faults 的验收目标是 hello；错误 fixture 是 stub 的负向对照，参考解不复制 fixture。

本例用于 harness 故障回归：agent_error / protocol_error / timeout 是 stub 专属故障注入，Oracle 不执行 stub，因此这三例可通过。environment_error 仍在准备阶段失败；verifier_error 仍由同一 verifier 报错。Oracle 不绕过这些错误。

## 执行与证据

`pnpm eval --suite faults --case verifier_error --agent oracle`

本目录的 solve.ts 为独立可执行参考解，只使用 Node 内置 I/O。runner 将固定输入和源码快照保存到每次运行的 oracle/，在全新 workspace/ 中执行，然后将白名单输出复制到 artifacts/，交给普通运行使用的同一 verifier；判定与证据保存在 verifier/ 和 result.json。

参考解不读取 acceptance.json、gold.answer 或 criteria，不导入 verifier 的字段选择、工具参数比较或判分实现。success 仅是输出协议，不代表通过。Gold 文档不参与判分；reviewed 保持原值，本票不增加审核门禁。
