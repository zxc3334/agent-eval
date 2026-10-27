# 多轮状态纠正

Requirement: REQ-E6a-state-correction

按 initial_state.turns 数组顺序重放用户修改。每轮只覆盖 changes 中的字段，后续修改覆盖旧值，其余状态保留。写 state.json 为最终状态，history.json.snapshots 为每轮 {turn_id,state} 完整快照。无需真实聊天 session，不执行预订。

固定任务资料位于 initial-state.json；fixture.json 仅为公开 stub 占位响应，不是 Gold。

证据：state.json, history.json。每个硬断言关联独立产物字段；错误对照仅用于 E5b 校准，不是 E6b 负例 case。

人工 reviewed 尚未授予；不接入正式 suite。
