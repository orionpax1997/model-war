# 04: `ranker` 纯函数——名次积分

**What to build:** 赛季排名的记账核心,一个**纯函数**:给定每局的名次与赛季配置的 `rankPoints`,算出每模型的赛季总分、有效局数、对局均分与排名。名次积分制:每场按最终名次记分;并列名次分 = 并列名次区间分值之和 ÷ 并列人数(并列第 2 → `(2+1)/2 = 1.5`)。`rankPoints` 固定长度 4(四方对局),默认 `[3,2,1,0]`、可覆写、**不进 `rulesets/`**。对局均分的**分母 = 有效局数**(剔除失败局后),并同时输出有效局数以暴露小样本。**v0 不做 Elo**,输出里不留半成品字段。

**Blocked by:** None(can start immediately)

**Status:** resolved

- [x] **先写测试再实现**(这是本 spec 里最适合 tdd 的一票)。
- [x] 并列名次分正确:并列第 2 → `1.5`;并列区间与人数变化时公式仍成立。
- [x] 剔除失败局后分母 = 有效局数,且有效局数出现在输出中。
- [x] `rankPoints` 可覆写,长度固定 4;越界 / 长度不符清晰报错。
- [x] 纯函数:无 I/O、无随机、无时钟,同输入恒同输出;v0 无 Elo。

## Answer

**落点:** `packages/runner/src/ranker.ts`(纯函数),从 `packages/runner/src/index.ts` `export * from "./ranker.js"` 转发;测试 `packages/runner/src/ranker.test.ts`(unit)+ `packages/runner/src/ranker.prop.ts`(property)。

**接口(`rankSeason`):**
```ts
type RankPoints = readonly [number, number, number, number];
const DEFAULT_RANK_POINTS: RankPoints = [3, 2, 1, 0];
type RankedMatch = { matchId: string; standings: readonly { player: string; rank: number }[] };
type RankedEntry = { player, totalPoints, countedMatches, averagePoints, rank };
rankSeason(matches: readonly RankedMatch[], options: { players: readonly string[]; rankPoints?: RankPoints }): readonly RankedEntry[];
```

**裁决(写进 JSDoc):**
- **分母 = `countedMatches`**;失败局由调用方在传入前剔除,`countedMatches` 只数传进来的局。有效局数为 0 的参赛者输出 `averagePoints: 0`、`countedMatches: 0`。输出覆盖 `options.players` 全体(含 0 局者,暴露小样本);对局里出现但不在名册者也一并计入(不丢数据)。
- **整数记账消浮点漂移**:公共分母 LCM(1,2,3,4) = 12,一局内并列 t 人时区间分值之和 ×(12/t) 累加为整数,仅输出时 ÷12。这也使结果与对局入参顺序无关。
- **排名 = 竞争排名**:按对局均分降序,同分并列、下一名次跳号(如 1,1,3);同分时输出顺序按参赛者名升序稳定排序。
- **不做 Elo**:`RankedEntry` 无 `elo` 字段(连 `null` 都不留)。
- **错误**:`rankPoints` 长度 ≠ 4 → `rankPoints 长度必须为 4(四方对局),实际 N`;某项非有限数 → `rankPoints[i] 必须是有限数,实际 …`;名次区间越界(如并列落在 4 之后)→ 带 `matchId` 的越界报错。

**测试:** 并列第 2 = 1.5;3 人 / 4 人并列时区间之和 ÷ 人数;剔除失败局后分母 = 有效局数且有 `countedMatches` 字段;`rankPoints` 覆写;长度 / 非有限 / 越界三类清晰报错;同输入两次调用 `toEqual` 与入参顺序无关;输出不含 `elo`;竞争排名同分跳号;0 局参赛者;包入口 re-export。属性测试:入参顺序无关、`countedMatches` = 出现局数、任意组合不产出 `elo`。

**验证:** `pnpm run check:quick` 通过;`npx vitest run --project unit --project property packages/runner` 23 passed(3 files)。
