# 先例数值区间参照：一手来源调研

> 本文件保存事实、推导与出处；参数定案留给标定票。数值来自规则不同的游戏，不能直接按“同名属性”搬值。凡写“建议”的行均为 model-war 的起步量级推断，不是先例作者给出的通用平衡结论。

## 范围与证据口径

- **Halite III**：Two Sigma 官方挑战仓库的引擎源码与 constants；另外核对官方挑战文档。它是 2/4 人、采矿/回运型经济游戏，战斗主要是移动碰撞，不是攻击单位面板。
- **Halite IV**：Two Sigma/Kaggle 官方 playground 规则页。它保留 Halite III 框架但改成再生资源、无移动成本、载货碰撞窃取，故与 III 分开列。
- **Lux AI Season 2**：挑战主办方官方规则仓库、配置与环境实现。其战斗为资源/电量约束下的碰撞和拆除，不是传统攻击/HP 系统。
- **Screeps Arena**：官方 Arena 文档和 `screeps/arena-definitions` 官方仓库快照。Arena 使用可拼装 body parts，跟 model-war 固定兵种只有部分可比性。引用 body part 数值时不把 Screeps World 的 1500 tick creep lifespan 当成 Arena 对局时长。

## 先例机制与可观察的数量级

### 1. 经济

