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

---

# 对局墙钟、快照拷贝占比与单季回放体量读数(票 04)

本文件是 `.scratch/release-gates/` 里**本轮**的单局墙钟分布与两条停止条件读数。它与上面票 01 的
六道门禁耗时读数**不是同一件事**,不互相替代:票 01 量的是门禁脚本自己跑多久,本节量的是**一个对局**
跑多久。结构化原始读数落同目录 `limits-readings.json`(36 条逐局样本 + 机器配置);本节只引用,
不复制逐局样本。

## 1. 环境与方法

| 项 | 值 |
|---|---|
| Node | v24.15.0 |
| OS × arch | linux 7.0.0-34-generic / x64 |
| cpus | 8 |
| 日期 | 2026-10-10 |
| 执行体 | `benchmarks/<cell>/script.js`(入库产物,三舱轮换) |
| 地图 / 规则集 | `maps/open-clash.json` / `rulesets/v1.json` |
| 种子 | 20260101..20260136 |

方法:**同机、单进程**,逐局取 `runMatch` 一次调用的墙钟(`performance.now()` 前后差,不含进程启动、
不含并发)。**同一批入库基准脚本**(cell-a / cell-b / cell-c 三舱轮换,满足 srs 的「≥2 份」),
共 **36 局**,报 p50 / 均值 / 最坏三栏。这是把基准脚本的**单局**墙钟分布从 K 的 10 场扩到 36 局,
**不是** I 的整轮吞吐(那条含 8 路并发与排队,不作单局口径)。

复现命令(它同时把结构化读数落成 `limits-readings.json`):

```sh
pnpm run check:limits -- --matches=36 --readings-out=.scratch/release-gates/limits-readings.json
```

## 2. 单局墙钟分布(NFR-3 的 X 与它的采样)

| 口径 | 读数 |
|---|---:|
| p50 | **2373.2 ms** |
| 均值 | **2725.7 ms** |
| 最坏 | **4650.8 ms** |

三舱各自的量级:cell-a(近战压力)约 2.0–2.3 s、cell-b(扩张经济)约 3.4–4.7 s、cell-c(只占不采)
约 2.3–2.7 s。最坏那一局落在 cell-b(经济拉满,脚本自身 tick 成本最高)。

**X = 均值的两倍 = 5451.4 ms,向上取整到 100 ms → `5500 ms`。** 口径是**「均值 + 一倍余量」**
(物理量轨留宽,沿 hld §5.3「余量分轨而非统一系数」):不拿最坏值 4650.8 ms 当 X,也不拿 K 的单局
最坏 3801 ms 或 I 的整轮吞吐 0.81 局/s 当口径。一倍余量把本次最坏(1.71 × 均值)全覆盖,并留约
18% 的机器负载余量。取值规则的家在 `docs/hld.md` §10.1,X 的数值回填在 `docs/srs.md` NFR-3 AC。

## 3. hld #6:快照拷贝税占单局墙钟(停止条件:占比 < 10% 即停)

| 项 | 读数 |
|---|---:|
| `buildSnapshot`(深拷贝 + 深 freeze)中位 | **0.232 ms** |
| 只 `structuredClone`(纯深拷贝)中位 | **0.176 ms** |
| 差异 Δ | 0.056 ms / 次 |
| 整局拷贝税(4 席 × tick × Δ) | 4869.2 ms(36 局合计) |
| **占比(拷贝税 ÷ 单局墙钟)** | **4.96%** |

口径:每局跑完后在该局**终局状态**上各连取 5 次、报中位(与 `.scratch/engine-core/readings.md`
§2 同法);「每 tick 四席各构一次快照、串行共用一份」由 hld §4.5 定。**4.96% < 10%**,复测确认
F 那条「约 5%」的读数成立 → **#6 停止条件成立**:占比在线内就**不做**零拷贝重构(合并深 freeze 与
stateHash 规范化两次遍历会踩 `snapshot/traversal-independence.test.ts` 钉住的禁令)。

## 4. hld #7:单季回放体量(停止条件:< 1 GiB 且夜间一遍读完 < 10 min 即停)

| 项 | 读数 |
|---|---:|
| 单局回放均值 | **2.3 MiB** |
| 单季(算例 75 局)合计 | **171.1 MiB** |
| 读一遍速率(读盘 `readFileSync`) | 约 1223 MiB/s |
| 单季一遍读完 | **0.140 s** |

口径:单局回放字节 = 逐行 `Buffer.byteLength(line,"utf8") + 1` 累加;单季 = 75 局(算例
N=5/M=3/K=5)× 单局均值;读完时间 = 单季字节 ÷ 实测读盘速率。**171.1 MiB < 1 GiB 且 0.140 s <
10 min → #7 停止条件成立**:不做压缩 / 增量回放;真超的那天另开优化节点。

## 5. 两条停止断言的可执行形态

`check:limits`(根 `package.json`;`packages/tools/src/limits/run-limits-gate.ts`)把上面 §3 / §4
两条判成门禁:#6 占比 ≥ 10% 即红,#7 单季 ≥ 1 GiB 或一遍读完 ≥ 10 min 即红。它 spawn 一次 `tsc -b`
并用真引擎单进程跑真沙箱对局,**归按需→夜间层**:不进 `check:quick` / `check` / `test` /
`verify:fast`(零构建性质不能破)。位置纪律在 `gates.test.ts`,正例与两侧反例(人为放大拷贝差值 /
回放体量即红,去掉开关即绿)在 `gates-slow.test.ts`。
