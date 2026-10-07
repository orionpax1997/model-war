# 基准脚本目录

三份基准脚本:每份一份**源码**(`script.ts`)+ 一份**编译产物**(`script.js`)+ 下面这张说明表。
产物入库的理由是门禁的第一印象——clone 完直接能跑,不该每次先构建一遍;
因此「入库的产物就是 `tsconfig.scripts.json` 真跑出来的那份」由门禁 `check:bench` 逐字节判,
不由人记。产物是怎么跑出来的见 §4。

> **口径(本轮重写):这三份是本轮(`§5`/`§9` 已落库的终稿契约)的读数,与另外两批都不可互比。**
> ① 上一轮 `.scratch/rules-landing/blind/` 三舱跑的是**同一份终稿契约、但 §5/§9 落库之前**的那一版
> (占领整节是占位,三舱各自猜机制;那份「站相邻」脚本在真规则下 `captures` 恒 0)。契约散文补了
> 两节,读数因此另起一代,不能拿上一轮三舱当本轮的基线或对照。
> ② 旧四舱(`.scratch/rules-calibration/`)跑的是**草案契约**、交付名 `script.v1.js`,契约形态
> (座位自认、错误判别、占领机制)、移动层与错误处理三层都变过。
> 因此本轮三份的读数**不可与旧四舱的读数互比**,也不可与上一轮 rules-landing 三舱互比——
> 旧四舱的胜负、交付量、经济死亡 tick 等一切数字都不能拿来当本轮的基线或对照。
> 可以互比的只有两件事:**模型档位**(本轮两模型档 `deepseek-v4.1-flash` / `MiniMax-M3` 未换)与
> **隔离舱脚本形态**(同一份脚本,只改了投放文档与交付名)。三批之间逐条变的理由,见本轮判读
> `.scratch/contract-closure/verdict-2026-10-07.md` 与上一轮判读
> `.scratch/rules-landing/blind/verdict-2026-10-04.md` §6。

## 1. 说明表

**策略标签是行为描述,不是能力评级**——它说的是这份脚本在规则下实际做了什么,
不是它强不强。三行读出来确实是三种打法,不是同一份脚本换了个名字。

