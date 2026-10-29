# 有界错误恢复

Requirement: REQ-E6a-bounded-recovery

按顺序消费 initial_state.responses 作为 fetch_job 的本地返回值，用 request.job_id 查询。仅 transient_error 可重试，最多 request.max_attempts 次，成功即停止；成功后恰好记录一次 save_receipt。写 trace.json.calls（每次 fetch 的 arguments 和 result，save 的 arguments）和 recovery.json（status=recovered、attempts、receipt）。不得消费第三个响应。

固定任务资料位于 initial-state.json；fixture.json 仅为公开 stub 占位响应，不是 Gold。

证据：trace.json, recovery.json。每个硬断言关联独立产物字段；错误对照仅用于 E5b 校准，不是 E6b 负例 case。

人工 reviewed 尚未授予；不接入正式 suite。
