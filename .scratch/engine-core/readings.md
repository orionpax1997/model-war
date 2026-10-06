# 票 11 读数:每 tick 回放体量与快照拷贝耗时

> **口径:三张真图与标定环那一轮可比的是夹具与判据,读数不可互比。** 点位布局与储量那一刀
> (`resourcePerSite` 125→200、点位沿用 `center-fortress@64` 的展开值)改过标定依据,所以标定环
> 那一批体量/耗时类数字不能拿来当本轮的基线或对照。可比的只有两件事:夹具(地图与规则集)与判据。

**这两项是观测项,不是承诺。** 测量方法:在一份**已构建**的仓库树上,对**同一个**状态连续
取样 **5 次**取墙钟(`performance.now()`),**报中位数**(不报单次最好成绩)。环境:Node v24.15.0 /
Linux x64。读数文件只放数与测法,**不放建议阈值**——停止条件归各自那一格(见本文末尾的指针)。

## 1. 每 tick 的回放体量

| 项 | 读数 |
|---|---:|
| 600 tick 那一份的总字节数 | **2 388 636 B** |
| 每 tick 平均字节数 | **3 981.1 B/tick** |
| tick 行数 | 600(另有 meta 1 行 + result 1 行) |

口径:一个**空对局**(`runMatch` 跑满 `tickLimit = 600`,策略为空)写出的回放,每行一条
字符串、行尾加一个 `\n`,逐行 `Buffer.byteLength` 累加。`terrain` **不在 tick 行**
(`packages/engine/src/replay-writer/tick-line.ts` 的六栏载荷),所以体量不随 `size: 64` 膨胀;
体量随 tick 行数线性增长(600 行那一份的上表数字)。

`runs/**` 被 `.gitignore` 排除,读数因此**不能靠入库文件复现**;复现命令(它同时把这份 600 tick
回放落成 `runs/t11-readings/replay.jsonl`,供 `wc -c` 核对):

```sh
MW_READINGS_DIR=runs/t11-readings \
  pnpm vitest run --project unit packages/engine/src/fixtures/fixtures.test.ts -t 读数探针
wc -c runs/t11-readings/replay.jsonl   # 2388636(逐行字节之和,含每行行尾换行)
```

## 2. 快照拷贝耗时(`buildSnapshot` 那一个表达式的整体耗时,与「只深拷贝」分开记)

状态:一份**把经济拉满的终局**(48 单位 / 28 点位,`maps/open-clash.json` + `rulesets/v1.json`)。

| 表达式 | 5 次取样(ms) | 中位数 |
|---|---|---:|
| `buildSnapshot(state)` = `freezeDeep(structuredClone(snapshotShapeOf(state)))`(深拷贝 + 深 freeze) | 0.403 / 0.307 / 0.305 / 0.317 / 0.303 | **0.307 ms** |
| 只 `structuredClone(形状)`(深拷贝,不 freeze) | 0.362 / 0.263 / 0.245 / 0.245 / 0.239 | **0.245 ms** |

**为什么要分开记**:深 freeze 与 `stateHash` 的规范化是**两次遍历、不许合并**——它们是
`packages/engine/src/snapshot/snapshot.ts` 头部第二条取舍,并被
`snapshot/traversal-independence.test.ts` 三条用例钉住。把「整体耗时」与「只深拷贝」分开,
是为了让「深 freeze 那一趟值多少」这件事有一份可读的账;合并两者(或让拷贝粒度依赖「这一 tick
算没算 hash」)正好踩在那条禁令的边界上,所以这张表**只报两个数,不合并**。

复现命令:`MW_READINGS_DIR=runs/t11-readings pnpm vitest run --project unit packages/engine/src/fixtures/fixtures.test.ts -t 读数探针`
(读数落成 `runs/t11-readings/replay-volume.json` 与 `snapshot-copy.json`)。

## 本票不裁的三件事(只在此留指针)

拷贝粒度优化到什么程度算完(hld 开放项 #6)、回放体量与夜间扫描的存储/IO 方案(hld 开放项 #7)、
性能那个「对局平均墙钟」的目标值(NFR-3 标定)——三者的停止条件**不在本票**,归节点 L / `grill`
(见 `.scratch/engine-core/issues/11-determinacy-first-touch-rerun-and-readings.md` 的 `## Answer`)。