| 目录 | 策略标签(行为描述) | 标签的行为依据 | 模型标识 | 生成参数 | 静态校验结果 | 契约版本 | 源码体积 | 产物体积 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cell-a-melee-pressure/` | A 爆兵压制:留 2 个农民,其余全投近战 | 每个自家基地先读 `producing`,空才下单;农民下限 2,其余全投 `melee`;农民满载回家 `transfer`、否则在自家资源点 `harvest`;战斗单位取**全场最近的敌方单位**,射程内 `attack`、射程外 `moveTo` 追;全场无敌人时压向最近的非己方点位并 `moveTo` 到**点位格坐标**(站上去驱动占领) | `commandcode/deepseek/deepseek-v4.1-flash` | `--thinking high`;单流;bwrap 隔离舱;舱内交付名 `script.v1.ts`;11.9 min;契约回喂 0 轮(一次输出撞长度上限,`pi --continue` 续写,非回喂) | 零违规(err 0 / warn 0) | `v1` | 5968 字节 | 6310 字节 |
| `cell-b-expansion-economy/` | B 扩张运营:5 农起步(250 tick 后维持 3)、其余投近战,派 1 农占中立矿 | 生产目标 `workerCap = 5`(tick < 250)之后再维持 3,其余全投 `melee`,先读 `producing` 空才下单;农民满载在相邻己方基地 `transfer`、否则在**己方**资源点 `harvest`;**工人够 4 个且存在中立资源点时**,把其中一个标为 capturer `moveTo` 到中立资源点的**点位格坐标**(已在点位格上就本 tick 不发意图,让进度推进);战斗单位射程内 `attack`,否则追最近敌方单位 | `minimax-cn/MiniMax-M3` | `--thinking high`;单流;bwrap 隔离舱;舱内交付名 `script.v1.ts`;11.8 min;契约回喂 0 轮 | 零违规(err 0 / warn 0) | `v1` | 6675 字节 | 7579 字节 |
| `cell-c-claim-no-harvest/` | C 占点(不采集):零农民纯近战占点 | 只造 `melee`,每个空产线一单,余额 < 8 停手;**全程不造农民、不调 `harvest`、不调 `transfer`**;开局 16 资源出 2 个近战后归零,**经济死亡且不可逆**,靠占点与残兵继续;射程内有敌人就 `attack`,否则认领一个未占点位并 `moveTo` 到**点位格坐标**,已在点位格上就原地驻守(`if (u.x === tgtX[pick] && u.y === tgtY[pick]) continue;`) | `commandcode/deepseek/deepseek-v4.1-flash`(**降级**) | `--thinking high`;单流;bwrap 隔离舱;舱内交付名 `script.v1.ts`;5.9 min;契约回喂 0 轮;**编译面回喂 1 轮**(严格 `tsc` 的 `TS2345`×3,**非**契约静态校验回喂) | 零违规(err 0 / warn 0) | `v1` | 5104 字节 | 5556 字节 |

**两处口径随表一起带**:

- **C 舱降级一轴**:spec 的第三模型首选 `claude-sonnet-5`(端点分家最干净),但本机 pi 侧
  **未配 Claude / `/messages` provider**,按 J 的口径归 `wizard`,不在本格手搓;故 C 降级为
  `commandcode/deepseek/deepseek-v4.1-flash`——**只降模型一轴,不降验收**(M1 要的「≥2 模型 + 不同策略」
  由两模型档 + 三策略一次买下)。
- **体积是分列记录的**:脚本体积上限(`scriptSizeLimit`)的取值要以这三份的最大值为下限,
  所以两个数各自单列一栏,而不是合成一个「大小」。当前最大值是产物侧的 7579 字节(cell-b)。

**静态校验结果那一栏的口径**:契约静态校验器是 `.scratch/contract-closure/blind/static-check.ts`
(复用的一次性校验器,零违规 err 0 / warn 0),判的是能静态判的四层:
语法与入口形态、可见面白名单反转、禁列(`Date` / `Math.random` / `performance` /
`queueMicrotask` / `__*` 宿主桥)、全整数。**反向对照**也重跑了一遍:`blind/reverse-control/` 里
故意写坏的脚本被同一条命令判红(一次性校验器 **22 err / +2 warn**;freeze 判定链
`run-validate-script.ts` **退出码 1、3 类 8 处**),确认门禁没被放宽。**两件契约静态校验器判不了的**
另记:类型面(已回填,见 §4)与「每单位每 tick 单意图」(运行期语义,靠人读,三份都过)。

## 2. C 舱那个标签为什么这么写

`C 占点(不采集)` 是**沿用旧一轮的修正**。旧一轮那个标签是「农民海」,已按实测数据修正掉:
那份脚本几乎不采集,叫「农民海」是在描述一个它压根没做的事。**本目录不采用「农民海」这个标签。**

本轮的标签与「靠站相邻占点」的旧话**都改了**——本轮 C 舱不是「自己猜了一种机制」,它**读出了
「必须站上去」**:

1. **它全程不造农民**:生产只有一条线——每个空产线下一单 `melee`,余额 < 8 停手;
   源码里 `worker` 这个兵种名一次都没出现过。
2. **它不调 `harvest`、不调 `transfer`**:采集与交付两个动作在整份脚本里一次都没被调用。
3. **开局即经济死亡**:开局 16 资源出 2 个近战后归零,按 `docs/rules-v1/rules.md` §4.3
   经济死亡且不可逆——它就是靠占点与残兵继续的,而这恰好是契约 §4.3 写明的合法打法。
4. **它的占领靠「站在点位格上」**:契约 §5〈占领〉本轮**已落库**,写明了「站上去才驱动;
   站相邻格不累积、也不衰减、不产生任何错误码」。C 舱据此刻画行为——源码注释
   「已站在点位格上,原地即驱动占领」、思考原话「moving to a site's adjacent cell does nothing;
   must move onto the point's cell」。**这是读出来的,不是猜出来的**(与上一轮判读 §4 里那个
   猜「站相邻」的旧 c 舱形成对照)。

第 4 条同时是本轮相对上一轮的信息量:上一轮 §5 空着,三舱各自猜机制(两种互斥版本);
本轮 §5 落库,三舱都按同一条写。**契约缺口已补的证据在 `.scratch/contract-closure/verdict-2026-10-07.md` §3**,
不在这一栏里。

## 3. 契约版本与重跑规则

**契约版本:`v1`**(`rulesets/v1.json`、`docs/rules-v1/`、真源包的 `RULESET_VERSION` 三处一致)。

**换契约版本时,基准脚本一律重跑,不保留**:

- 契约**内容**一变更(含**不升版本号**的散文修订,如本轮 §5/§9 落库),「同一份脚本」这个前提就不成立了——§5 占领、§9 确定性、错误处理、快照字段任一处改动
  都会让读数失去可比性(抬头那条口径就是这件事的实证)。看重的是契约**内容**的变化、不是版本号本身:散文修订不升版(ADR 0008),但读数一样会变。
- 保留旧脚本冒充新版本的基准,等于把不可互比的读数接上可比的口径,比没有基准更坏。
- 所以新版本落地时:三份脚本**重新盲写一轮**、重新落库、重新出这张表;
  旧的三份连同它们的产物移出本目录(它们的证据仍在 `.scratch/rules-landing/blind/` 与
  `archive/` 侧,`archive/` 的冻结脚本永远入库,不会因为移出基准目录而消失)。
- 判读与「不可互比」那条口径必须跟着重写一遍,不许沿用。

**本轮已执行一次**:§5 / §9 落库就是契约换了版本的那一刀——旧三份「站相邻」脚本已移出 `benchmarks/`,
本轮三份由模型在同一份新契约下重新盲写、重新落库、本表随之重写。这是这条规则第一次被真正走过,
不再是纸面机制。

## 4. 编译产物是怎么来的

```bash
pnpm run build              # 工作区包的 dist(真源包的声明/常量要从那里读)
pnpm run bench:build        # 把三份产物按 tsconfig.scripts.json 重编译并写回 script.js
pnpm run check:bench        # 门禁:重编译结果必须与入库产物逐字节一致(挂在全量门禁 check 末尾)
```

产物用的是仓库根那份 `tsconfig.scripts.json`(票 06),由它派生一份**只覆盖 `files` 与 `outDir`**
的运行配置;编译在系统临时目录里做,所以「模块解析面被清空」在产物这件事上是真的。

**类型面已回填**(`packages/schema/script-api/index.d.ts`,归 F),所以「API 名字拼错」这类错误在
编译期就红——三份的「名字未声明」诊断已**全部归零**。`tsconfig.scripts.json` 刻意不设
`noEmitOnError`,`tsc` 在还有诊断的情形下照常 emit,那份产物就是门禁与生成管线将来真正加载的东西。
本轮 `pnpm run bench:build` 的退出码与诊断读数:

| 诊断类别 | 三份的条数(A / B / C) | 是什么的账 |
| --- | --- | --- |
| 名字未声明(TS2304 / TS2552) | **0 / 0 / 0** | **类型面已回填的验收信号**:这一类必须归零,归零意味着写错 API 名字的脚本从此在编译期就红 |
| 形参隐式 `any`(TS7006) | 0 / 0 / 0 | cell-c 本轮已给自身辅助函数的形参标注类型,这一类已消 |
| 可能为 `undefined`(TS18048 / TS2532) | 0 / 24 / 0 | cell-b 自己按下标取值,与类型面无关;归零不是回填的验收项 |

三类之外任何一条诊断都判红(门禁与测试都判)。因此编译退出码**不再是判据**:本轮 A / C 退出码 0,
B 退出码 2(只余 24 条 `possibly-undefined`),产物的可信度由 `check:bench` 的逐字节一致承担。
**本目录不替回填那一格把类型面填上**:真源包里那份声明由对局内核与沙箱执行器回填,
这一格只保证编译配置指向那个家。

## 5. 本目录不落的东西

- **存档元数据**:形状家已定在真源包(「位置已定、字段未交付」那一档),字段由**生成管线那一格**
  回填。真源包对这类东西有一条明令:**半截字段比没有更坏**——半截字段会让人以为形状已定稿,
  而回填是「加字段」不是「改字段」。所以这里一个存档 meta 文件都不写,本表里也不给半截字段,
  只在这个位置记着它由哪一格回填。
- **标定环的采集探针**(`farmer.js` / `farmer.calibration-v1.js`):它不是参赛脚本,
  是标定环的测量工具。按既有先例不进基准目录、不计入基准证据。
- **某模型的零产出存档**(`xiaomi/mimo-v2.6-pro` 的 7 次):失败记录不是基准。
  它随图保留在 `.scratch/` 侧,不进本目录。

以上三条由 `packages/tools/src/benchmarks.test.ts` 机器断言:本目录逐字只有三份脚本的
`script.ts` + `script.js` 与这份说明表,多出任何文件即红。

## 6. 复现本轮盲写

```bash
# 隔离舱脚本是本轮副本(与 rules-landing 原件同体例,改了 NODE_DIR / pi 挂载 / collect 白名单)
./.scratch/contract-closure/blind/blind-run.sh setup cell-a A
./.scratch/contract-closure/blind/blind-run.sh run  cell-a commandcode/deepseek/deepseek-v4.1-flash
./.scratch/contract-closure/blind/blind-run.sh collect cell-a      # b/c 同理
# 模型参数带 provider 前缀(如 commandcode/… 与 minimax-cn/…),三舱的 --thinking 都是 high

