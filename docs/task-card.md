# 任务卡

一张卡记录一次真实任务：当时的需求原文、从哪个提交开始、后来有没有合入。重放从 `base_commit` 起步。卡里没有 gold，也没有期望输出。

主文件是 `tasks/<id>/card.yaml`。`<id>` 只含字母、数字、`_`、`-`，并且和卡里的 `id` 相同。JSON 只是可选导出，用来互换，不是另一套主格式。录入、列出、查看和校验走下面的 CLI，校验规则仍是 `packages/core` 的库 API。

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
| `status: path` 加 `path` | 指向工作区外的 verify 入口。重放不执行它。`pnpm eval verify` 才跑钉死版本 |
| `status: todo` 加 `reason` | 以后再补 |
| `status: unavailable` 加 `reason` | 当时拿不到 |

没有 verify 时，scoring 可以是 unavailable，这不是 fail。重放本身不算分，也不要求目标仓创建 verify。判分见 [verify.md](verify.md)。

## 插手

没有历史时写 `status: unknown`。不得把缺失的插手写成 `0`，也不得写 `count`。`count: 0` 会被校验拒绝。

`status: none` 表示有人确认过：这次没有插手。确认过的插手写成 `records`，每条有 `id` 和 `summary`。不要用记录条数代替状态。

返工轮和未确认候选的口径、去重键、provenance 见 [marks.md](marks.md)。没有返工历史时基线同样是 `unknown`，不是 0。`private.candidates` 里的 fixup/review 在勾选确认之前不计入基线。

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

## CLI

`pnpm eval task` 挂在 R1 的入口上。它录入、检查，也从已合 PR 导入，并用 `mark` 确认插手和返工。

```sh
pnpm eval task --help
pnpm eval task add
pnpm eval task list
pnpm eval task show <id>
pnpm eval task validate [id]
pnpm eval task import --pr <owner/repo#N>
pnpm eval task import --origin <owner/repo#N>
pnpm eval task import --from-file <export.json>
pnpm eval task mark <id>
```

## 从已合 PR 导入

`import` 读一张已合 PR，先给出候选，确认之后才写 `tasks/<id>/card.yaml`。第一条路径是 Cursor Origin，只跑 `origin repo view` 和 `origin pr view`。GitHub 只是可选对照，读不到也不阻塞。Origin 没登录、离线，或命令不存在时，用 `--from-file` 读已经导出的 JSON 或 markdown。错误会写明原因，并且不会留下半截 `card.yaml`。

PR 描述和 PR base SHA 只是候选。它们不是用户原话，也不是任务真正的起始 commit。提示里选 `accept` 才会抄进卡；否则这两项保持 `todo`，原因里写明候选没有被当成起点。评审和 fixup 只作为未确认候选记在 `private.candidates` 和 `sources`。`interventions` 保持 `todo` 或 `unknown`，不会写成记录，也不会写成 0。`task mark` 确认之后才进入基线。base 分支不是仓库默认分支，或 PR 在 stack 里时，命令只提示，不拆、不并。缺 verify 写成 `none` 或 `todo`，仍然建卡。

批量时每条单独确认。`reject` 和 `skip` 不写这一条。前面确认过的可以留下。某一条读取或写入失败，不会把那一条写成半个文件。

`--from-file` 接受三种 JSON：单个对象、数组，或 `{ "items": [ ... ] }`。对象可以是下面这种导出，也可以是 `origin pr view --json` 或 `gh pr view --json` 的原文（缺 `repo` 时加 `--repo owner/name`）。

```json
{
  "host": "origin",
  "repo": "owner/name",
  "default_branch": "main",
  "verify": "none",
  "number": 8,
  "url": "https://cursor.com/codebase/owner/name/pull/8",
  "base_ref": "main",
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "requirement_candidates": [
    { "kind": "linked_issue", "ref": "https://example.test/issue", "text": "当时的需求原文候选。" }
  ],
  "comments": [
    { "kind": "review", "body": "未确认的评审意见。" }
  ]
}
```

markdown 用 front matter 写同样的字段。`## requirement candidate`、`## review`、`## fixup` 是候选，不会被静默当成起点。

`mark` 读取本地聊天导出或 PR 评审文件，也可以确认卡上已有的候选。类型由人选择：`插手` 或 `返工`。没选的行保持未确认，基线不变。没有历史时基线是 `unknown`，不是 0。同一文件再读一次不会多出条目。不需要 verify。chat-only 可以不写 PR。用法见 [marks.md](marks.md)。

`add` 按字段提问，几分钟内能写完。需求原文可以多行输入（单独一行 `.` 结束）、从文件读，或从剪贴板读。可以存成 draft。需求原文、仓库、base commit 都是具体值时才接受 `replay-ready`；否则改存 draft，并要求写出原因。成功时打印 `tasks/<id>/card.yaml` 的路径。

`list` 打印制表符分隔的表：`id`、`status`、`base`、`intervention`、`verify`、`missing_required`。`base` 是 7 位短 SHA，或者缺口状态。插手没有历史时是 `unknown`，不是 0。`verify` 列是路径、`none` 或 `missing`。文件里没写 verify 时显示 `missing`，写了 `none` 时显示 `none`。这两种都不是 error。`status` 一列区分 draft 和 replay-ready。`missing_required` 是需求原文、仓库、base commit 里还不是具体值的个数。

`show` 把 `none`、`todo`、`unknown`、`N/A`、`unavailable` 标成 `status`。只有 schema 问题才标 `error`。base 是缺口时，存在性是 `N/A`。离线或没有对应的本地仓库时，存在性是 `unavailable`，不是 error。

`validate` 逐字段打印结果。SHA 格式在本地检查，不访问 git。`--offline`，或没有和卡片 `repo.id` 对应的本地 checkout 时，存在性是 `unavailable`，退出码是 0。删掉 base SHA、SHA 格式不对，或在线检查时 commit 不在给出的仓库里，退出码非 0。缺 verify 不会失败。verify 写成非法状态才会失败。

`--root <dir>` 指定仓库根，卡片写到 `<dir>/tasks`。`--repo-dir <dir>` 指定用来查 commit 的本地 checkout。命令自己的参数写在 `task` 后面；`pnpm eval --help` 仍是壳的帮助。

## 不做

gold、期望输出、判分、强制创建 verify、数据库、Web UI、对 Origin 或 GitHub 写操作、自动判定插手。插手和返工的确认见 [marks.md](marks.md)。导入只读。重放见 [replay.md](replay.md)。
