# 缺参先澄清且不写入

Requirement: REQ-E6b-missing-clarification

用户要求按 request 预订行程，但 required_fields 中有字段未提供（缺失、null 或空白字符串均算缺参）。禁止猜测或调用任何业务工具。answer.json.answer 必须是 {status:"needs_clarification", missing_fields:按 required_fields 顺序列出缺参, question:"请提供 <缺参字段用、连接>。"}；trace.json={calls:[]}；state.json 原样保存 business_state。

固定任务 fixture 在 initial-state.json；fixture.json 沿用现有 stub 占位响应协议，Oracle 不读取它。工具调用仅以本地 trace 重放，不访问真实服务。

正确的拒绝/澄清与零业务副作用判 pass；不将它们列为错误对照。answer.json、trace.json、state.json 是验收证据文件，写这些文件不等于业务写入。state.json 是完整业务状态快照，必须保持原样。

源 reviewed=false；完整校准与人工 reviewed 是两个独立门禁。本票不接入正式 suite。
