# 10: 文档收口

**What to build:** 把这次工作留下的文档账一次结清,让「每个事实只有一个家」继续成立:①把三笔交办账**登记进 hld §12** 并把指针指向本 spec 的对应票,旧处的表述改成指针——A 的「两条等效命题在首轮赛季复验」、G 的「对局 spawn / 池 / 重跑编排归 I」、H 的四项;②把 DAG 的四处过时句对齐(H 收口后交付层应是八格、M1/M3 已闭后 V0 汇合只剩四项、结论 1 未列 H/K、L 行前置仍写「等 K」);③**DAG §5 frontier 表补上 I 的行**(I 是主干唯一未开的交付格却在表里缺席);④对齐 `engine/src/index.ts` 的头注与代码(头注声称状态模型随 `runMatch` 导出、代码实际没导出)。

**Blocked by:** None(can start immediately;建议随本 spec 的 PR 一起收口,因为指针要指向票号)

**Status:** resolved

- [x] hld §12 含三笔交办账(A / G / H),每条指针指向本 spec 的票与关账条件;旧处改指针、不留第二份表述。
- [x] DAG 四处过时句对齐;§5 frontier 表新增 I 的行。
- [x] `packages/engine/src/index.ts` 头注与代码一致。
- [x] 通读一遍:没有同一事实出现两处、没有悬空指针。

## Answer

已实现。纯文档 + 一处代码注释,不改行为。

**hld §12 登记三笔交办账(`docs/hld.md` §12 表尾新增 #9/#10/#11)**
- #9:A 的两条等效命题在首轮赛季上的复验 → 落本 spec 票 11 的读数(`.scratch/season-scheduler/e2e-readings.md`)。
- #10:`match` 的 spawn / 进程池 / 重跑编排 → `packages/runner` 的 `scheduler`,本 spec 票 06 / 07。
- #11:H 的四项交办(≥4 真实模型 / `input.json` 物化 / 崩溃重跑剔除 / 回放读入端接线)→ 本 spec 票 11 / 03 / 07 / 02,逐条关账条件写清。

**旧处改指针(不留第二份)**
- `docs/diagrams/v0-milestone-dag.md` §7 A 引言句 → 指向 hld §12 #9;§4 的 G 行② → 指向 hld §12 #10。
- `.scratch/generation-pipeline/spec.md` 为历史件,原文不动。

**DAG 过时句对齐 + I 行**
- `:35` 交付层七格 → 八格(加 H);`:202` V0 汇合六项 → 四项;`:206` 结论 1 补 H/K;`:220` L 行前置 K 打 ✅。
- §5 frontier 表在 H 行后插入 I 行(交付层、可开、前置 E/G/H/A/K ✅、**M4★**);顺手对齐 `:179`(I 行改 🔶 实施中、research 栏办结)、`:236`(波次 8 前置已满足)、`:237`(波次 9 L 等 I)。

**engine 头注**
- `packages/engine/src/index.ts` 头注改为「状态模型**不**导出(经 `RunMatchResult.finalState` 拿得到值、拿不到名字)」,type/interface 理由改挂 ADR-0002。**未补导出**(以代码为准)。

**顺带指针**
- hld `:750` `meta.json` 形状家指向 `packages/schema/src/archive-meta.ts`;`:776` 补 `season.yaml` 字段意图;`:784` Elo 冲突改指 spec《Out of Scope》;`:803` run 行补根目录解析与不加载 `.env`。`:754` 失败记录形状家已由票 01 落地,不重复。

**验证**
- `pnpm run check:quick` ✅(fmt / lint / coupling / no-float / budget 全绿;「N 次控制流事件」仍 3 处)。
- `pnpm run test` ✅(88 文件 / 913 用例,含 doc-homes 与 budget 门禁)。

## Comments

- 主线程/发布侧只需在合并本 spec 后回填提交号。

## Review fixes

**提交:`0795834f0a303eb601ed5e2b74ed42c9addbe32a`(fix(runner): 评审修复——内存披露/每局叙事/parseReplay/zod 与 hld 对齐)**

- **St1(hld §8.1 矛盾措辞)**:座位轮换条目收紧为单一硬性规则——**精确均摊要求 `M × K ≡ 0 (mod 4)`,
  不满足时直接报错**;删去「不满足时各座位的对局数最多差 1,差额落在同一相对位次……」这第二处措辞。
  同源表述同步清理:`docs/gdd.md`《座位与先后手》与该 spec 的 User Story 3。hld 的 FR-7 AC1 验收行
  由「各 seat 的对局数之差 ≤ 1(M×K 为 4 的倍数时严格相等)」改为「各 seat 的对局数精确相等(要求 M×K ≡ 0 (mod 4))」。
- **St2(hld §8.1 字段真源)**:删去复制的默认值 / 细节,改为「字段、取值域与默认值的真源 =
  `packages/runner` 的 zod season schema(`src/season-config.ts`);格式范例见 `season.example.yaml`」。
