# 02: 规则集形状:22 键清单与派生量

**What to build:** 一份规则集 JSON 能走 01 立好的那条校验通路,被接受或被带诊断拒绝。22 个参数键(13 个定稿 + 9 个预算)有一份带类型与量纲的机器可读清单,清单的取值类型与 JSON Schema 由同一次书写产生,两者的错位由类型级断言当场抓住。派生量双存并强制一致:取值文件里写的生产耗时,必须等于由系数算出来的那个。

**Blocked by:** 01 地图形状与 ajv 校验器通路

**Status:** resolved

- [x] 22 键清单落成:13 个定稿键 + 9 个预算键,每个键带它的 JSON 值类型、量纲(若有)与取值范围;清单**不是**一个裸的键名数组 —— **落的是 21 个**(13 定稿 + 8 预算),「22 = 13 + 9」把派生的内存软阈当预算键数了一遍,详见下面的「一处必须让后来者知道的偏差」
- [x] 键清单里每个键的取值类型与该键在 JSON Schema 中的定义由**同一次书写**产生,不是两处各写一遍
- [x] 规则集的 TypeScript 类型与 JSON Schema 落成,**禁止额外属性**,并有「多一个键即被拒」的反例
- [x] 一致性断言两条:①同一组 fixture 既过 TypeScript 类型又过 ajv;②一条类型级断言,要求 JSON Schema 的必填键集合等于对应类型的键联合
- [x] 生产耗时系数与满产烧钱率作为**真源包的常量**导出(它们不是取值文件里的键,却是派生式的一部分,留在代码里就等于第二真源)
- [x] 派生量双存:生产耗时在取值文件里有值、也能由「造价 × 系数」向上取整算出;**两者不相等即拒**
- [x] 内存软阈**不进键清单**——它是纯展示项,落进取值文件只会多一个能填错的格子
- [x] 9 个预算键在 M1 阶段**必填**;**缺键**与**键存在但取未定值**是两种不同的错误,各自被拒(实际 8 个,同上)
- [x] 预算键取未定值时被接受,且这个语义以可被生成器消费的形态暴露(键清单能区分「未定的值」与「一个真的 0」),使日后面向模型的规则文档能把它渲染成「未定」而不是数字
- [x] 规则版本号在取值文件名 / 规则文档目录名 / 真源包常量三处的一致性由机器判定
- [x] 一份完整的合法规则集被接受;缺键 / 错型 / 额外键 / 版本错配 / 派生量不自洽五种坏数据各自被带诊断拒绝

---

## 交付说明

### 落点

| 文件 | 一句话 |
|---|---|
| `packages/schema/src/ruleset-keys.ts` | 21 个键的机器可读清单:值类型 + 量纲 + 取值范围 + 标定状态 + 面向模型的说明 + **它在 JSON Schema 里的定义**(同一次书写) |
| `packages/schema/src/ruleset.ts` | 规则集的 TS 类型、派生量常量(`SPAWN_TICKS_COEFFICIENT` / `FULL_PRODUCTION_COST_RATE` / `MEMORY_SOFT_THRESHOLD_RATIO`)、由键清单投影出来的 `RULESET_JSON_SCHEMA` |
| `packages/schema/src/index.ts` | 新增两个域文件的再导出(仍是唯一入口) |
| `apps/cli/src/validator.ts` | 同一个 Ajv 实例上再加一个 `validateRuleset` + 两个装载期断言(版本三处一致 / 派生量自洽);拒绝结果的构造收敛成一个 `rejectionOf` |
| `apps/cli/src/validator.test.ts` | 副缝上规则集那半的全部断言(含第二条类型级断言、五种坏数据、两层诊断) |
| `apps/cli/src/validator.prop.ts` | 「任意 JSON 值不抛未捕获异常」那条属性扩到规则集入口 |
| `packages/schema/src/ruleset.test.ts` | 键清单自身的不变量(数目、标定状态、条目完整性、投影同源、系数能重算 handoff 定稿值) |

### 一处必须让后来者知道的偏差:键是 21 个,不是 22 个

spec 与 DAG 节点表都写「22 = 13 定稿 + 9 预算」,而:

- handoff §2.1 的表只有 9 **行**,其中「内存软阈 = 0.8 × `memoryTickCeiling`」那一行自己写着
  「推导项,**入表不入 schema**」——所以 9 那个数把一个**派生展示项**当预算键数了一遍;
- hld §5.3 收口句列的上限取值**恰好 8 项**(事件计数上限、API 上限、`memoryLimit`、
  `memoryTickCeiling`、墙钟软限、墙钟硬超时、`exceptionTickLimit`、脚本体积上限),
  与本清单的 8 个预算键一一对应;
