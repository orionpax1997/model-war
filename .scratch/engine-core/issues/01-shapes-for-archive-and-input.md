# 01: 冻结脚本存档与对局输入的形状定死

**What to build:** 两份跨进程数据形状从「只有散文描述」变成真源包里可校验的东西：冻结脚本的 `meta.json`（`archive-meta`）与单个对局的输入物化件（`input.json`）。落定之后，一份缺档、哈希不符或规则集版本对不上的对局输入**在脚本被执行之前就被拒**，而不是跑出一场用到错误产物的对局。

**这是本 feature 唯一一张横向的票，而且它不能推后。** 真源包有一条明令禁止写放行额外属性的空 schema 充位（见 `packages/schema/src/pending.ts` 的头注），所以「形状先有、字段后填」这条路在本仓是封死的；而 `modelwar match` 的第一件事就是装载输入。拖到脊柱那张票之后，等于让脊柱带着一个它被禁止自己用的东西往前走。

**顺带销掉一处「一个事实两个家」**：`hld.md:714-715` 已经把 `meta.json` 的字段逐项列全，而 `pending.ts` 记着「字段随 gen 管线写出的那一版确定」。按本仓采信顺序 `hld > …`，`pending.ts` 是错的一方，所以 `archive-meta` 这条 pending **提前定死**并从 `PENDING_SHAPES` 销掉，改写成「形状已定，字段值随生成管线落库」。`input.json` 的五项字段同样已被 `hld.md:721` 逐项列全，**它不作为 pending 条目加入**。

