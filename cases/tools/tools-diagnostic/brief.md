# REQ-E4c / tools-diagnostic

需求：检查工具参数、禁写及重复副作用，复用 E4a 证据协议和 E4b 字段保留。

证据：trace.json 的 /calls；owner 字段应保持 Ada。stub 只写静态记录，不调用真实工具。

预期：pass（参数仅作 diagnostic）。tools-duplicate 的禁写检查仅作 diagnostic，以独立展示重复副作用 hard gate。