node .scratch/contract-closure/blind/static-check.ts cell-a cell-b cell-c
node .scratch/contract-closure/blind/static-check.ts reverse-control
```

判读全文:`.scratch/contract-closure/verdict-2026-10-07.md`(本轮)。真引擎 10 局读数:
`.scratch/contract-closure/replay-matrix.md`。

## 7. 机器防线:契约自证门禁

这三份产物不只是**证据**,还是一道门禁的输入:`check:selfproof`
(`node packages/tools/src/selfproof/run-selfproof-gate.ts`,挂在 `check` 末尾最后一道)拿终稿契约
把它们**过静态校验器 → 跑标定环那个桩的矩阵**,只回答四个外部可问的问题:

| 问 | 判据 | 本轮读数 |
| --- | --- | --- |
| ① 零静态违规 | 静态校验器逐份退出码 0(`--phase freeze`,`--max-bytes` 取三份入库产物的最大值——`scriptSizeLimit` 仍是占位 0) | 三份全 0 |
| ② 正常终局 | 每席 `exceptionTicks` 为 0 且终局原因属 `victory` / `shortcut` / `timeout` | 64 场 256 席,异常 tick 合计 0;终局原因 `shortcut×60` / `victory×4` |
| ③ 消耗 ≤ 总储量 1/4 | 每份脚本每席位消耗的中位与最坏单席都 ≤ 总储量的 1/4(配额现算,绝对值见那份报告的 ③ 行) | A 6.3% / B 1.5% / C 0.0%(席位中位),全批最坏单场 10.0%(321 / 3200),超配额 0 场 |
| ④ 取策略互不相同 | 每一对脚本在 9 项行为指标上至少 3 项相对差 ≥ 25% | 两两分别 9 / 7 / 5 项 |

矩阵是 4 臂(三张真图 + 一张无墙夹具对照,夹具与臂数与 gdd §8 记录 #13 那一轮逐字同)× 4 个座位轮转 ×
4 颗种子 = 64 场;跑正表前先过夹具闸门(`farmer6` 锚点 `p100=479` / `delivered=3080`)。
三份产物在**终稿契约**与**草案代桩**之间的五处缺口由宿主侧兼容层补齐,
补法与残余偏差记在 `packages/tools/src/selfproof/contract-compat.ts`——桩一行未改,
补法也不静默:换契约版本时**判据不变、门禁仍绿是正常的,而四问的取值会全部变**,
本目录这张表里的静态校验结果与本节的读数都不是回归基线。
完整报告(口径、逐臂读数、区分度矩阵)见 `.scratch/rules-landing/selfproof/report.md`。