- 仓库里**不存在**第 9 个预算取值(中断计数粒度与 WASI 三件套按 spec《常量表的边界》
  归沙箱执行器,不是键;`点位数量不变量` 归 map-lint 断言,不是规则集键)。

故键清单落 **21 个**。取舍:没有为了凑数造第 9 个键——键名一旦定了就是接口,造一个没有上游
依据的键比少一个键坏得多。来历写在 `ruleset-keys.ts` 的头注里(那里是这件事的家),
并由 `ruleset.test.ts` 的「键清单就是 21 个键」钉住。**这一条建议回写 spec 与 DAG 节点表**,
本票不改那两份文档(它们是上游裁决,不是我该单方面改的)。

### 8 个预算键与 4 条兵种线的最终英文键名

上游只给了 3 个英文名(`exceptionTickLimit` / `memoryLimit` / `memoryTickCeiling`),
其余 6 个在 handoff §2.1 里是中文描述。定名规则:**沿用已有三个的构词法**(camelCase、
`<被限量><限定>`),并让「per tick」的限制在名字里显形(与 `memoryTickCeiling` 的
「tick 末读数」区分开)。这 6 个名字是**本票新定的接口**,与已有三个风格一致:

| 上游描述(handoff §2.1) | 量纲 | 最终键名 | 命名依据 |
|---|---|---|---|
| `exceptionTickLimit` | 次(整局累计) | `exceptionTickLimit` | 上游已给 |
| 控制流事件计数上限 | 次/tick | `eventTickLimit` | 「控制流事件」= hld/gdd 的计量口径名,键名取 `event`;`Tick` 表明是单 tick 的上限 |
| API 调用计数上限 | 次/tick | `apiCallTickLimit` | 同上,取 `apiCall` |
| `memoryLimit` | bytes(VM 线性内存) | `memoryLimit` | 上游已给 |
| `memoryTickCeiling` | bytes(tick 末存活堆) | `memoryTickCeiling` | 上游已给 |
| 墙钟软限 | ms(只观测) | `wallClockSoftLimit` | `wallClock` + `Soft` + `Limit`,与硬超时的 `Timeout` 配对 |
| 墙钟硬超时 | ms(只作废该场) | `wallClockHardTimeout` | 同上;它与软限不是一回事(作废 ≠ 判罚),所以名字也不同 |
| 脚本体积上限 | bytes(顶层脚本) | `scriptSizeLimit` | `scriptSize` + `Limit`;注意它是**数值键**,hld §6.2「不进名单」说的是沙箱 API 名表 |
| (内存软阈 = 0.8 × `memoryTickCeiling`) | — | **不是键** | 派生展示项;只有系数 `MEMORY_SOFT_THRESHOLD_RATIO` 作为常量存在 |

| 兵种线 | 键名(6 个子字段) |
|---|---|
| 农民 | `worker` = `{cost, hp, damage, range, speed, spawnTicks}` |
| 近战 | `melee` = 同上 |
| 远程 | `ranged` = 同上 |
| 骑兵 | `cavalry` = 同上 |

四条线共用**同一份字段表**(`UNIT_STATS_SCHEMA`,清单内一次定义、四处引用):它们是同一种
对象的四个实例,不是四种形状,各写一遍就是给同一形状造了四份真源。`RULESET_UNIT_KEYS`
由清单里 `valueType === "unit-stats"` 投影而来,派生量断言遍历它,不再另写名单。

### 几处需要后来者知道的判断

1. **取值文件是平铺的 21 个键**,没有把四条兵种线嵌进一个 `units` 对象。依据是 handoff §1
   把它们列为 `rulesets/v1.json` 的顶层键,而嵌套会让「键清单」与 `required` 的键集合断言
   变成两种形状的对比(清单要按路径写、类型要按嵌套写),也就没有「同一次书写」可依。
2. **版本号不在取值文件里**。它由三处名字承担(文件名 / 规则文档目录名 / `RULESET_VERSION`),
   所以 `validateRuleset` 的第二个参数 `RulesetProvenance` **必填**:让文件名与目录名由调用方
   交进来(纯函数不读盘),但**没有「跳过版本检查」的静默后门**。若版本号既在文件名里又在内容里,
   那就是两处可能各写各的。
3. **三道判据的顺序**:形状(ajv)→ 版本三处一致 → 派生量自洽。理由是「先说最可操作的那条」:
   形状不对时先修形状;形状与版本都过了,兵种表才可能被读出数值,此时不一致是数据自相矛盾。