| 先例 | 收入 / 携带 / 造价的原规则量级 | 储量与节奏 | 对 model-war 的启发 |
|---|---|---|---|
| **Halite III** | 官方 `Constants.hpp` 默认 `INITIAL_ENERGY=5000`、`NEW_ENTITY_ENERGY_COST=1000`、`MAX_ENERGY=1000`、`DROPOFF_COST=4000`、`EXTRACT_RATIO=4`、`MOVE_COST_RATIO=10`。引擎按格子当前能量的 `ceil(cell.energy / 4)` 开采，船容量上限 1000；离格移动要付来源格 `energy / 10`（源码整数运算）。因此初始银行约等于 5 艘造价、Dropoff 约 4 艘造价，且移动也烧经济资源。[引擎常量](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/config/Constants.hpp)；[采集与回合处理](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/HaliteImpl.cpp)；[移动、造船与碰撞](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/command/Transaction.cpp) | 地图矿格开局生成、III 的常规矿不按 tick 再生；地图尺寸影响回合上限：引擎注释及计算为 32 格边长约 300 turns、80 格约 500 turns（常量默认范围 400–500，但小地图会按公式降到 300）。地图上矿被采集，矿/船都耗尽时可提前终局。[turn 计算及 game_ended](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/HaliteImpl.cpp) | 经济不是“矿上每 tick 固定给钱”：单位在矿上持续采集、回家路程与路上损耗决定净收入。比较资源参数时要计算完整采集—回收回路，不应只看 harvestRate。有限矿使地图总储量和 tickLimit 必须相容。 |
| **Halite IV** | 官方规则：起始 5000；造船/转船坞各 500；单船无 cargo cap；停留时采当前矿格的 25%。[Two Sigma 的 Kaggle 官方 playground 规则](https://www.kaggle.com/competitions/halite-iv-playground-edition) | 每个无人格矿量每 turn 再生 2%，上限 500；对局最多 400 turns。碰撞由载货最少的船存活并夺取其余船货物（平手全灭），资源再生与偷货形成局部翻盘渠道。[同上，Rules](https://www.kaggle.com/competitions/halite-iv-playground-edition) | “再生矿”并非简单取消枯竭：它让争夺焦点由有限储量回路变成高矿格占位、暴露船只与回合剩余时间。可作为有限矿方案的对照，而非同一参数标尺。 |
| **Lux AI S2** | 官方配置：Light 每次 dig 得 2 个 raw resource、cargo 100；Heavy 每次 dig 得 20、cargo 1000；建造金属成本分别 10/100，power 成本 50/500。Factory 每 tick 最多处理 Ice 100→25 Water、Ore 50→10 Metal。单位的 dig/move 受 power 限制，故不是不受限的恒定采集率。[官方配置](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/luxai_s2/luxai_s2/config.py)；[环境实现](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/luxai_s2/luxai_s2/env.py)；[规则说明](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/specs.md) | Ice/Ore 是地图上的可采 raw resources；Factory 持续加工并消耗 Water 维持生存/扩张 Lichen。游戏到 1000 turns 按 Lichen 计分，失去所有 factories 则提前输。[规则](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/specs.md) | 一个独立例子中，载量约等于 50 次同重量级 dig 的理论产出（Light:100/2；Heavy:1000/20），说明“载量覆盖若干工作 tick”比孤立抄资源单位更可比较；实际往返时间和 power 消耗仍需单独计入。 |
| **Screeps Arena** | 官方文档：每个 WORK body part 每 tick 对 Source harvest 2 energy；每个 CARRY 可载 50；body-part cost：WORK 100、CARRY 50、MOVE 50、ATTACK 80、RANGED_ATTACK 150。Source 能量容量 1000、再生 10/tick。Spawn 生成 creep 每 body part 3 ticks，最多 50 body parts。[Arena 官方文档](https://arena.screeps.com/docs/)；[官方 constants 类型快照](https://github.com/screeps/arena-definitions/blob/master/common/typings/game/constants.d.ts) | Source 持续再生至 1000；Arena 中单位的生存、抢矿及对局 tick limit 取决于具体 arena mode，不能拿 MMO World 的通用常量替代。 | 可拼装系统有明确机会成本：经济 WORK 与搬运 CARRY 占用同一 body/cost 预算。model-war 固定农民可借鉴“有效采集劳力也有单位造价/产能”的权衡，但不宜照搬 body-part cost。 |

### 2. 战斗、单位效率与射程

| 先例 | 原规则 | 解释 / 对比边界 |
|---|---|---|
| **Screeps Arena** | 官方文档每个 ATTACK part 造价 80、近战 30 hits/tick、相邻目标；RANGED_ATTACK 造价 150、单体 10 hits/tick、距离至多 3；rangedMassAttack 对 3 格内目标按距离造成 1/4/10。Creep 最大 50 body parts，每个 body part 100 hits；MOVE 每 tick 减疲劳 2，实际速度受身体构成/疲劳影响。[Arena 文档](https://arena.screeps.com/docs/)；[Arena 常量源码声明](https://github.com/screeps/arena-definitions/blob/master/common/typings/game/constants.d.ts) | 单体 DPS/部件成本上，近战约 30/80=0.375 hits/(tick·energy)，远程单体约 10/150≈0.067；远程的额外价值来自射程、先手输出机会和群体攻击，而不是裸 DPS。不能将这个比值照搬到 model-war：Screeps 有部件损伤、行动冲突与可拼装，model-war 是单血池、同 tick 同时伤害。 |
| **Halite III** | 所有移动进入同一格时碰撞者被销毁；没有攻击 damage/HP/unit speed 面板。船在一 tick 只能移动一格或留在原地；挖矿/移动分别受经济成本影响。[交易与回合结算源码](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/command/Transaction.cpp) | 战斗成本不是“打掉多少 HP/损失多少 DPS”，而是路径、碰撞概率、货物和时间。因此只能借用机会成本方法，不能作为 C1–C6 的兵种属性参照。 |
| **Halite IV** | 最少 cargo 的船在碰撞中获胜并掠夺 cargo；同 cargo 平手则全部毁灭，敌方 shipyard 可被摧毁。[官方规则](https://www.kaggle.com/competitions/halite-iv-playground-edition) | 携带资源同时是胜负分数、经济储存和碰撞强度，令“兵力单位价值”随当前 cargo 变化；与固定 HP/DPS 制差异很大。 |
| **Lux AI S2** | 无常规攻击单位；Light/Heavy 碰撞相遇时 Heavy 可消灭 Light，同重量级碰撞看是否移动及 power；单位可 dig 对方 Lichen，Light 每次减 10、Heavy 减 100。移动、挖掘耗 power，昼夜影响充电。[规则](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/specs.md)；[结算实现](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/luxai_s2/luxai_s2/env.py) | 以尺寸/能量/power 换强度，且通过资源处理与目标价值体现军事机会成本，不存在可供直接映射的单位 HP:damage 比。 |

**跨游戏可迁移的结构性结论**：没有一个同类游戏同时提供“最强成本效益的线兵 + 高机动溢价 + 远程保护”且所有单位在固定单血池下对拼的统一标杆。Arena 提供武器射程/伤害的例子；Lux/Halite 提供经济与争夺机会成本的例子。model-war 的 C1–C6 应作为本项目自己的实验约束，用单位等成本对拼与基准策略验证，不应声称是竞品已验证的比例。

### 3. 节奏、终局与滚雪球控制

| 先例 | 时长与终局 | 节奏机制/可移植启发 |
|---|---|---|
| **Halite III** | 300–500 回合随地图边长变化（32–80）；也可因只剩一方可继续行动、全图矿与船上货物耗尽而提前结束。[引擎源码](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/config/Constants.hpp)；[终局条件](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/HaliteImpl.cpp) | 有限矿供给及“携货仍未存入银行不计入最终分数”的回收压力；III 官方引擎允许同格碰撞全灭，碰撞 cargo 被倾倒回格/持有方经济，竞争可直接毁掉对手采集投资。[碰撞源码](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/command/Transaction.cpp) |
| **Halite IV** | 最多 400 turns 或提前只剩一方。[官方规则](https://www.kaggle.com/competitions/halite-iv-playground-edition) | 每格再生至 500 限制完全枯竭；通过“矿格占用时不再生”、cargo 抢夺、Shipyard 风险维持竞争。 |
| **Lux AI S2** | 1000 turns；全 factory 被摧毁可提前败北，否则 Lichen 终局计分。[官方规则](https://github.com/Lux-AI-Challenge/Lux-Design-S2/blob/main/specs.md) | Lichen 同时是终局分数和工厂 power 来源；每 tick 未浇水 Lichen 衰减，扩张需持续支付水，形成“增长—维持”的长期资源压力，不是简单倒计时收缩圈。 |
| **Screeps Arena** | 对局时限是 arena mode 的规则量。官方 Screeps arena-definitions 公开快照中 Season 4 Pain and Gain Basic `TICKS_LIMIT=2000`、Advanced `TICKS_LIMIT=5000`。[Basic constants](https://github.com/screeps/arena-definitions/blob/master/6a86d8c454a3948a1e35f90c/typings/season_4/pain_and_gain/basic/constants.d.ts)；[Advanced constants](https://github.com/screeps/arena-definitions/blob/master/6a86d8c454a3948a1e35f90d/typings/season_4/pain_and_gain/advanced/constants.d.ts) | 不同赛季/arena rules 不同；该 tick 数只能证明具体官方 Arena 的量级，不代表全部 Screeps Arena 对局。 |

以上都是**规则回合上限**，不是实测“典型对局时长”的统计。公开一手规则足以核对最长 tick 数与提前终局，但没有找到可跨这些游戏直接比较、定义一致的典型时长数据集，因此不将上限冒充平均时长。

### 4. 平衡验证与调参证据

| 先例 | 一手来源中确证的做法 | 可借鉴的统计/工具 |
|---|---|---|
| **Halite III** | 官方 starter kit 支持 CLI 本地对战，能调地图大小、seed、对手；官方开发文档明确建议用固定 seed 重放地图调试。[starter kit README](https://github.com/HaliteChallenge/Halite-III/tree/master/starter_kits)；[Developing a Bot](https://halite3webapp.azurewebsites.net/learn-programming-challenge/developing-a-bot) | 固定 seed 的同图对照、自对弈、回放/引擎统计。引擎公开记录 total mined、deposited、carried at end、ships peak、碰撞等比赛统计，可用于辨别“采集高但未回收”等失衡。[统计更新源码](https://github.com/HaliteChallenge/Halite-III/blob/master/game_engine/core/HaliteImpl.cpp) |
| **Lux AI S2** | 官方仓库给出本地 `luxai-s2 bot1 bot2` 对局、保存 replay、运行 local tournament 以 mass-evaluate agents 的方法；starter/sample agent 和配置也在仓库。[官方仓库 README](https://github.com/Lux-AI-Challenge/Lux-Design-S2) | 同一批 seed/回放比较胜率、终局 Lichen、factory 存活、资源与 power 利用；Kaggle 官方页面描述提交时先与自身跑 Validation Episode，再进相近 rating 的对战池，评分反映胜/负/平而非分差。[官方竞赛说明](https://www.kaggle.com/competitions/lux-ai-season-2-neurips-stage-2) |
| **Screeps Arena** | 官方文档定义 arena API 与 `ticksLimit`；Arena 官方公布以 arena rating 进行匹配/赛季 ladder 的产品机制。[官方文档](https://arena.screeps.com/docs/)；[官方 Steam 页面](https://store.steampowered.com/app/1137320/Screeps_Arena/) | 能确认 ladder 对玩家策略评分，但公开来源未给出开发者用于重标规则的统一基准 bot、自对弈轮数或统计验收口径。不能声称官方采用了某个特定平衡流程。 |
| **Halite IV** | Kaggle 官方 Playground 页面有可复现规则和本地 agent 环境说明；可用于固定 map seed / opponent 做对照。[官方规则页](https://www.kaggle.com/competitions/halite-iv-playground-edition) | 规则页并未给出用于规则数值平衡的正式统计方案；不要把参赛 bot 的策略分析文章作为官方平衡证据。 |

## 面向 model-war v1 的起步区间建议（仅量级）

这些是等待 `.scratch/rules-calibration/issues/02` 工作台和基准 bot 仿真核验的**候选搜索范围**，不是定案值。

| 参数轴 | 建议先搜的量级 / 关系 | 理由与限制 |
|---|---|---|
| 采集 | Worker 每个有效采集 tick **约 1–10 资源**；同时把携带上限设为约 **20–50 个有效采集 tick**的产出量，再纳入往返路程算单农净产出。 | Arena WORK 2/tick、Lux Light 2/次 dig 且 cargo=100（50 次）；Heavy 20/次、cargo=1000（50 次）。注意 Lux dig 有 power 成本，Arena CARRY 有单位构成成本；该关系是初始探索尺度，不是“最佳”值。 |
| 起始资金 / 兵造价 | 初始资源先试约 **3–6 个基准兵造价**；生产/扩张性投资约 **2–5 个基准兵造价**，然后用开局“补工人还是出兵”是否两者皆可行作验收。 | Halite III 初始资金=5 艘造价、dropoff=4 艘造价；Lux starting pool 以每 factory 150 water+metal 为尺度，但不能把不同资源种类合成 model-war 的货币。 |
| 兵种性价比 | 以 melee 作为归一化成本 1×；高机动兵先搜 **≥2× melee 成本**，并把额外预算尽量支付给移动选择权，不要同步给到同等的正面对拼效率；ranged 的成本/输出与射程优势分开扫。 | Arena ATTACK 与 RANGED_ATTACK cost 分别 80/150，damage 30/10 且 ranged range=3；但有群伤、body composition，不能把 1.875× 当成 model-war 定值。遵循 GDD C1–C6 做穷举/等成本模拟。 |
| 单位制造时间 | 初始试造价的一小段线性比例或 **数个至十余 tick**的固定生产时长，并和可用生产基地数一起看。 | Screeps Arena 每 body part 3 ticks，但可拼装；model-war spawnTicks 为固定兵种生产预算。来源只支持“时间与造价有显著关系”的参照，不支持唯一比例。 |
| 对局长度 | 先以 **数百至约一千 tick**为搜索窗口，优先确保经济回路、第一次扩张、一次主力交战和终局压力都能发生；之后按实际策略/地图校准。 | Halite III 300–500、Halite IV 400、Lux S2 1000、Arena S4 Pain and Gain 2000/5000。回合语义和局面规模迥异，故推荐窗口不等于统计平均值。 |
| 终局 / 枯竭 | 若坚持有限储量，先让“理想化全员开采能力”在 `tickLimit` 内**理论可采空**，再用包含移动/交付的基准 bot 检验实际采空压力；若不能采空，应诚实将资源耗尽从终局压力目标移除或改变总储量/再生机制。 | Halite III 源码将全图能量统计纳入早停判断；Halite IV 则改为 2% 再生、cap 500；Lux 用 Lichen 衰减与水耗形成另一类末局压力。三者机制不应混写。 |
| 统计 | 固定多个地图/种子；每策略互换座位；报告 win/placement、首次扩张 tick、资源净收入、worker 存活、兵种损失/交换、点位易手、终局资源与胜负差。 | Halite 引擎本身记录采集、回收、携带、碰撞、舰队规模；Lux 竞赛自对弈 validation 和 rating 配对；这些支持测量口径选择，但不能代替 model-war 四方基准脚本实验。 |

## 对后续定案的直接约束

1. **经济**：收入口径用一次完整往返净收益；分别报告 `harvestRate`、携带满载时间、矿到基地往返时间、交付频率、矿剩余量。只比较每 tick 的原始 harvestRate 会误判。
2. **兵种**：先按成本等值构造双方，再同时结算攻击并测胜率/剩余 HP；另外测“从接敌距离开始到近战贴身”的时间。远程射程带来的免费攻击 tick 是其真实溢价，不能只用面板 DPS。
3. **时间轴**：分别报告 25/50/75/100% tick 的控制点、资源余量、兵力、基地数与尚未解决的战斗；回合上限只是预算，不是“典型时长”的证据。
4. **滚雪球**：区分“领先带来的经济/产能扩大”与“落后方仍可争点/阻断/偷袭”。Halite IV 的再生/抢货、Lux 的持续目标计分各自给到追赶窗口，但都不能替代本项目的四方反制实验。
5. 公开一手来源没有给出可直接套用的平衡终值，也没有统一定义“性价比”“典型对局时长”或滚雪球指标。最终区间与数值必须由本项目工作台和基准策略验证。
