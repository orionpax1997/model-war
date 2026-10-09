# 门禁耗时重测读数(票 01)

本文件是 `.scratch/release-gates/` 里**本轮六道门禁耗时**的落盘读数,原始证据是同目录的
`readings-raw.log`(未删节,含每道门禁被取样的完整命令输出与逐次墙钟)。hld §2.2.7 只引用本文件,
不复制逐次样本。

## 1. 环境与方法

| 项 | 值 |
|---|---|
| Node | v24.15.0 |
| OS × arch | Linux 7.0.0-34-generic x86_64 |
| cpus | 8 |
| 日期 | 2026-10-09 |
| 基线提交 | `ea23863`(分支 `t/01-baseline-remeasure`) |

方法(与旧基线同一口径):

1. **同机**——六道门禁在同一台机器、同一次会话内连续取样,不换机器、不并发跑别的重活。
2. **build 一次**——取样前在该仓库树上先跑一次 `pnpm run build`(`tsc -b`,0.22s),之后不再 build。
3. **连续 5 次**——每道门禁连续跑 5 次,取该门禁的**墙钟**(shell `date +%s` 前后差,取整秒)。
4. **报中位数**——报 5 次的中位数,不报单次最好成绩。

其中 `check:types` / `check` 两项的取样树与后续工作树的差异见 §4;其余四道门禁不受影响。

## 2. 六道门禁的逐次样本与中位数

| 门禁 | 命令 | 5 次样本(s) | 中位数 |
|---|---|---|---|
| `check:quick` | `pnpm run check:quick` | 1.68 / 1.68 / 1.64 / 1.64 / 1.73 | **1.68s** |
| `check:types` | `pnpm run check:types` | 2.96 / 3.01 / 2.95 / 3.00 / 3.06 | **3.00s** |
| `check`(全量) | `pnpm run check` | 91.07 / 94.04 / 97.33 / 93.76 / 97.48 | **94.04s** |
| `test:gates` | `pnpm exec vitest run --project gates` | 68.97 / 75.91 / 72.16 / 64.64 / 65.41 | **68.97s** |
| `test:slow` | `pnpm exec vitest run --project slow` | 403.04 / 397.24 / 395.65 / 395.74 / 396.16 | **396.16s** |
| `check:selfproof` | `pnpm run check:selfproof` | 120 / 122 / 122 / 105 / 64 | **120s** |

注:`check:selfproof` 的第 5 次(64s)明显偏快,是矩阵内缓存命中——它的耗时几乎全在 64 场对局的
标定环矩阵那一跑。中位数不受单次快慢影响;若只报最好成绩会低估它。

## 3. 与旧基线并列对照

旧基线是 **77 文件时代**(2026-10-03,基线 `a7f41f6`)的数,仍在 `docs/hld.md` §2.2.7,不删。并列如下:

| 门禁 | 旧基线(2026-10-03,77 文件时代) | 本轮(2026-10-09,基线 `ea23863`) | 变化 |
|---|---|---|---|
| `check:quick` | 1.05s | **1.68s** | +0.63s |
| `check:types` | 1.83s | **3.00s** | +1.17s |
| `check`(全量) | 5.65s | **94.04s** | +88.39s(16.6×) |
| `test:gates` | —(未单列) | **68.97s** | — |
| `test:slow` | —(未单列) | **396.16s** | — |
| `check:selfproof` | —(未单列) | **120s** | — |

**增长的来源**(可解释,不是机器抖):

- `check` 的暴涨几乎全在它链上的 `vitest run --project unit --project property`:样本里它是 **92 个测试文件 /
  987 条用例 / 约 85–91s**(旧表那 17 个测试文件、152 条用例只覆盖到一部分),再叠上 F/G/H/I 落地后
  新增的 `check:runtime`(runtime bundle 三段判定)。这道全量门禁已经不是当年那几个校验器与门禁测试的规模。
- 快门禁两项(+0.63s / +1.17s)是巡航面从 77 个文件长到 **284 个文件**(`oxfmt --check`)外加依赖图长到
  **182 个模块 / 506 条依赖边**(dependency-cruiser)的自然结果。

## 4. 口径声明(`check:types` / `check` 的取样树)

`check:types` 与 `check` 的读数是在**前一个续跑子代理已修** `packages/runner/src/season-config.ts`
`no-base-to-string` **的树上**取的(该修复让这两道门禁 exit=0)。这份修复**不由本 ticket 承载**,
现由 PR 分支上的另一版本承载;本 worktree 已把它回退,所以在本 worktree 重跑 `check:types` /
`lint:types` 会因基线上本就存在的 `no-base-to-string` 而红。这一节把取数树与工作树的分歧显式记下来,
避免后来者拿工作树的红去质疑上表的绿。

## 5. 复现

```sh
pnpm run build
pnpm run check:quick
pnpm run check:types
pnpm run check
pnpm exec vitest run --project gates
pnpm exec vitest run --project slow
pnpm run check:selfproof
```

每道门禁连续跑 5 次、取中位数。原始逐次输出见 `readings-raw.log`。
