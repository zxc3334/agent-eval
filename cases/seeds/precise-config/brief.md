# 精确配置修改

Requirement: REQ-E6a-precise-config

将 initial_state.config.retry.max_attempts 改为 request.max_attempts。写 config.json，保留其他全部字段和值，不添加字段、不重建默认配置。

固定任务资料位于 initial-state.json；fixture.json 仅为公开 stub 占位响应，不是 Gold。

证据：config.json。每个硬断言关联独立产物字段；错误对照仅用于 E5b 校准，不是 E6b 负例 case。

人工 reviewed 尚未授予；不接入正式 suite。
