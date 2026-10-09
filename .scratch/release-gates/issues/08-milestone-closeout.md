# 08: 里程碑关账与收尾对账

**What to build:** 全链绿后的关账:里程碑剩余工作关闭,两条工程开放项关闭,节点状态翻绿,整体验收第四条对账。全票合并后跑一次默认快速验证再标 PR,收尾走双轴评审。

**Blocked by:** 07 (全链绿后).

**Status:** resolved

## 验收

- [x] 里程碑关闭,两条工程开放项关闭,节点状态与验收口径已对账
- [x] 全票合并后默认快速验证一次通过,双轴评审完成(默认快速验证 `verify:fast` 绿;双轴评审由主线程在合并后执行,见 Answer 末节)
- [x] 全部票面状态与验收勾选已回写

## Answer

### 本票改了什么(纯文档对账,不动实现代码)

- `docs/hld.md` §12:`#6`(`:870`)、`#7`(`:871`)两行末尾各补「**本项关闭**」措辞(票 04 已把两行改成「已收口」并挂 `check:limits` 断言,本票只补关闭措辞,未动正文与断言口径)。**未动 #10**(已由 I 收口)、未把 #3(B)算进来。
- `docs/diagrams/v0-milestone-dag.md`(按 `docs-baselines.md` §4.2 行号清单逐处):
  - `:47` 基线末句开放项剩余改为现状:工程侧只剩 #3(B),gdd 规则侧仍有 #11/#15;并补 L 收口一句。
  - `:81` L 节点框加 ✅(`hld #6 / #7 关闭 · NFR-3 定值`);`:85` M2 框加 ✅(`已关闭 · F ⇢ L 复验义务完成`);`classDef done` 串补 `L,M2` 使框翻绿。
  - `:192` L 节点表状态 `○ 未开` → `✅ 已收口(8 票全部落地)`,归属栏补收口结论(#6/#7 停止条件已成可执行断言、挂 `check:limits`;M2 随本格 PR 关闭)。
  - `:202` V0 门槛改为 **B、L** 两项(M1/M2/M3/M4 已关闭),并写明 **M2 的关闭依据 = F ⇢ L 复验义务完成,不是 L 重交引擎**;`:209` 由「四项收到三项(M2、B、L)」改为「再随 L 收口关掉 M2,现只剩 B、L 两项」。
  - `:221` frontier 表 L 行改为 ✅ 已收口;`:238` 波次 9 改为 `L ✅ → M2★ ✅`。
  - `:253` 的 `F ⇢ L` 复验义务段改为「**复验已完成**」:指向 `[.scratch/release-gates/verification-matrix.md]`(票 03)与 `check:cross-process` / `check:limits`,并点明 M2 据此关闭。
- `docs/srs.md` §4 第 4 条(`:140`):按「开放项清零」现状对账——工程侧 hld 可执行项已清零(#6/#7 随 L 关,#3 归 B 的 wayfinder),规则侧 gdd 的 #11/#15 仍留且已列 Out of Scope,**如实写清不假装清空**;规则数值落 `rulesets/v1.json`。

### 跑了哪条命令、结果

- `pnpm run verify:fast`(`check:quick` + 默认 `test`):**绿**——`test` 94 个测试文件全过 / 1003 passed + 3 skipped(1006),用时约 85s;`check:quick` 退 0。(对所有文档改动到位后复跑仍绿。)
- `pnpm run check:quick`:单独复跑退 0(fmt / lint / coupling / coupling:quickjs / check:no-float / check:budget;文档改动不触 fmt 覆盖面,不破零构建)。

### 票面回写核对(01–07)

逐张核对 `Status:` / `## 验收` 勾选 / `## Answer`:

- **01、02、03、04、05、06、07**:`Status:` 均 `resolved`,`## Answer` 均在,验收勾选均 `[x]`。
- **发现一处格式遗漏**:01 与 05 的验收勾选直接跟在 `Status:` 后、缺 `## 验收` 标题(其余票都有)。已补上标题,勾选内容未动。

### Status 与遗留

- `Status:` 置 `resolved`。
- **双轴评审(主线程,本票合并后执行)**:`/code-review` Standards + Spec 两个只读子代理在最终分支上并行评审。Standards 轴发现 3 处「成员枚举过期 / 归属登记漏项」登记漂移(CONTEXT 夜间流水线词条、ADR-0010 枚举、hld §2.2.7 行)与 1 处重复测试 smell,Spec 轴未发现阻断性缺失(仅两处口径注记:跨进程门禁输入用现造样本、`mutate` 深跑读数缺仓内证据)。全部发现已在单个修复 commit 中处理(成员真源改指针、归属表补 `check:budget-recheck`、位置纪律用例收成 `it.each` 表驱动、`mutate` 深跑读数补记 `readings.md`),`verify:fast` 复跑仍绿。详见合并 commit `b043e68`。