决策依据：`.scratch/engine-core/spec.md`《输入物化》《冻结脚本存档》两节。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 两份形状在真源包落库，三层齐：类型、JSON Schema、读入端校验。校验复用 `apps/cli` 那一侧**唯一一份 ajv 实例**（沿用地图与规则集那条先例），不新起第二个实例 → 类型 `ArchiveMeta`（`packages/schema/src/archive-meta.ts:55`）/ `MatchInput`（`packages/schema/src/match-input.ts:50`）；JSON Schema `ARCHIVE_META_JSON_SCHEMA`（`archive-meta.ts:105`）/ `MATCH_INPUT_JSON_SCHEMA`（`match-input.ts:78`）；读入端 `validateArchiveMeta`（`apps/cli/src/validator.ts:509`）/ `validateMatchInput`（`validator.ts:617`），两者复用 `validator.ts:121` 那**一个** `new Ajv({ allErrors: true })`，在 `validator.ts:130-131` 模块顶层各编译一次。真源包不 import ajv（`schema-has-no-dependencies` 门禁绿，`.dependency-cruiser.js:90`），`packages/schema/package.json` 未加任何依赖
- [x] 读入端诊断沿用已有的**两层**形态：机器层透出 ajv 原始条目，面向模型层渲染成短句并对同类错误合并成一行 → 逐字复用 `pointerOf`（改指 `required` / `additionalProperties` 点名的键）、`MODEL_PHRASE` 措辞表与 `renderModelDiagnostics`（按关键字合并）三处，**未新增渲染器**；本票只往措辞表里加三个自定义关键字的短句（`validator.ts:86/93/96`）。用例见 `validator.test.ts`「机器层透出路径 / 关键字 / 消息三样,面向模型层按类合并成一行」：五处坏（1 缺档 + 1 哈希）渲染成**两行**
- [x] `PENDING_SHAPES` 里 `archive-meta` 这条**销掉**，并写明「形状已定，字段值随生成管线落库」；`input.json` **不**作为新条目加入，理由逐字写进注释（字段已由 hld 逐项列全，不属于「随那一票的实现才确定」那一类） → `packages/schema/src/pending.ts:19` 的 `PendingShapeId` 只剩 `"match-result" | "replay-line"`，`:42` 的 `PENDING_SHAPES` 只剩两条；销账说明与「不加 `input.json`」的理由逐字写在 `pending.ts:18-41`（含「pending 那两条的共同特征是『字段随那一票的实现才确定』，而 `hld.md:721` 已把五项逐项列全」与「要么写空 schema，要么跳过读入端校验，两条都被纪律点名要拒」）。全仓 `PENDING_SHAPES` 零消费者（改前 `grep` 只有 `pending.ts` 自己），销条目未撞任何断言
- [x] `archive-meta` 的必填项与 hld §7.4 那一栏逐项对齐：模型标识、规则集版本、校验结果、编译版本、产物 sha256、sandbox-runtime hash → 十一项与 `docs/hld.md:714-715` 逐项对照表写在 `archive-meta.ts:6-20`（hld 的措辞 → 字段名 → 为什么是这个形状），`required` 十一项在 `archive-meta.ts:76-88`；运行期断言抄 hld 的名单（不是抄 schema）逐项比 `validator.test.ts:893`「meta schema 的必填键集合就是 hld §7.4 那一栏的十一项」。十一项 = 模型名 / 模型版本·快照标识 / 生成日期 / 协议迭代轮数 / 完整 prompt（逐轮）/ 生成日志 / ruleset 版本 / 校验结果 / tsc 版本 / `script.js` 的 sha256 / sandbox-runtime hash
- [x] **形状一次定死**：生成管线落地时只填值不改形状。改字段要走一次有意的变更，像改一个错误码名那样——这条理由写进注释，否则后来者会按「先加一个够用的字段」的直觉走 → `archive-meta.ts:22-29`（「形状一次定死」整段，含「直觉会骗人」与「已落库 `meta.json` / 引用它的 `input.json` 会被波及」）与 `match-input.ts:22-25`（同一条）。`pending.ts` 头注里「刻意不写空 schema / 刻意不写半截字段」那两条纪律保持不变，两条仍挂着的形状继续适用
- [x] 缺档（存档三件套不全）、产物哈希不符、输入缺项：校验器各给一条带定位的诊断。**本票只交诊断，不交退出码**——退出码语义归脊柱那张票 → 三条都在同一个 `ValidationRejection` 里一次收齐（`validator.ts:441-500` `archiveMetaDiagnostics` / `:557-604` `matchInputDiagnostics`，一次收齐的理由同 `derived-spawn-ticks` 那条）：缺档 `archive-files-incomplete`（meta 侧指针 `/`，因为缺的是目录里的东西不是文件里哪个键；input 侧指针 `/archives/<座位>`，实测指到 0/2/3 三座）、哈希不符 `sha256-mismatch`（指针 `/scriptSha256`、`/sandboxRuntimeHash`、`/archives/<座位>/scriptSha256`、`/archives/<座位>/metaSha256`、`/mapSha256`）、输入缺项由 ajv 的 `required` 给出（指针逐键）。**未设任何退出码、未加子命令**：hld §9 的六条不动
- [x] 规则集版本三处一致（规则集文件名 / 文档目录名 / 版本常量）在读入期断言，对不上即拒，不静默降级（FR-10 AC2 的错配拒跑） → 沿用 `validateRuleset` 的 `RulesetProvenance` 先例：`MatchInputProvenance`（`validator.ts:542-554`）两字段**都必填**，不留「跳过检查」的后门；`rulesetProvenanceDiagnostic(provenance, pointer, declaredVersion?)`（`validator.ts:312-341`）是**同一个**判据的复用，取值文件那一格传 `undefined`（它内部没有版本键），`input.json` / `meta.json` 那一格传声明值并把指针指到 `/ruleset`。四处错法（声明值改 / 装载方读到的版本改 / 文件名改 / 规则文档目录名改）各有一条用例
- [x] **`input.json` 不含赛季配置**：一条用例钉住「规则集那几项在，赛季那几项不在」。这条不钉住，后来者会把赛季参数塞进去，那份文件就会长成第二个赛季配置，而 FR-7 AC3 要的是「每个对局可凭它复算」 → `validator.test.ts:1142`「input:规则集那几项在,赛季那几项不在」：正向断言文件键集恰为 `archives/map/mapSha256/ruleset/seed`，再把 `season`、`seasonConfig`、`players`、`mapPool`、`seedCount`、`concurrency`、`rankPoints` 七项逐个塞进去，全部 `additionalProperties` 拒（指针逐个核对）。理由也写进注释（`match-input.ts:13-21`）
- [x] **每一类错各有一个能被弄红的反例**（改哈希 → 红、删必填项 → 红、改版本号 → 红）。没有反例的校验器等于没有校验器——沿用本仓「每条规则都有能被弄红的反例」那条纪律 → `validator.test.ts` 新增 18 条用例：改哈希（记录值改 / 实测值改两个方向 + 逐座位 4 次 + 地图 1 次）、删必填项（**meta 十一项逐项** + input 五项逐项，不是抽三项）、改版本号（meta 与 input 各两头）、缺档（三件套三种 × input 三座）、轮数与 prompt 条数不相等、错型、额外属性、根不是对象、诊断稳定。**变异实测**（改坏实现后跑同一文件）：关掉哈希比对 → 10 条红；去掉 `required` 里的一项 → `tsc -b` 非零（类型级断言 `ArchiveMetaSchemaRequiredKeysMatchType` 抓住，`validator.test.ts:718`）；关掉顶层 `additionalProperties` → 红；去掉 meta 的版本断言 → 红
- [x] 显式不写「放行额外属性」的空 schema：一条用例钉住「多一个未声明字段即拒」。放行额外属性的空 schema 等于不校验，却会让人以为「存档已校验」，比不写更坏 → 顶层与嵌套各一次：`validator.test.ts:1110`（meta 顶层 `/season` + `validation` 内 `/validation/checkedAt`，并直接断言 `ARCHIVE_META_JSON_SCHEMA.properties.validation.additionalProperties === false`）、`:1124`（input 顶层与嵌套元素内 `/archives/1/model`，并断言 `MATCH_INPUT_JSON_SCHEMA.properties.archives.items.additionalProperties === false`）。两份 schema 全层 `additionalProperties: false`，**没有**任何一处放行额外属性的空 schema；类型层对齐另有 `ArchiveMetaSchemaRequiredKeysMatchType` / `MatchInputSchemaRequiredKeysMatchType` / `MatchInputSeatCountMatchesSchema`（4 ↔ minItems/maxItems）/ `ArchiveMetaIsJsonValue` / `MatchInputIsJsonValue`（`type` 别名而非 `interface` 的哨兵）五条编译期断言

