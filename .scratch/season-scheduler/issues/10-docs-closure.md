# 10: 文档收口

**What to build:** 把这次工作留下的文档账一次结清,让「每个事实只有一个家」继续成立:①把三笔交办账**登记进 hld §12** 并把指针指向本 spec 的对应票,旧处的表述改成指针——A 的「两条等效命题在首轮赛季复验」、G 的「对局 spawn / 池 / 重跑编排归 I」、H 的四项;②把 DAG 的四处过时句对齐(H 收口后交付层应是八格、M1/M3 已闭后 V0 汇合只剩四项、结论 1 未列 H/K、L 行前置仍写「等 K」);③**DAG §5 frontier 表补上 I 的行**(I 是主干唯一未开的交付格却在表里缺席);④对齐 `engine/src/index.ts` 的头注与代码(头注声称状态模型随 `runMatch` 导出、代码实际没导出)。

**Blocked by:** None(can start immediately;建议随本 spec 的 PR 一起收口,因为指针要指向票号)

**Status:** ready-for-agent

- [ ] hld §12 含三笔交办账(A / G / H),每条指针指向本 spec 的票与关账条件;旧处改指针、不留第二份表述。
- [ ] DAG 四处过时句对齐;§5 frontier 表新增 I 的行。
- [ ] `packages/engine/src/index.ts` 头注与代码一致。
- [ ] 通读一遍:没有同一事实出现两处、没有悬空指针。
