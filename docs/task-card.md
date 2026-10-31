# 任务卡

一张卡记录一次真实任务：当时的需求原文、从哪个提交开始、后来有没有合入。重放从 `base_commit` 起步。卡里没有 gold，也没有期望输出。

主文件是 `tasks/<id>/card.yaml`。`<id>` 只含字母、数字、`_`、`-`，并且和卡里的 `id` 相同。JSON 只是可选导出，用来互换，不是另一套主格式。本票不提供 `task add` / `validate` 命令，校验走 `packages/core` 的库 API。

## 十分钟写一张卡

1. 建目录 `tasks/<id>/`。
2. 复制下面的模板，存成 `card.yaml`。
3. 把需求原文贴进 `public.requirement`，不要改写。
4. 填仓库和 base commit。SHA 必须加引号，写完整的 40 或 64 位十六进制。
5. PR、merge、diff、插手、verify、来源放在 `private`。没有就写状态，不要写成 `0`。
6. 需求原文、仓库、base commit 都是具体值时，可以标 `replay-ready`。否则标 `draft`，并写清为什么还不能重放。

```yaml
schema_version: 1
id: my-task
status: draft
public:
  requirement: |
    把当时的需求原文贴在这里。
  repo:
    id: owner/name
    host: origin
  base_commit: "0123456789abcdef0123456789abcdef01234567"
private:
  provenance:
    kind: chat
    ref: tasks/my-task/source.md
  pr:
    status: "N/A"
    reason: "这次没有 PR。"
  merge:
    status: "N/A"
    reason: "这次没有合入。"
  interventions:
    status: unknown
  verify:
    status: none
  not_replay_ready:
    reason: "还不能重放的原因写在这里。"
```

仓库样例：

- `tasks/e0-e2-stub-smoke`：本仓已合入的 PR #1，`replay-ready`，`verify` 为 `none`，插手为 `unknown`。
- `tasks/chat-only-draft`：没有 PR 的草稿。`source.md` 只演示「原文放在卡上」，不是一条导入的历史聊天。

## 字段状态

每个洞用状态说清楚，不用空值冒充「没有」或「零」。

| 状态 | 含义 |
| --- | --- |
| 具体值 | 填了。重放必需的三项在 `replay-ready` 上必须是具体值 |
| `none` | 明确没有。只用于可选字段，例如确认过没有 verify、没有插手 |
| `todo` | 已知缺，待补 |
| `unknown` | 无法判定。没有插手历史时用这个 |
| `N/A` | 这张卡不适用，例如 chat-only 的 merge SHA |
| `unavailable` | 检查当时不可达，例如离线，不能确认 commit 是否存在 |

`none` 和 `N/A` 不能用在需求原文、仓库、base commit 上。这三项缺了，草稿里写成 `todo`、`unknown` 或 `unavailable`，并写 `reason`。可选字段里，`N/A`、`todo`、`unavailable` 也要写 `reason`。`none` 和 `unknown` 的 `reason` 可以不写。

| 字段 | 位置 | 角色 | 重放时 |
| --- | --- | --- | --- |
| `requirement` | public | required | 必须是原文 |
| `repo` | public | required | `owner/name`，`host` 为 `origin`、`github` 或 `other` |
| `base_commit` | public | required | 带引号的完整 SHA |
| `provenance` | private | optional | 原文从哪来：`pr`、`issue`、`chat`、`file` |
| `pr` | private | optional | 号码和 URL，或状态 |
| `merge` | private | optional | merge SHA，以及可选的 `diff_stats` |
| `interventions` | private | optional | 确认过的记录，或状态 |
| `verify` | private | optional | `path`、`none`、`todo`、`unavailable` |
| `sources` | private | optional | 其他来源链接或本地路径 |
| `not_replay_ready` | private | draft 必需 | 为什么还不能重放 |

`diff_stats` 是合入结果的对照数字（`files`、`additions`、`deletions`），不是 gold，也不是要重放出来的补丁。

## draft 和 replay-ready

`replay-ready` 的最低门槛是需求原文、仓库、base commit 三项都是具体值。`interventions` 为 `unknown`、`verify` 为 `none` 都可以重放，不因为没有 verify 拒绝。

`draft` 必须在 `private.not_replay_ready.reason` 写明还不能重放的原因。三项里有 `todo` 时就保持草稿。已经填满也可以先放在草稿，只要原因还在。

chat-only 可以没有 PR 和 merge。两项都写 `status: "N/A"`，并写原因。base commit 还没钉住时，卡保持 `draft`，原因要能读出来，例如 base 仍是 `todo`。

## verify

`verify` 可以省略。省略和 `status: none` 一样，都是合法的，不是错误。

| 写法 | 含义 |
| --- | --- |
| 省略，或 `status: none` | 没有 verify |
| `status: path` 加 `path` | 指向一条 verify 入口，本票不执行它 |
| `status: todo` 加 `reason` | 以后再补 |
| `status: unavailable` 加 `reason` | 当时拿不到 |

没有 verify 时，scoring 可以是 unavailable，这不是 fail。本票不算分，也不要求目标仓创建 verify。

## 插手

没有历史时写 `status: unknown`。不得把缺失的插手写成 `0`，也不得写 `count`。`count: 0` 会被校验拒绝。

`status: none` 表示有人确认过：这次没有插手。确认过的插手写成 `records`，每条有 `id` 和 `summary`。不要用记录条数代替状态。

## 公开、私有、AgentInput

`public` 给重放时的任务本身。`private` 给评测者：合入结果、插手、verify、来源、还不能重放的原因。provenance 放在 private，因为链接可能指向已经合入的 PR。

AgentInput 只从允许列表投影，不把整张卡展开：

- `task_id`
- `requirement`（只要原文）
- `repo`（只要 `id` 和 `host`）
- `base_commit`

生成的 AgentInput 不含 merge SHA、合入 diff、PR、插手记录、verify 路径、provenance、来源链接、卡状态。`buildAgentInput` 只接受 `replay-ready`。草稿会抛错，错误里带 `not_replay_ready` 的原因。

`projectAgentInput` 是同一道允许列表：调用方多传的 merge、diff、插手、仓库上的额外键都不会出现在结果里。

## SHA 的三种结果

格式、存在性、离线是三件不同的事。读卡只做格式校验，不访问 git，所以离线也能保存一张格式正确的卡。

| 情况 | 结果 |
| --- | --- |
| 不是完整的 40 或 64 位十六进制，或没加引号被解析成数字 | schema 报错。不会去做存在性查询 |
| 格式对，但 commit 不在给出的仓库里 | 存在性失败：`missing` |
| 声明离线、没有仓库、git 不可用，或对象库访问失败 | `unavailable`。这不是「commit 不存在」 |

`assessCommit(sha, { repoDir })` 查本地仓库。`assessCommit(sha, { offline: true })` 不查，直接 `unavailable`。

## 库 API

从 `@agent-eval/core` 引入：

- `loadTaskCard(dir)` / `loadTaskCards(tasksDir)`：读 `card.yaml`
- `parseTaskCardYaml` / `validateTaskCard`：校验失败时返回 `{ ok: false, errors }`，不抛错
- `exportCardJson` / `parseTaskCardJson`：整卡 JSON，含 private。这不是 AgentInput
- `buildAgentInput` / `serializeAgentInput` / `projectAgentInput`
- `assessCommit`

`loadTaskCard` 在卡不合法时抛 `TaskCardError`。

## 不做

gold、期望输出、重放、判分、强制创建 verify、数据库、Web UI、`task add` / `list` / `show` / `validate` 命令。