## Answer

**这张票的答案**：两份跨进程形状现在在真源包里有家、有校验、且每一类错都有一个能弄红的反例。落点：

- `packages/schema/src/archive-meta.ts`（新）：`ArchiveMeta`（十一项，全 `type` 别名）+ `ARCHIVE_META_JSON_SCHEMA`（`additionalProperties: false` 含 `validation` 那一层）。
- `packages/schema/src/match-input.ts`（新）：`MatchInput` / `MatchInputArchive`（`archives` 取**定长 4 元组**，下标即 `playerIndex`）+ `MATCH_INPUT_JSON_SCHEMA`。
- `packages/schema/src/index.ts`：两处 `export *`（按 ADR-0003，对外唯一入口）。
- `packages/schema/src/pending.ts`：`archive-meta` 销账，剩 `match-result` / `replay-line` 两条；销账与「不加 input.json」的理由逐字在注释里。
- `apps/cli/src/validator.ts`：**同一个** ajv 实例、模块顶层各编译一次；新增三个自定义关键字（`sha256-mismatch` / `archive-files-incomplete` / `archive-protocol-rounds-mismatch`）、两个 `Provenance` 类型、两个 `validateXxx`。诊断两层与合并渲染逐字复用既有实现。
- `apps/cli/src/validator.test.ts`：18 条新用例 + 5 条编译期断言（沿用该文件既有的 `bad*()` / `reject*()` 手法与 fixture 风格）。

**实测读数**：`pnpm run check` 绿（exit 0）——`check:quick` 全过、`lint:types` 全过、`unit+property` 37 文件 / **462 用例全过**（改前 444）、`check:deps` 45 模块 70 依赖零违规、`declared-deps` 42 文件无未声明引用、`drift` 注册 6 件无漂移、`bench` 3 份逐字节一致。

**反例探针实测**（一次性探针 `apps/cli/src/zz-counterexample-probe.test.ts`，跑完即删、不入库；正例先断言两条都通过，27 个坏输入逐个跑）：
正例 `meta` 与 `input` 均通过。随后每一条都按预期被拒，且**每条诊断都带定位**：

