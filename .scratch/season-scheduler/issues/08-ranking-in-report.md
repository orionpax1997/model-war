# 08: 排名接入报告

**What to build:** 把纯函数 `ranker` 接进赛季产出:`report.json` 从「每局结果列表」升级成**可复算的排名数据**——每模型赛季总分、有效局数、对局均分、排名,连同规则版本。**名次可被独立重算**:任何人凭 `report.json` + `archive/` + 种子就能重算名次积分,结果与报告一致(NFR-2 AC)。

**Blocked by:** 04(名次积分纯函数)、07(重跑剔除后的有效局集合)

**Status:** resolved

- [x] `report.json` 含每场对局的输入引用 + 名次 + 分数,**仅凭它 + 存档 + 种子即可独立重算排名**(NFR-2)。
- [x] 被剔除的失败局**不进对局均分的分母**;有效局数出现在 `report.json` 中。
- [x] 每模型的赛季总分、对局均分、排名齐全;`rankPoints` 取自赛季配置。
- [x] 规则版本出现在 `report.json` 中。
- [x] 一个独立的复算测试:从 `report.json` 重算的名次与报告一致。

## Answer

**交付**:`report.json` 升级为可复算的排名数据;报告形状与渲染独立到 `packages/runner/src/reporter.ts`。

### 落点

- `packages/runner/src/reporter.ts`(新):`SeasonReport` / `SeasonMatchReport` / `MatchIssue` 形状,纯函数 `renderReportJson(report) → string`(`JSON.stringify(report, null, 2) + "\n"`),薄壳 `writeReportJson(path, report)`(mkdir -p 后落盘)。经 `index.ts` 桶导出。
- `packages/runner/src/scheduler.ts`(改):票 06/07 就地写在调度器里的 `SeasonReport`/`ReportedMatch`/`MatchProblem` **迁出**到 reporter(不重复第二份);逐局构造 `matches`(成功局)与 `matchIssues`(剔除了的失败局),调 `rankSeason` 一次算出 `standings`,再用 `writeReportJson` 落盘。
- `packages/runner/src/ranker.ts`(改):导出 `perMatchScores(matchId, standings, rankPoints?)`,复用 `rankSeason` 的同一套并列公式,供报告侧写 `perMatchScores`(避免两条公式漂移)。

### report.json 形状

```jsonc
{
  "runId": "2026-...",            // 产物目录名同源
  "ruleset": "v1",                // 规则版本标注
  "masterSeed": "2026-m4",        // 复算每局种子的根
  "rankPoints": [3, 2, 1, 0],     // 取自 season.yaml(缺省 DEFAULT_RANK_POINTS)
  "matches": [                    // 只含成功局(码 0),按 (combo, mapIndex, seedIndex) 确定序
    {
      "matchId": "c0-arena-s0",   // 目录名 <comboId>-<map>-s<seedIndex>
      "inputPath": "runs/<runId>/matches/c0-arena-s0/input.json",  // 仓库根相对
      "comboId": "c0", "mapIndex": 0, "seedIndex": 0,
      "map": "arena", "seed": 12345,
      "seats": ["archive/alpha/r1", "...", "...", "..."],          // 下标 = playerIndex
      "rankings": [1, 2, 3, 4],   // 下标 = 座位;回放末行 result.rankings
      "reason": "timeout",
      "perMatchScores": [3, 2, 1, 0]  // 下标 = 座位
    }
  ],
  "standings": [                  // rankSeason 输出原样,含 countedMatches(有效局数 = 均分分母)
    { "player": "archive/alpha/r1", "totalPoints": 6, "countedMatches": 4, "averagePoints": 1.5, "rank": 1 }
  ],
  "validationFailures": [],       // gen 侧 failed-<runId>.json 的机器可读字段(形状已钉;读盘归票 09)
  "matchIssues": [                // §8.4 崩溃/超时/内存披露;剔除局含 excludedFromRanking + 退出码 + 重跑次数
    {
      "matchId": "c0-arena-s0", "inputPath": "...", "comboId": "c0",
      "mapIndex": 0, "seedIndex": 0, "map": "arena", "seed": 12345,
      "reason": "engine-crash", "exitCode": 2, "rerunCount": 1, "excludedFromRanking": true
    }
  ]
}
```

- 剔除的失败局**不进 `matches`**、也**不进均分分母**;`countedMatches` 由 `rankSeason` 计,报告侧不另算。
- 两份「失败」分两节不合并:`validationFailures`(没参赛资格)对 `matchIssues`(参赛了但被剔除/需披露)。

### NFR-2 复算测试

`packages/runner/src/reporter.test.ts` 里两条:跑一季 `scheduleSeason`(可控桩 spawn)把 `report.json` **写到临时根**,再从磁盘读回,只用它的 `matches[].rankings` + `seats` + 顶层 `rankPoints` 调 `rankSeason`,断言 `toEqual(report.standings)`。一条测全员成功,一条测「首发退 2、重跑仍退 2 → 该局剔除」后仍一致(分母随之变 3)。

### 验证

- `pnpm run check:quick` 通过(fmt / lint / coupling / no-float / budget)。
- `pnpm vitest run --project unit packages/runner apps/cli` 通过(14 文件 229 例)。
- `tsc -b` + `depcruise packages/*/dist apps/*/dist`:无依赖违规(runner → schema / ranker / reporter,无 engine / gen 边)。

### 未做(留给票 09)

`validationFailures` 先为空数组(形状已定);读 `archive/<slug>/failed-<runId>.json` 与 `report.md` / `narrative/` 归票 09。
