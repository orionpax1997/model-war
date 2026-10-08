# 02: 回放读入端——导出 `readLinesOf` 并落地 `parseReplay`

**What to build:** 让任何消费者都能把一份 `replay.jsonl` 解析成**带类型的行**(meta / tick / result),而不是各自按结构猜字段。渲染器里那个私有的行读取器改为公开的 `parseReplay`,渲染命令改用同一条路径。**只做读入端最小面**——按 `input.json` 重新执行、逐 tick hash 比对的复算语义归 L,不在本票。

**Blocked by:** None(can start immediately)

**Status:** ready-for-agent

- [ ] `readLinesOf` 从 replay 包导出;`parseReplay` 公开可用,返回带类型的回放行(三行联合,行类型取自真源包,不在本包重声明)。
- [ ] `modelwar replay <replay.jsonl>` 的输出与改造前逐字节一致(`renderReplay` 改走 `parseReplay` 后观感不变)。
- [ ] 非法 / 截断 / 空回放给出清晰错误,不静默产出半截行。
- [ ] 往返测试:解析后重新序列化与原文一致。
