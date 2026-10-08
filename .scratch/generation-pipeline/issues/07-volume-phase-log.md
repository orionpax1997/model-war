# 07: 体积上限的相位时机与编译诊断回喂分栏

**What to build:** 脚本体积上限只在冻结期硬拦、迭代期只提示;tsc 编译诊断与契约校验诊断同池计入回喂轮数,但在日志里可分开看。

**Blocked by:** 04(协议回喂环)

**Status:** ready-for-agent

- [ ] 迭代期以 `--phase iteration` 查体积,**只提示不拦**;冻结前以 `--phase freeze --max-bytes <rulesets 取值>` **硬拦**;`--max-bytes` 无默认值,由生成管线作参数传入。
- [ ] tsc 编译诊断与契约校验诊断**同池计入回喂轮数**;`generationLog` 逐轮标 `kind: "tsc"` / `"contract"`。
- [ ] 只剩非 blocking 提示 → 判**通过**、可冻结(`validation.passed = true`,提示文本记入 `errors`)。
- [ ] 测试:体积超限脚本在迭代期不拦、冻结期拦;编译失败可被回喂并计入轮数;纯提示场景判通过。
