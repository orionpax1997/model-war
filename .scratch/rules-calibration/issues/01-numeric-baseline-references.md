# 先例数值区间参照(research)

Type: research
Status: resolved

## Question

为 gdd §7 参数找**起步区间参照**:同类"编程对战"游戏(Halite III/IV、Lux AI Challenge、Screeps / Screeps Arena)的经济-战斗-节奏数值区间与调参方法,逐条核对一手来源(官方文档、规则仓库、开源引擎源码),不采信二手转述:

1. 经济面:采集速率 / 携带上限 / 造价比值、资源枯竭设计(有限矿 vs 再生)、开局经济曲线;
2. 战斗面:单位 cost/HP/damage/speed 的比值结构(是否存在"性价比标杆"与"机动溢价"的类似设计)、射程与集火机制;
3. 节奏面:典型对局时长(tick/回合量级)、终局压力机制(收缩圈 / 判分 / 资源枯竭)、滚雪球抑制手段;
4. 调参方法:它们如何验证平衡(基准 bot、自对弈、统计口径)。

产出:参照表 + 每条的出处引用 + "v1 起步区间"建议(只给量级,不给终值——终值归定案票)。本地已有 `docs/competitors/llm-skirmish.md`、`docs/competitors/screeps.md`,以它们为线索但回到一手来源核实;新事实写进 findings 文件,票里只留结论与链接。

## Answer

一手来源参照表、各机制的不可直接类比边界、调参/验证证据及 v1 起步搜索量级，见 [findings/01-numeric-baseline-references.md](../findings/01-numeric-baseline-references.md)。主要结论：Halite III/IV、Lux S2、Screeps Arena 分别覆盖有限/再生矿、采集生产、可拼装战斗和回合终局等局部先例，但没有一款能直接给出 model-war 的固定单血池兵种性价比终值；C1–C7、经济净回路与终局压力仍须在工作台和基准策略中实测。Findings 中的数值建议仅作候选搜索量级，不是终值裁决。
