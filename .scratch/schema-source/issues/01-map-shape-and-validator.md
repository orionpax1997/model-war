# 01: 地图形状与 ajv 校验器通路

**What to build:** 一份地图 JSON 能从读入走到「被校验通过」或「被带诊断拒绝」。地图的类型与 JSON Schema 覆盖全部七个字段,规则版本下界与真源包的版本常量对齐,变体槽位带一个显式的「待回填」位置。`apps/cli` 里出现本仓库**唯一**一份 ajv 校验器,对外交付两层诊断:机器层透出 ajv 的原始信息,面向模型层是含 JSON 指针的短句并对同类错误合并成一行。这条通路是本 feature 之后每一张票的落脚点。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 地图的 TypeScript 类型与 JSON Schema 覆盖七个字段:名称、尺寸、规则版本下界、地形、点位、初始单位、变体槽位
- [x] 地图的 JSON Schema **禁止额外属性**,并有至少一个「多一个字段即被拒」的反例
- [x] 变体槽位是**必填数组**,元素取最松形态,并带显式的「待地图图(A 节点)回填」标记——后来者不得误读它的形状已定稿
- [x] 地图声明的规则版本下界与真源包导出的规则版本常量一致,不一致即拒(错配在装载期拒跑,不静默降级)
- [x] `ajv` 从根 devDependencies 移入 CLI 应用的运行时依赖(校验器归 CLI 应用,真源包仍然零依赖)
- [x] 诊断分两层:机器层透出路径 + 关键字 + 消息;面向模型层是含 JSON 指针的短句
- [x] **面向模型层对同类错误合并**:多个同类错误并成一行而不是逐行列出,并有一条用例锁死这个行为(它是生成管线五轮迭代预算能撑住的前提)
- [x] 属性测试:任意 JSON 值输入,校验器要么接受、要么给出结构化诊断,**永不抛未捕获异常**
- [x] 接受 / 拒绝的断言落在校验器导出的**纯函数**上,不碰文件系统、不碰 CLI 退出码
- [x] **不新增任何 CLI 子命令**(规则文档的六个子命令不动);`map-lint` 的地图校验断言也落在纯函数上,不通过它的退出码测
- [x] 校验器自测进门禁自测工程(每道检查都有能被弄红的反例),且不混进全量门禁以免套娃

---

## 交付说明

### 落点

| 文件 | 一句话 |
|---|---|
| `packages/schema/src/map.ts` | 地图的 TS 类型与 JSON Schema(**同一次书写**),变体槽位取最松形态并带待回填标记 |
| `packages/schema/src/pending.ts` | 存档 meta / result / 回放行三类的「家已定、字段未交付」标记;**刻意不写**空 schema |
| `packages/schema/src/index.ts` | 仍是唯一入口,新增两个域文件的再导出 |
| `apps/cli/src/validator.ts` | 本仓库唯一一份 ajv 校验器:纯函数 + 两层诊断 + 装载期版本下界 |
| `apps/cli/src/validator.test.ts` | 副缝上的全部断言(含 Q4 的一致性两条) |
| `apps/cli/src/validator.prop.ts` | 任意 JSON 值不抛未捕获异常等三条属性 |
| `apps/cli/package.json` / 根 `package.json` / `pnpm-lock.yaml` | `ajv` 从根 devDependencies 移入 CLI 的运行时依赖 |
| `vitest.config.ts` / `vitest.global-setup.ts` | property project 的拾取范围扩到 `apps/*`;新增在模块加载**之前**补一次 `tsc -b` 的 globalSetup |

### 三处需要后来者知道的判断

1. **规则版本下界的方向**。判据实现为 `1 ≤ rulesetMin ≤ RULESET_VERSION`,即「装载的规则集版本
   必须 ≥ 地图要求的下界」。hld 把这个字段写作 `rulesetMin`(地图**要求的**最低版本),反过来的方向
   会让一张要求 v2 的地图在 v1 规则集下被放行——那正是 §7.1「错配拒跑」要防的事。今天只有 v1,
   两个方向与「取等号」的可接受集合相同(只有 v1),所以验收清单里「不一致即拒」成立;取下界这一侧
   是为了 v2 落地时不必改代码。JSON Schema 只管形状(`^v[0-9]+$`),版本比较放在装载期,因为
   draft-07 表达不了跨字段比较。
2. **`initialOwner` 允许 `null`**。gdd 明确存在中立基地与「其余点为中立」的资源点,写死成整数会让
   一张合法地图在装载期被拒。中立以 `null` 表达,不是新增字段。
3. **`spawnUnits[].type` 是自由字符串**,不枚举四条兵种线。兵种名的取值集合归 gdd 与规则集那一侧
   (02 票),在地图 schema 里复制一份就是第二真源。同理,`terrain` 行长必须等于 `size`、点位不越界、
   四重对称这三条都是跨字段约束,JSON Schema 表达不了,归 map-lint。

### 两处比票面多做的事(都是为了门禁能自己站住)

- **`vitest.global-setup.ts`**:工作区各包的 `exports` 指向 `dist/`,而 vitest 不构建。校验器的两条
  测试在模块加载时刻就要 `@model-war/schema`,所以补构建只能放在 globalSetup(测试文件里的
  `beforeAll` 补不上,import 先于 hook)。之前 `pnpm run test:props` 在冷 dist 态上是靠
  `gates.test.ts` 里恰好先跑过 `check:types` 才站住的,那是顺序的运气,不是性质。
  代价:每次 vitest 启动多一次 `tsc -b`(已构建时是空操作)。
- **property project 的 `include` 扩到 `apps/*`**:否则校验器那条属性根本不会被 `test:props` 拾取。
  它不涉及 `gates` 那条反递归不变量(`unit` 的 exclude 仍只排 `gates.test.ts`)。

### 反例清单(每条都现做现验过,验完还原)

| 断言 | 弄红的手法 | 红灯 |
|---|---|---|
| 额外属性禁令 | 删掉 `map.ts` 顶层的 `additionalProperties: false` | 「多一个字段即被拒」「不同类的错误不合并」两条用例 |
| 面向模型层合并 | `renderModelDiagnostics` 改成逐条输出 | 「同类错误合并成一行」 |
| 键集合一致性 | 只在 `required` 里加一个 `style` | `tsc -b`:`TS2344: Type 'false' does not satisfy the constraint 'true'` |
| 规则版本下界 | 把上界改成 `currentMajor + 100` | 「规则版本错配在装载期被拒」 |
| 属性:不抛异常 | `validateMap` 遇到字符串就 `throw` | 「任意 JSON 值……永不抛未捕获异常」 |

`pnpm run check`、`pnpm run test:props`、`pnpm run test:gates` 均在 0 退出。

### 与后续票的接口

- 02 票的规则集校验器走**同一条通路**:`apps/cli/src/validator.ts` 里再加一个 `validateRuleset`,
  两层诊断与合并渲染直接复用,不要另起一份。
- `map-lint` 的处理器**尚未接线**(`commands.ts` 里它仍返回空命名空间):本票只交校验器纯函数,
  地图对称性那部分归 A 节点。