4. **`spawnTicks` 的派生断言收齐四条线的诊断再返回**,不是发现第一条就早退——「错了两条」
   与「错了四条」对模型是两件难度完全不同的事,逐条早退会把一次回喂变成四次。
5. **键清单里 `minimum` 对兵种对象键不给**:给了会让人以为对象也有大小写,范围在它的六个
   子字段上。运行期断言(`integer` 键必须有下界、且下界要真的进 schema)盯着这件事。
6. **本包多了一个此前没有的东西:几行 `Object` 投影**(`RULESET_KEYS` / `RULESET_UNIT_KEYS` /
   `propertiesOf`)。hld §3.2 的「无运行时代码」按「没有逻辑、没有读盘、不依赖任何包」理解
   (依赖门禁 `schema-has-no-dependencies` 盯的是依赖)。替代方案是手写 21 条 `properties`
   加一条 21 项的 `required` 数组,那正是 spec《参数键清单与派生量》要避免的「两处各写一遍」。
   另有一处 `as` 断言(`Object.keys(...) as RulesetKey[]`),它由三条断言盯着:
   两条类型级断言加 `ruleset.test.ts` 里把 `required` 与 `RULESET_KEYS` 逐项比对的运行期断言。

### 反例清单(每条都现做现验过,验完还原)

| 断言 | 弄红的手法 | 红灯 |
|---|---|---|
| 额外属性禁令(规则集) | `RULESET_JSON_SCHEMA` 的 `additionalProperties` 改成 `true` | 「多一个字段即被拒」+「properties 与 required 都由键清单投影而来」 |
| 键集合一致性(①类型加键) | 给 `Ruleset` 类型加一个清单里没有的键 | `tsc -b` 三处:`ruleset.test.ts:40` 与 `validator.test.ts:57` 两条 `TS2344` + fixture 缺字段 |
| 键集合一致性(②清单加键) | 键清单加一个类型里没有的键 | `tsc -b` 同样两条 `TS2344`(两个方向都红) |
| 派生量自洽 | `SPAWN_TICKS_COEFFICIENT` 0.5 → 0.6 | validator 侧 8 条(含「完整合法规则集被接受」)+「生产耗时系数能重算 handoff 定稿值」 |
| 版本三处一致 | `expectedRulesDocDirName` 写死成 `"docs-v1"` | 「规则版本错配在装载期被拒」及 7 条以「合法基线先过一次」开头的用例 |
| 未定值语义 | 一个预算键的 `calibration` 改成 `{state:"final"}` | 「13 定稿 + 8 预算,按标定状态分得开」「8 个预算键标为未定值…」 |
| 缺键仍被拒 | 清单里 `scriptSizeLimit` 改名(等于这一格不再必填) | `tsc -b` 两条 `TS2344`,门禁在编译期就停 |
| 内存软阈不入键清单 | 把 `memorySoftThreshold` 同时加进类型与清单(让它编译得过) | 「键清单就是 21 个键」「13 + 8 分得开」「内存软阈不入键清单」+「必填键集合就是 21 个键」 |
| 占位 0 真的合法 | 一个预算键的 `minimum` 与 schema 下界改成 1 | validator 侧 8 条(含「预算键取未定值 0 被接受」)+「8 个预算键标为未定值…」 |
| 面向模型层合并(规则集) | `renderModelDiagnostics` 改成逐条输出 | 地图那条 + 规则集的「缺预算键」「派生量不自洽」两条合并断言 |
| 属性:不抛异常 | `validateRuleset` 遇到非对象就 `throw` | 「规则集同样如此:任意 JSON 值进去……不抛」 |

`pnpm run check`、`pnpm run test:props`、`pnpm run test:gates` 均在 0 退出。

### 与后续票的接口

- **E 节点**:`RULESET_KEY_CATALOG` 就是 `rulesets/vN.json` 与 `docs/rules-vN` 数值表的输入。
  渲染「未定」读 `calibration.state`(判别式,不是「值是不是 0」);行序读 `RULESET_KEYS`;
  键的说明读 `description`(与 JSON Schema 的 `description` 同源,不会两处漂移)。
  **未注册生成物**:票面没要求,等 E 接文档生成时按注册表加行。
- **K 节点**:标定完 8 个预算键的终值时,把它们的 `calibration` 一次改成 `{state:"final"}`,
  取值文件填正数——校验器已经接受正数(`K_CALIBRATED` 那条 fixture 盯着)。
- **D / G 节点**:`scriptSizeLimit` 是规则集里的数值键,静态校验器从规则集读它;
  沙箱的 API 名表是另一件事(名单类数据归真源包,数值键归规则集)。
