# 仓库布局

本页说明 agent-eval 的单仓三线骨架。读完应能判断新代码放哪、谁可以依赖谁。本波只实施 skill 线。

## 目录

```text
agent-eval/
  packages/core/     薄底座：跑次目录、预留的证据钩子、CLI 壳、配置原语
  tracks/skill/      当前唯一实施线（本波只有 noop 命令）
  tracks/agent/      占位 README，不实现
  tracks/model/      占位 README，不实现
  tasks/             真实任务卡目录（本票不定义卡格式）
  runs/              跑次产物，已 gitignore（保留 .gitkeep）
  src/cli.ts         已有 M0 冒烟入口（E0–E2）
  src/eval.ts        本波 CLI 壳的挂载入口
  cases/             M0 协议样例
```

`packages/core` 提供四块薄能力，都不跑评测：

- 跑次目录：`createRunDir` 在 `runs/` 下建 `<时间戳-uuid>/`，沿用 M0 的目录名形状，不写证据文件。
- 证据钩子：`EvidenceHook` 类型已留出。`reservedEvidenceHooks()` 返回空列表。本票不落成绩、指标或 verify。
- CLI 壳：`runCli` 解析参数、打印帮助、按名字调用已挂载命令。
- 配置原语：标识符校验、`tasks/` 与 `runs/` 路径、原子 JSON 写入。标识符规则和原子写文件与 M0 相同，底座不引用 M0 的 case 加载器。

## 三条线

| 线 | 路径 | 本波 |
| --- | --- | --- |
| skill | `tracks/skill` | 实施。评的是用某个 skill / 配置做自己的真实任务时，是否更少插手、更少返工 |
| agent | `tracks/agent` | 不实施、不拆票。产品 agent 闭环的位置 |
| model | `tracks/model` | 不实施、不拆票。模型能力题的位置 |

共用底座在 `packages/core`。以后结构、采集、格式、CLI 落在 core；重放、可选 verify、指标、对比落在 `tracks/skill`。这些都不在本票。

## 依赖规则

允许：

- `tracks/skill` 依赖 `packages/core`
- 仓库根入口 `src/eval.ts` 引用 core 的 CLI 壳，并只挂上 skill track

`packages/core` 与 `tracks/skill` 的包入口写在各自 `package.json` 的 `exports`。本仓没有编译步骤，运行时和 M0 一样直接引用 `.ts` 相对路径。

不允许：

- `packages/core` import 任何 track。track 由根入口挂载，不写进底座
- `tracks/agent`、`tracks/model` import `tracks/skill` 或 `@agent-eval/skill`
- `tracks/skill` import `tracks/agent` 或 `tracks/model`

agent 与 model 本波没有 `package.json`，也没有 TypeScript。占位目录里只有 README，因此没有可执行的 import。不要为了先占一个包名给它们加依赖。

## CLI

```sh
pnpm install
pnpm eval --help
pnpm eval noop
```

`pnpm eval` 进入薄壳：没有子命令时打印帮助；`noop` 是 skill track 注册的空命令，退出码 0，输出 `skill noop: ok`。这证明壳能挂载 track。

M0 本地冒烟仍走原来的入口：

```sh
pnpm eval:m0 --suite smoke --agent stub
pnpm eval:m0 --help
```

`--suite`、`report` 等 M0 参数不属于这层壳。传给 `pnpm eval` 会报未知参数，并提示改用 `pnpm eval:m0`。

## runs/

克隆之后 `runs/` 存在。跑次产物匹配 `runs/*`，被 git 忽略；`runs/.gitkeep` 保留在版本库里。本票的 `noop` 和 `--help` 不创建跑次。

## 本波不做

任务卡格式、导入、插手标记、重放、verify、指标、对比、本地 Web、gold。不要求目标仓创建 verify skill。

E0–E2 留在 `src/` 与 `cases/`。本票没有把 `feat/e11` 整包合并进来，也没有搬迁冒烟运行器。后续票再按需把可复用模块迁进 core 或 skill。