| 坏法 | 机器层关键字 → 指针 | 面向模型层短句 |
|---|---|---|
| 改哈希① `meta` 记的 `scriptSha256` | `sha256-mismatch` → `/scriptSha256` | `记录的哈希与实测不符:/scriptSha256` |
| 改哈希② 实测值变（`meta` 照旧，反向） | `sha256-mismatch` → `/scriptSha256` | 同上 |
| 改哈希③ `sandboxRuntimeHash` | `sha256-mismatch` → `/sandboxRuntimeHash` | 同上 |
| 改哈希④ 座位 2 的 `script.js` 哈希 | `sha256-mismatch` → `/archives/2/scriptSha256` | 同上 |
| 改哈希⑤ 地图实测哈希变 | `sha256-mismatch` → `/mapSha256` | 同上 |
| 删必填项① `meta.validation` | `required` → `/validation` | `缺少必填字段:/validation` |
| 删必填项② `meta.prompts` | `required` → `/prompts` | `缺少必填字段:/prompts` |
| 删必填项③ `input.mapSha256` | `required` → `/mapSha256` | `缺少必填字段:/mapSha256` |
| 删必填项④ `input` 只给三座 | `minItems` → `/archives` | `数组元素数不足:/archives` |
| 改版本号① `meta` 声明 v2 | `ruleset-version-mismatch` → `/ruleset` | `规则集版本三处不一致(取值文件名 / 规则文档目录名 / 版本常量):/ruleset` |
| 改版本号② 装载方读到 v2 | `ruleset-version-mismatch` → `/ruleset` | 同上 |
| 改版本号③ `input` 声明 v2 | `ruleset-version-mismatch` → `/ruleset` | 同上 |
| 改版本号④ 目录名 `rules-v2` | `ruleset-version-mismatch` → `/ruleset` | 同上 |
| 多一个未声明字段① `meta` 顶层 `/season` | `additionalProperties` → `/season` | `出现了未声明的字段:/season` |
| 多一个未声明字段② 嵌套 `/validation/checkedAt` | `additionalProperties` → `/validation/checkedAt` | 同上 |
| 多一个未声明字段③ `input` 顶层 `/concurrency` | `additionalProperties` → `/concurrency` | 同上 |
| 多一个未声明字段④ 嵌套 `/archives/1/model` | `additionalProperties` → `/archives/1/model` | 同上 |
| 缺档① 三件套缺 `script.js` | `archive-files-incomplete` → `/` | `存档缺档(三件套不全或某个座位没有存档):/` |
| 缺档② 座位 0 缺档 + 两处哈希不符 | `archive-files-incomplete` + 2 × `sha256-mismatch` | **四条机器诊断合并成两行** |
| 轮数与逐轮 prompt 条数不相等 | `archive-protocol-rounds-mismatch` → `/prompts` | `协议迭代轮数与逐轮 prompt 的条数不一致:/prompts` |

Schema 侧直接读出来核对过：`ARCHIVE_META_JSON_SCHEMA.additionalProperties === false`、`/validation` 层 `=== false`、`MATCH_INPUT_JSON_SCHEMA.additionalProperties === false`、`/archives` 的 `items.additionalProperties === false`——**全层关掉额外属性，没有一处放行额外属性的空 schema**。

`input.json` 的键集恰为 `["archives","map","mapSha256","ruleset","seed"]`；把 `season` / `seasonConfig` / `players` / `mapPool` / `seedCount` / `concurrency` / `rankPoints` 七项**逐个塞进去**，七次全部 `additionalProperties` 拒、指针逐个核对——**赛季配置塞不进去**这条是钉住的。

**留给下一票 / 需票 12 收口的点**（本票按纪律未改 `docs/`，逐条记在这里）：

1. `hld.md:719` 那句「在此之前本仓没有它的 JSON Schema,读入端不校验它」现在**过时**——形状已定且读入端已校验。票 12 改这一行。
2. `hld.md:720` 的「runner 启动即校验元数据完整性」仍未消歧（spec 已定：本 feature 的进程是第一个执行脚本的进程，赛季调度复用同一条校验路径、不复写）。票 12 收口。
3. `input.json` 的「各文件 hash」本票裁成三处：`archives[i].scriptSha256` / `archives[i].metaSha256` / `mapSha256`，**不含 `script.ts` 的哈希**（复算认编译产物，定版源码的不可变由 gen 保证，FR-6 AC1）。若 hld 的本意是四个文件都取哈希，票 12 需一并改 `hld.md:721` 与本模块形状（那是一次有意的形状变更，不是一条补字段）。
4. **座位轮换没有落进 `input.json`**：`hld.md:721` 的五项里没有座位，本票取「`archives` 下标即 `playerIndex`」承载它。轮换算法（`(mapIndex + seedIndex) mod 4`）归 runner 物化期，不进这份文件。若票 12 认为需要显式一格，那是形状变更。
5. `archive-meta.ts` 的 `validation` 取 `{ passed, errors }` 两格（hld 只写「校验结果」四个字），`generatedAt` 未约束格式（只 `minLength: 1`）——两处都是本票的取值级取舍，实现与文档的措辞差在票 12 对账。
6. 诊断到退出码的映射留给脊柱那张票：`2` = 装载期拒跑（缺档 / 哈希不符 / 版本三处不一致 / 缺项全部落在 `ValidationRejection` 里，装载方据此设码即可，本票刻意没碰）。
