# 01: 引擎侧「`loop()` 抛异常 → 异常计数」实现补齐

**Status:** resolved

**Blocked by:** None

## What to build

让 `loop()` 自身抛出的异常(以及脚本未吞掉的越权异常)按 `docs/hld.md` §5.2 第一行的**判罚语义**被计成一次异常:该方本 tick intents 置空、`exceptionTicks` 自增、达 `exceptionTickLimit` 判负出局,而不是被原样重抛成整场 `engine-crash`。

## 现状(为什么这是一张独立票)

`docs/hld.md` §5.2 的异常裁决表第一行写的是「本 tick 该方 intents 置空;`exceptionTicks++`;达 ruleset 的 `exceptionTickLimit` → 判负出局」,并在该行的实现分轨注里点明:三条**已实现**的计异常轨是事件计数 / 内存判罚线 / API 计数,而 `loop()` 自身抛出的异常**当前被原样重抛**、冒成整场 `engine-crash`,**不产生任何异常计数**。因此当前引擎里「故意写崩」这一路探针产不出证据——这正是 `.scratch/budget-calibration/spec.md` 把命题①改由三轨异常探针给出的原因。

## 为什么不在预算标定单元(`.scratch/budget-calibration`)的验收内

- 它改变的是**「异常」这一域概念的定义**(从「整场崩溃」变成「一次可容忍的异常」),不是补一条计数。这类语义变更必须走它自己的评审。
- 预算标定单元(K 节点)只修**文档措辞**——在 §5.2 里把「已实现 / 未实现」分开写并留本票指针,不顺手改引擎行为。
- 涉及面超出标定:§5.2 五行的分轨、`exceptionTicks` 的续算与持久化、以及 M2 的异常语义裁决都要一起复核。

## Acceptance

- `loop()` 抛出的异常不再冒成整场 `engine-crash`:该方本 tick intents 置空、`exceptionTicks` 自增、按 `exceptionTickLimit` 判负出局、点位回归中立。
- 脚本未吞掉的越权异常(访问已删除的宿主桥 / 未定义 action / 访问未暴露字段)与 `loop()` 抛异常同路,并计入同一累加。
- 与三条既有计异常轨的叠加语义一致:计次数、不清零,同 tick 最多叠加两次(事件计数轨截停后早退,内存与 API 可叠)。
- 一条引擎侧读数测试:`loop()` 抛异常的脚本被计成异常计数、达上限判负,而不是整场作废;测试只断言外部可观察行为(返回的观测与故障位),不测内部数据结构。
- 更新 `docs/hld.md` §5.2(移除该行的「当前未实现」限定与实现分轨注)与相关契约措辞(如需要)。

## Comments

分支 `feature/engine-loop-exception`,实现提交 `b5f6202`。

**观测 / 轨设计**:未被脚本吞掉的 guest 异常不再重抛,而是交回一条 `tripped` 观测——`{ kind: "tripped", track: UNCAUGHT_EXCEPTION_TRACK, value: 1, limit: 1 }`(新常量 `packages/engine/src/runner/quickjs.ts` 的 `UNCAUGHT_EXCEPTION_TRACK = "uncaughtException"`)。它**不是**规则集预算键(无上限可标定:任一未吞异常本身即达阈),但走**同一条写入口**:步 0 把 `tripped` 落成 `count-exception-tick`,未新增第二条写路径、未改 `tripped` → `count-exception-tick` 契约。

**实现**:`createQuickJsRunner.drainIntents` 的 catch 不再重抛;`eventTripped` / `hardTimedOut` 各有出口,其余异常记 `uncaught`,早退为 `{ intents: [], observations: [异常轨 tripped] }`——中止本 tick(不排 `drainIntents`、不判内存 / API),故只计一次、不与任何轨叠加;VM 续用、模块级记忆保留。`probe-harness.ts` 同步镜像该分支。

**验收逐条**:①`loop()` 抛异常 → intents 置空、`exceptionTicks` 自增、达 `exceptionTickLimit` 判负、点位回归中立(经步 0 端到端用例);②已删宿主桥 `ReferenceError` / 未定义 action 与 `loop()` 抛异常同轨计入同一累加;③叠加语义保持——计次数不清零,同 tick 至多两次(事件轨早退;内存 + API 可叠),异常轨中止本 tick 故只一次,已由「三件套同 tick 只计一次」用例钉住并写进 hld §5.3;④一条引擎侧读数测试(仅断言外部可观察行为:返回观测与故障位 `fault` 缺席 + 经步 0 的对局状态),不触内部结构;⑤`docs/hld.md` §5.2 首行移除「当前未实现」限定与引擎票指针、§5.3 累加点由三处改四处、§4.5 越权措辞同步(§4.5/§5.3 交叉引用一致)。

**测试**:`quickjs.test.ts` 新增四条(抛异常载荷 + VM 续用/记忆保留、越权同轨、中止本 tick 不叠加、经步 0 判负出局)。

**门禁**:`pnpm run check:quick`、`pnpm run typecheck`、`pnpm run test`(776 passed,含 `budget-mismatch.test.ts` 与散文门禁)、`pnpm run check:drift`(无漂移)全绿。
