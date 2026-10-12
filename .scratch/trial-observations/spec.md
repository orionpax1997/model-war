# 试跑观测落盘：让「无得分来源」留痕进得去 gen 的记录

来源：`/tmp/model-war-handoff-2026-10-12-score-source-done.md` 的「已知缺口」第一条
（`.scratch/score-source-observe/spec.md` 留档的那一条）。前置票已提交 `f98d962`。

## 问题

`packages/gen/src/trial.ts` 只消费 stdout 与退出码，试跑入口的 stderr 被 `spawnSync` 收下后丢弃。
于是「无得分来源」的留痕只活在跑入口那个终端的滚动缓冲里：**攒不到数据、统计不了命中率**，
而「观察一两轮 gen 的实际表现、据此裁决要不要升级为 verdict / 回喂」这条路被它卡住。

## 判据（C1）

`archive/<modelSlug>/observed-<runId>.jsonl` 落在盘上，一行一场，四栏
`{ matchIndex, delivered, captures, noScoreSource }`，内容恒等于**最后一次跑完**的试跑调用
（定结论的那一次）。某次调用中途 infra（两场作废等）时它不写，**上一次跑完的读数留在盘上**。
与存档目录、失败记录同层。

## 决定（已裁，2026-10-12 与用户对齐）

- **落法：旁挂文件**。不进 `meta.json`（十一键一次定死，加字段波及已冻结的每一份 meta），
  不进 `<runId>/`（三件套是装载期判完整性的不变量），与 `failed-<runId>.json` 并列——后者已确立
  「旁挂文件与存档同层」的先例，报告侧那条 `failed-` 前缀 + `.json` 的过滤器也天然扫不到新前缀。
- **结构化由入口写，gen 不解析文本**：入口多认一个 gen 私有参数 `--observations <路径>`，
  路径真源在 `packages/gen/src/observations.ts`，封装逐字转发。**不**走「`TrialResult` 带 stderr、
  gen 解析中文留痕行」那条路——解析文案是「改一句措辞就静默读不到数」的那种脆。
  `TrialResult` 形状因此**不变**（观测是旁证，回喂与记账都用不着它）。
- **每场都写，命中与否都写**（与对齐时的表述有一处修正，见下）：命中的读数**恒为** 0/0
  （那正是 C1 的定义），只记命中等于记下一堆 0/0——既算不出命中率的分母，也答不了「差多少」。
- **被拦下的候选同样落**：旁证不挑结论。实现上不因此多一条分支——入口与「放行」走同一条落盘路径。
- **写盘失败只在 stderr 留一行警告**：不改退出码、不改 verdict、不进回喂。没给 `--observations`
  时一个字都不写（手工冒烟与旧脚本按原样跑）。没有读数时一个字节都不写，也不创建文件。
- 行的形状与文件名前缀**暂不进 `@model-war/schema`**：目前没有跨进程读者。前缀同理不搬——
  `FAILURE_RECORD_PREFIX` 住真源包是因为报告侧要按它挑文件；观测前缀眼下只有 gen 自己用。
  形状与前缀随报告侧第一次真读它时一起裁决。
- **`splitArgs`（全 CLI 共用）登记了这个带值 flag**：本格只回答「带值的 flag 怎么摘」，
  谁生效由各子命令自己决定——于是 `match --observations x` 只是把值摘走、不生效（与
  `--root` 出现在试跑入口里同理）。顺带把一条漏洞补上：**值以 `-` 开头时按缺值处理**
  （否则 `--observations --root /x` 会把 `--root` 吃掉，真根落进位置参数，就是头注描述的那次事故）。
- `TrialProbe` 的入参多一个必填字段 `observationsPath`（缝的形状变了）；`TrialResult` 不变。
- 代价（对齐时未展开）：**每个跑过试跑的候选都会多留一个文件**（含健康候选），`archive/<slug>/`
  下从「一个目录」变成「目录 + 一份旁挂」。这是攒数据付的账，量级是一模型一份、每次 gen 运行重写。

### 与对齐时表述的差异（一处，读档的人需要知道）

对齐时「观测行要不要带读数」的推荐是「带」。落地时发现**命中那一行的读数必然是 0/0**，
把它写进人话留痕行等于写了两个恒定的 0。真正有信息量的做法是**逐场记读数**（未命中场也记），
所以本票把「带读数」落实成「记每场的读数」，stderr 那行人话文案一字未改（仍命中才写、仍不含读数）。
**「每场都写」是本票自己加的取舍**，对齐时没有逐条确认过——用户对「都按建议」的答复覆盖的是落法、
结构化在哪一侧、要不要带读数、失败候选要不要写；逐场记录是落地读代码时才发现更省事的做法，
代价写在上面的「代价」一条里。

## 验收

- `observationsPathOf`（`packages/gen/src/observations.ts`）：纯路径计算，不建目录不落盘；
  与 `failed-` 前缀 + `.json` 后缀各错开一个，报告侧的过滤器扫不到。`observations.test.ts` 覆盖。
- `runTrialScript`：`--observations <路径>` 逐字转发，不 resolve、不改写、不自造路径；
  argv 断言覆盖到顺序。`trial.test.ts` 覆盖。
