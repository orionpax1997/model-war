# pilot-exp-idlefix —— 「扩张农待工」这条混淆的对照臂（throwaway，探针改动**未**提交）

**这是什么**：票 06 修完 F1/F2/F3 之后又挖出的**第四条混淆**的对照实验。
这一臂的探针改动**不在仓库里**（见下面的复现步骤），只有产物入库。

## 挖出它的过程（都可复跑）

1. 修完三条之后，corridor-split 在 farmer6 上仍然采不空（结束剩 56.3%），
   但**扩张已经成功了**：逐方 `capsByDriverTotal` 都是 5，自家矿从 1 个变成 4 个。
   问题不在「走不到」，在「占下来了没人挖」。
2. 逐 tick 位移计数（t=300 起）：corridor-split/farmer6 上**只有一个座位的 3 个单位还在动**，
   其余三个座位 6 个农从 t≈200 起逐 tick 位置不变。
3. 中立点位清零时间：四张图（含无墙夹具）都在 **t ≤ 150** 就把中立点位全占完。
4. 于是扩张农每 tick 走到这一行：

   ```js
   const pool = myClaims.length > 0 ? myClaims : neutral;
   const t = nearestOf(pool, u.x, u.y);
   if (!t) continue;            // ← 没得占就永久待工
   ```

   `myClaims` 与 `neutral` 同时为空 → `t === null` → `continue`，
   **从 t≈150 起有一半劳力（farmer6 是 3/6，farmer8 是 3/8）静止到 600 tick 终局**。
   采集分支有「自家矿全枯竭就待采」的兜底，扩张分支没有对称的兜底——这是探针的缺口，不是地图的。

## 这一臂的对照

只改一行（扩张无目标时全员转采集）：

```js
const noExpand = myClaims.length === 0 && neutral.length === 0;
const harvestCount = noExpand ? workers.length : Math.floor((workers.length * HARVEST_PCT) / 100);
```

复现步骤（在 `ticket/06-equivalence` 的干净探针上）：

```bash
cd /tmp/mw-ticket-06
python3 - <<'PY'
p='.scratch/rules-calibration/sim/probes/farmer.js'
s=open(p).read()
old="  const harvestCount = Math.floor((workers.length * HARVEST_PCT) / 100);"
new="  const noExpand = myClaims.length === 0 && neutral.length === 0;\n  const harvestCount = noExpand ? workers.length : Math.floor((workers.length * HARVEST_PCT) / 100);"
open(p,'w').write(s.replace(old,new,1))
PY
cd .scratch/map-pool/runs && PILOT_OUT=$PWD/pilot-exp-idlefix node --disable-warning=ExperimentalWarning pilot.mjs
# 复现完把 farmer.js 还原（git checkout .scratch/rules-calibration/sim/probes/farmer.js）
```

## 这一臂的数字（4 种子，全部逐字相同）

| 组 | 采空(p100) | 结束剩余% | 全场交付均值 |
|---|---:|---:|---:|
| `P0/fixture/farmer6` | **296** | 0 | 3040 |
| `P0/fixture/farmer8` | 234 | 0 | 3000 |
| `P1/open-clash/farmer6` | 305 | 0 | 3020 |
| `P1/fortress-core/farmer6` | 313 | 0 | 3120 |
| `P1/corridor-split/farmer6` | 365 | 0 | 3080 |
| 其余 farmer8 档 | 233–293 | 0 | 2980–3060 |

## 这组数字说明什么（这是本臂存在的唯一理由）

**八张图全部采空，四张真图全部落在 233–365，无一进 400–600 窗口；而无墙夹具臂从 479 掉到 296。**

也就是说：标定环那个 479 基线、票面那个 400–600 窗口，都是
「一半劳力从 t≈150 起静止」这个探针缺陷的**联合属性**，不是「地图 + 规则集」的属性。
只要经济剖面真的拉满（六个农全在干活），无墙平原 296 就采空了，
**400–600 这个窗口在任何地图上都够不着**。

所以命题①在当前探针下**判不了**：不是「三张图不过」，是「测的不是命题①问的东西」——
命题① 自己写了前置条件「拉满经济剖面（每家 6–8 专职农）」，而这个前置条件至今没被满足过
（先是 F3 让 8 农档没跑过，再是这一条让一半农永远待工）。

**这一臂没有改动地图，`maps/*.json` 一个字节都没动。**