# 03: 枚举器扩展——组合 × 地图 × 种子 × 座位

**What to build:** 让 `enumerateMatchUps` 一次产出**完整、确定的对局清单**:全部 4 人组合 × M 张地图 × K 个种子,每个对局带**座位轮换**。座位 = 组合内 4 名参赛者按 slug 升序为基准序列,再按 `(mapIndex + seedIndex) mod 4` 循环移位;精确均摊要求 `M × K ≡ 0 (mod 4)`,不满足时报错。对全体参赛者一致且完全确定(无人可选地图 / 种子 / 座位)。

**Blocked by:** None(can start immediately)

**Status:** resolved

- [x] 输入为参赛存档引用、地图池与种子数 K;输出为带 `ruleset` / 四座位 / 地图 / 种子 / 组合标识的完整对局元组。
- [x] `C(4, N)` 组合数正确;`M×K ≡ 0 (mod 4)` 时**每个座位的对局数精确相等**;不满足时报错而非静默偏移。
- [x] 结果与传入顺序无关,且同一配置完全确定(可重放)。
- [x] 现有 6 个用例随签名扩展一并更新(不新开第二处枚举),组合数量与顺序无关性仍有覆盖。

## Answer

`enumerateMatchUps` 在 `packages/runner/src/index.ts` **原地扩展**,仅此一处枚举,无新文件。

**签名**(options 对象):
```ts
enumerateMatchUps(options: {
  participants: readonly string[];
  maps: readonly string[];
  seeds: number;       // K
  masterSeed: string;
}): readonly MatchUp[]
```
`MatchUp` = `{ ruleset, seats: [archiveRef×4], map, seed, comboId, comboIndex, mapIndex, seedIndex }`。新增 `comboIndex` / `mapIndex` / `seedIndex` 供票 06 命名目录与票 07 排序确定性用。

**实现要点**
- 名册去重 → 按 **slug 升序**排序(`slugOf` 取 `archive/<slug>/<runId>` 的第一段;不按整串比较,因为 `-`/`.` 排在 `/` 之前会颠倒 slug 序,已由测试钉住)。组合 = `a<b<c<d` 四重循环,`comboId = c<k>`。
- 座位:基准序列 = 组合内 4 名(slug 升序),`rotateSeats(base, (mapIndex+seedIndex) mod 4)` 循环左移;第 i 位取 `base[(i+shift) mod 4]`。
- 种子:`deriveSeed(masterSeed, comboId, mapIndex, seedIndex) = sha256("<masterSeed>|<comboId>|<mapIndex>|<seedIndex>")` 前 8 hex → 无符号 32 位整数。分隔符 `|` 与截取位写死并被测试钉住(`sha256("master|c0|0|0").slice(0,8) = d47d6e71`)。`node:crypto` 是 runner 允许的原语。
- 均摊:枚举前断言 `maps.length * seeds % 4 === 0`,否则 `throw`,错误消息带 M、K 与 mod 余数。依赖只新增 `node:crypto`;未 import engine/gen。

**与 hld §8.1 的收紧**:hld 原文允许不满足时「各座位对局数最多差 1」,本票收紧为硬错误。已在 `enumerateMatchUps` 的 JSDoc 中记录。

**测试** `packages/runner/src/enumerate-match-ups.test.ts`(13 例):原 6 例全部按新签名改写(组合数按 distinct `comboId` 数、去重、四座互异、顺序无关、规则集版本);新增对局总数 `C(4,N)×M×K`、每座位每参赛者精确均分(M=3,K=4)、`≢0 (mod 4)` 抛错、轮换顺序、slug 排序键、种子确定性与范围、种子编码钉住。

**验证**
- `pnpm run check:quick` ✅(fmt / lint / coupling / no-float / budget 全绿)
- `pnpm vitest run --project unit packages/runner` ✅ 13/13