- `generateOneModel`：每模型一份观测路径，逐轮透传给试跑探针。`pipeline.test.ts` 覆盖。
- `trialObservationLines` / `writeTrialObservations`（`apps/cli/src/trial/observations.ts`）：
  每场一行、键序固定、无多余键、空读数不落文件、整份重写、每行一个 JSON 且末尾换行、
  写盘失败收成 `ok:false` 不抛。`observations.test.ts` 覆盖。
- `splitArgs`：`--observations <值>` 与 `--root <值>` 同形摘取，互不串味，缺值即不给，
  值以 `-` 开头也按缺值处理。新增 `apps/cli/src/args.test.ts` 覆盖（此前无单测）。
- 入口 `run-trial-script.ts`：三场跑完后由 `main` 落盘（跑三场的那一格只跑与收，不做输出副作用）；
  早停时行数 = 跑过的场数；写盘失败只 stderr 警告；`USAGE` 与头注一致。
- **接线 e2e**（`apps/cli/src/gen-cli.test.ts`，真 VM + 真引擎 + 真子进程）：
  放行路径下 `archive/alpha/` = 存档目录 + `observed-<runId>.jsonl`（三行，`matchIndex` 0/1/2）；
  被拦路径下 = `failed-<runId>.json` + `observed-<runId>.jsonl`（一行，早停；runId 与失败记录同源）。
- 文档：hld §7.4 加观测文件那一条，并把「`archive/` 只收已通过校验的冻结脚本」改准（存档**目录**
  才收，旁挂记录不算存档）；CONTEXT《无得分来源》词条只说「留一份逐场读数」并把落盘点指向 hld；
  `archive.ts` 头注声明旁挂文件不归它；`score-source.ts` 头注的「只进 stderr」同步改掉。

## 已执行的验证（读数留档）

- **接线变异检查**（改生产代码看测试是否变红）：
  ① 删掉 `packages/gen/src/trial.ts` argv 里的 `--observations` 两项 → `trial.test.ts` **2 红**，
     `gen-cli.test.ts` **2 红**（e2e 真打一次子进程，读不到文件）；还原后全绿。
  ② 从 `trialObservationLines` 的渲染里删掉 `captures` 一栏 → `observations.test.ts` **2 红**；还原后全绿。
  ③ 新写的头注里提到报告侧包名 `runner`（注释也算） → `no-match-result-symbols.test.ts` **红**；
     改成不带包名的说法后绿。这条不是人为设计，是那两条禁令的纪律：注释里也不许出现跨包边。
- 单测：`packages/gen/src/{observations,trial,pipeline}.test.ts`、`apps/cli/src/args.test.ts`、
  `apps/cli/src/trial/observations.test.ts` 全绿。
- e2e：`apps/cli/src/gen-cli.test.ts` 2/2 绿。
- `tsc -b` 无错；`pnpm run check:quick` 通过；`pnpm run verify:fast` 通过。

## review 后的修正（双轴 review，各条都落到了哪里）

- **Standards 硬性违规 4 条**：全部已修——`score-source.ts` 头注同步；hld §7.4 那句
  「`archive/` 只收已通过校验的冻结脚本」改准为「存档**目录**只收」（旁挂记录不算存档）；
  前缀与形状不进真源包的理由在 `observations.ts` 头注写清（没有跨包读者就不占真源包的地）；
  `splitArgs` 登记 flag + 补上「值以 `-` 开头按缺值处理」+ `USAGE` 同步。
- **Standards 判断题**：`runThreeMatches` 不再做输出副作用（写盘上提到 `main`）；`Mysterious Name`
  （`observations` 路径 vs `observation` 文案）改名为 `observationsPath`；
  `OBSERVATIONS_FILE_PREFIX` 撤出 `index.ts` 导出面（包外无消费者）；`gen-cli.test.ts` 里那份
  读回形状收成一个具名类型；CONTEXT 词条不再复述文件名与格式（指向 hld）。
- **Spec 三条**：① 「最后一次跑完」的口径已在判据、`observations.ts` 头注与 `main` 注释里改准；
  ② scope creep 已在「决定」里显式登记（`splitArgs` 的跨子命令副作用、`TrialProbe` 新必填字段、
  以及撤掉的导出）；③ `args.ts` 的吃掉下一个 flag 的漏洞已修并加用例；
  `observations.test.ts` 那条名不副实的用例标题已改准。

## 已知缺口（本票不做，留档）

- **形状还没有跨进程读者**。报告侧（runner）要汇总命中率时，那一票把行形状提到 `@model-war/schema`
  并定 JSON Schema，与 `FailureRecord` 那次裁决同款做法；在那之前，谁读那几行都算自己解析。
- **观测数据本身还没攒**。本票只把通道接通；「跑一两轮 gen 看真实命中率」是数据活，不是代码活。
- **异常轨淘汰那条边仍没追**（承前一票）：`exceptionTickLimit` 打满而淘汰时，名下单位还留着，
  那条路径上的读数完整性未验证——它影响的是**读数的含义**，不是本票这条落盘通道。
- **入口层的 stderr 留痕行仍不在常跑门禁里**（承前一票）：本票新增的观测文件**在**门禁里
  （`gen-cli` e2e 断言了它的字节），但那行人话文案没有。