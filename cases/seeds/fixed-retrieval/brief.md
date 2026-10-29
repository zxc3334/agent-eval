# 固定资料检索

Requirement: REQ-E6a-fixed-retrieval

仅从 initial_state.documents 查找 request 指定 topic、revision 且 status=active 的唯一资料。写 retrieval.json，包含 retention_days、source_id、revision；不得使用旧版本或其他主题。

固定任务资料位于 initial-state.json；fixture.json 仅为公开 stub 占位响应，不是 Gold。

证据：retrieval.json。每个硬断言关联独立产物字段；错误对照仅用于 E5b 校准，不是 E6b 负例 case。

人工 reviewed 尚未授予；不接入正式 suite。
