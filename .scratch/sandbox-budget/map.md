# Map:沙箱与预算机制定案

Label: wayfinder:map
Status: resolved

## Destination

定案 v0 沙箱选型与预算裁决形态:quickjs-wasi 的中断计数、内存上限、异步排空、WASI 覆盖是否支撑 hld §5.3 的双计数预算与 NFR-1 确定性;WASM trap 滥用如何约束;runtime bundle 与逐函数注入如何取舍(已决:bundle)。产出可直接落进 hld §5 与 §12 开放项的定稿决策(#4 已决,#1/#8 待决),或一条明确的沙箱重选路径。**本图只定决策,不交付实现代码。**

## Notes

- 域:hld §5(沙箱)、§4.5(API 面)、§5.3(计算预算)、§12 开放项 #1/#8(#4 已决);上游约束 srs FR-2 / FR-4 / NFR-1(NFR-1 一票否决)。
- 每个 session 走 `grilling` + `domain-modeling`;`research` 票走 `research` skill,`prototype` 票走 `prototype` skill。
- 站位偏好:墙钟只观测、不参与判罚;不为"未来换 VM"保留抽象层(hld §5.0);spike/原型是 throwaway,不进 `packages/`。
- 每个事实只有一个家:决策只写进票的 `## Answer`,本图只留一行 gist + 链接。
- 引用票一律用票名(可带链接),不裸用编号(docs/agents/issue-tracker.md 的 tracker 约定)。

## Decisions so far

<!-- 一行一张已决票:[票名](issues/NN-slug.md) + 一行答案 gist -->

- [定案:沙箱选型与预算裁决形态](issues/05-verdict-sandbox-and-budget.md):汇总裁决落定——双计数改称「控制流事件计数」+ validator 脚本体积上限封盲区、quickjs-wasi 留任锁 3.6.2、内存三层判据(读数判据制,整包采纳票 06)、墙钟只观测、trap 整包采纳票 04、WASI 三件套定为工程常量、bundle 汇入;hld §4.6/§5/§6.2/§12 与 gdd《异常与出局》已同步。

- [OOM 异常被 guest 吞掉的 host 检测兜底](issues/06-oom-swallow-detection.md):判据从"OOM 事件"改锚"tick 末存活堆读数"(每 tick 末 `runGC()` 后 `getMemoryUsage().mallocSize`),软/硬双阈值(`memoryTickCeiling` 判罚 + 0.8× 披露);残余"瞬时触顶即释放"型不判罚、不 patch 宿主(留升级条款);不变量"判据锚定 host 可直接测量的量"。数据见 [findings/02](findings/02-oom-swallow-detection.md)/[02b](findings/02b-reading-adjudication-probe.md)。

- [跨边界调用形态对比](issues/03-runtime-bundle-vs-injection.md):进 v0 保留 hld §4.5 的 runtime bundle 形态,不回退逐函数注入——交叉点 ≈24–210 次调用/tick,注入形态「小赢无感、大输无上界」;打包方式留实现期。

- [沙箱行为实测 harness](issues/02-sandbox-spike-harness.md):§5 断言 11 条判定——6 成立、4 不成立(中断按控制流事件非指令、深递归非 trap 且 VM 可续用无需重建、无 maxStackSize 之说)、1 缺机制(OOM 可被 guest 吞,披露需 host 兜底);数据与判定输入见 [spike/FINDINGS.md](spike/FINDINGS.md)。

- [WASM trap 滥用的约束设计](issues/04-trap-abuse-countermeasures.md):滥用不成立(清记忆=自抹等价,重建逃不掉 `exceptionTicks`)→ 加代价四候选全部作废;§5.2 改写"异常不清记忆不重建、真 trap 计异常+防御性重建+扫描复核",§5.0 两处措辞修正,gdd《异常与出局》补两行;`exceptionTickLimit` 判"足"。拆出票「OOM 异常被 guest 吞掉的 host 检测兜底」。

- [quickjs-wasi 语义核查](issues/01-quickjs-wasi-semantics.md):六断言五成立一修正——interrupt 粒度为每 10000 opcode(须自乘计数),v3.3.0 内存上限不约束留存内存(锁版定为 ≥3.5.0),深递归 trap/每 tick 排空/WASI 冻结同序列均成立;12 项须实测交票「沙箱行为实测 harness」。细节见 [findings](findings/01-quickjs-wasi-semantics.md)。

## Not yet specified

<!-- 朝向目的地、现在还提不出尖锐问题的迷雾;等前沿推进后毕业成票 -->


## Out of scope

<!-- 超出目的地的工作:不毕业,目的地重画才回来 -->

- **预算参数终值标定**(hld §12 #2:指令/内存/超时上限取值):取值不是机制,归后续"预算与性能终值"图,以 ≥2 个人类基准脚本标定。
- **性能优化与快照拷贝粒度**(hld §12 #6)、**回放存储方案**(hld §12 #7):NFR-3 落地问题,超出"机制定案"。
- **工具链基线**(hld §12 #5:TS 7.0 / oxlint-tsgolint / oxfmt):独立、退化方案已备、决策轻,不值得成图。
- **规则数值与平衡**(gdd《开放项》#1/#3/#4/#5)、**地图池与种子变体**(gdd《开放项》#2/#6)、**座位轮换实效**(hld §12 #3):规则侧,由后续"规则契约与数值标定环"图承接。
- **NFR-3 单场墙钟粗判的余项**(host 侧快照序列化/深拷贝量级、bundle 形态的 VM 内执行成本):超出"机制定案"目的地,是"预算与性能终值"图的标定输入;盲区清单见票「跨边界调用形态对比」(已出数部分见票「沙箱行为实测 harness」)。
