# 01: 引擎侧「`loop()` 抛异常 → 异常计数」实现补齐

**Status:** ready-for-agent

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
