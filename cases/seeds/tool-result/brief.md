# 工具参数与结果使用

Requirement: REQ-E6a-tool-result

使用本地 tool_fixture 模拟 quote 工具：以 request 的 sku、currency 为完整参数，恰好查询一次并记录真实 fixture result 到 trace.json.calls。根据返回 unit_price_cents 乘 quantity，写 order.json（quote_id、quantity、currency、total_cents）。只允许 quote，不执行下单。

固定任务资料位于 initial-state.json；fixture.json 仅为公开 stub 占位响应，不是 Gold。

证据：trace.json, order.json。每个硬断言关联独立产物字段；错误对照仅用于 E5b 校准，不是 E6b 负例 case。

人工 reviewed 尚未授予；不接入正式 suite。
