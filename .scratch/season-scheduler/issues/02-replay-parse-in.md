# 02: 回放读入端——导出 `readLinesOf` 并落地 `parseReplay`

**What to build:** 让任何消费者都能把一份 `replay.jsonl` 解析成**带类型的行**(meta / tick / result),而不是各自按结构猜字段。渲染器里那个私有的行读取器改为公开的 `parseReplay`,渲染命令改用同一条路径。**只做读入端最小面**——按 `input.json` 重新执行、逐 tick hash 比对的复算语义归 L,不在本票。

**Blocked by:** None(can start immediately)

**Status:** resolved

- [x] `readLinesOf` 从 replay 包导出;`parseReplay` 公开可用,返回带类型的回放行(三行联合,行类型取自真源包,不在本包重声明)。
- [x] `modelwar replay <replay.jsonl>` 的输出与改造前逐字节一致(`renderReplay` 改走 `parseReplay` 后观感不变)。
- [x] 非法 / 截断 / 空回放给出清晰错误,不静默产出半截行。
- [x] 往返测试:解析后重新序列化与原文一致。

## Answer

已实现并提交:`188727e0587ddbab65cee2fc03e28ed737cf40c1`(`feat(replay): 导出 readLinesOf 并落地 parseReplay`)。

**改动**

- 新增 `packages/replay/src/parse.ts`——回放读入端的**唯一家**:
  - `readLinesOf(path): readonly JsonValue[]`:逐行 `JSON.parse`、跳过空行(**保持 `JsonValue[]` 返回类型**,不窄化);
  - `parseReplay(path): readonly ReplayLine[]`:按判别式 `type` 把每行收窄成 `ReplayLine`(**类型取自 `@model-war/schema`,不重声明**);`type` 不在 meta/tick/result 之内、非对象行、整份空回放(0 行)一律抛错;
  - `ReplayReadError` 类从 `render.ts` **搬到**此处(不是新增一种),导出供消费者 `instanceof`。
  - 行号以「文件里的行号」为准(内部用带行号的中间形态,空行不改变行号)。
- `packages/replay/src/render.ts`:删掉私有的 `readLinesOf` / `ReplayReadError`,改从 `./parse.js` 取;`renderReplay` 走 `renderLines(parseReplay(path))`。**`renderLines` 与结构化取值器一字未动**,保留对缺 meta/缺 result/缺栏的容错 → stdout 逐字节不变。更新 `:17` 处过期头注与 `refuse` 的「退出码 2」笔误。
- `packages/replay/src/index.ts`:导出 `parseReplay` / `readLinesOf` / `ReplayReadError`;头注「读方向是 `renderReplay`」改为 `parseReplay`,并补一句「形状的**校验**(ajv)仍归 `apps/cli`,本包只做**解析**」。
- **错误文案**:某行不是合法 JSON 时附带「(文件可能被截断或没写完)」——不属 stdout,不影响逐字节一致;非法行报 `<path> 第 <n> 行不是回放行:type 不在 meta/tick/result 之内`;空回放报 `<path> 是空的:…`。

**边界(有意不做)**:`parseReplay` **不做形状校验**(过不了 schema 的旧夹具不该拒跑;真判据是 `apps/cli` 的 ajv);**不**把「缺 meta / 缺 result」升成硬错误(会改变 stdout,违反 AC2);`apps/cli/src/verify/index.ts` 的第二份 `parseLines` **本票未动**(迁移它的文案/行为会有额外影响,留 L 的复算链)。

**验证**

- `pnpm run check:quick` ✅(fmt / lint / coupling / coupling:quickjs / no-float / budget)。
- `pnpm vitest run --project unit packages/replay apps/cli` ✅ 176/176(含既有 `render.test.ts`、`cli.test.ts` 的 replay 两例)。
- 新增 `pnpm … --type-aware packages/replay apps/cli` ✅。
- 新增 `packages/replay/src/parse.test.ts`:往返(解析后 `JSON.stringify` 逐字节等于原文,钉住键序)、空行跳过、缺 meta/result 不报错、空回放/非回放行/截断末行/读不到各抛一次并断言路径与行号。
- `packages/replay/src/render.test.ts` 补一条 **stdout 全等**断言(不再只靠 `toContain`),钉住渲染输出逐字节不变。
