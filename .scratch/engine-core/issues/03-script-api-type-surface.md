# 03: 脚本 API 的类型面回填

**What to build:** 一份模型写错的脚本**在编译期就红**,而不是编译通过、跑到沙箱里才炸。那道防线是编译器的「找不到这个名字」,而它要有东西可依——真源包里那份脚本 API 类型声明(`packages/schema` 拥有,`tsconfig.scripts.json` 的 `types` 经它引入)。

**这是 hld §6.2「API 误用」那一行第一次真的有人。** 此前脚本编译配置的 `types` 是空数组,那一行是空头承诺;本票落定之后,「编译通过 + 白名单反转 + API 签名」三件事同时成立,**生成管线的编译步骤就此解锁,不必等沙箱执行器**。

**类型面归本 feature 而不是沙箱执行器**,理由见 `docs/adr/0006-script-api-type-surface-lands-in-engine.md`:类型面描述「脚本能读到什么状态字段」与「action 的签名」,前者的源头是本 feature 的状态模型、后者的源头是意图的 `check()`/`run()`,而沙箱执行器只搬名字、不定义任何一个。名字表按定义给不出签名,倒推出的声明必然与实现分叉。

**顺带销掉 `docs/adr/0004` 留的那笔账**:真源包那张符号表的注释写着「刻意为空,回填触发条件是沙箱执行器产出注入面」,本决定之后那句话会说错话,必须改掉,否则后来者会按注释把它当成待办而跳过。

决策依据：`.scratch/engine-core/spec.md`《脚本 API 的类型面归本 feature》一节。

**Blocked by:** 02（脊柱——空转一整场到超时,回放端到端可渲染）

**Status:** resolved

- [x] 声明面落进真源包,覆盖快照的**全部**可读字段与**全部** action / 查询函数签名,与那张符号表逐条对齐 → 声明面家在 `packages/schema/script-api/index.d.ts`(253 行)+ 它的 `package.json`(`types` 指过去),靠 `typeRoots`+`types` 引入而非包解析;读法是 `packages/tools/src/script-api/declarations.ts:115` `readScriptApiDeclarations(file, source)`(**不认识就抛**,三个清单都按声明序不排序)。逐条对齐的用例是 `packages/tools/src/script-api-type-surface.test.ts:103`「声明面声明的值名与注入面符号表逐条对齐,22 个不多不少」、`:118`“声明里的每一个类型名都能被脚本当类型引用”、`:138`「注入面那 22 个名字逐个可引用,零诊断」、`:158`「全部 action / 查询函数按声明的签名逐个调得动,零诊断」。**票面写「23 条」是笔误**:`SANDBOX_INJECTED_API_SYMBOL_CATALOG` 实测 22 条(query 6 + action 6 + seat 1 + helper 2 + error-code 7),见下面的 `## Answer`
- [x] 座位**不在**声明的快照形状里,只由 `getMyIndex()` 给出 → `script-api-type-surface.test.ts:255`「座位不在快照形状里、产线不是独立队列表、快照没有写入口」:断言声明文本里 `Snapshot` 那份类型名下没有座位栏,而 `getMyIndex()` 是唯一的座位入口
- [x] 产线订单在声明里是**点位上的那一个字段**,不是一张独立队列表;这份声明与状态模型逐字段一致 → 同上 `:255` 一条用例的三个断言之一;两边都是 `Site` 上的 `producing: { type: UnitType; remainingTicks: number } | null`,与 `/tmp/mw/t02a/packages/engine/src/world/state.ts` 的 `SiteProduction` **同一条形状,不是投影**;
- [x] 脚本编译配置的类型环境**只额外引入这一份声明**。一条用例钉住:一份引用 Node 专有名字的脚本**编译期就红** → `tsconfig.scripts.json` 回填为 `"typeRoots": ["./packages/schema"]` + `"types": ["script-api"]`,而 `typeRoots` **不含任何 `node_modules/@types`**——`types` 里能写的东西因此只有那一个,加第二个(尤其 `"node"`)得先改 `typeRoots`(明面上的改动,不是顺手添一行);钉子用例 `packages/tools/src/script-compile-config.test.ts:132` 断言 `Cannot find name 'process'` 逐字在这里。`packages/tools/src/script-compile-config.test.ts` 另加了 45 行断言
- [x] 一条用例钉住:把某个 action 的名字拼错 → **编译期红** → `script-api-type-surface.test.ts:287`「把一个 action 的名字拼错 → 编译期红,且红在「找不到这个名字」上」——不只断言非零退出,还断言诊断落在「找不到这个名字」那一类上(否则「红」可能红在别处)
- [x] **只声明动作与查询的类型,不声明数值**——数值归规则集那条生成链 → 判据逐字写在 `packages/schema/script-api/index.d.ts` 的头注里,且由 `script-api-type-surface.test.ts:103` 的「22 个不多不少」钉住:一个数值名进声明面就会让声明面的值名集合与符号表对不上而变红;
- [x] 那 15 条 `signature` 字符串**由声明面取代**:生成或删除,**不并列存在** → **删除**,不是生成:`packages/schema/src/script-surface.ts:114` 只剩一句「`signature` 字符串**被删除而不是并行保留**」的注记;签名改由 `packages/tools/src/generate/api-surface.ts:52,65,70` 从类型面投影(`readScriptApiDeclarations`),生成物 `docs/rules-v1/api.md:263+` 的「签名」栏随之改形:那一栏现在带着一句「投影自类型面」的头注,且 `getObjectsByType` 那一格从联合签名变成三条重载、`findPath` 的返回元素从可变对象变成 `readonly` 对象。`packages/schema/src/script-surface.test.ts:164` 那条「函数档都有签名而错误码档没有」的断言改掉了
- [x] 符号表头注里「刻意为空,回填触发条件是沙箱执行器」那段按 `adr/0004` 的要求改掉,`adr/0004` 那笔账标注为已销 → 头注已改(同 `script-surface.ts:114` 那一带);销账注记接在**既有**的 `docs/adr/0004-contract-api-surface-lands-in-rules-landing.md` 末尾(§ Consequences 第二条那笔账),形式是「销账(2026-10,票 03)」引一段,**ADR 正文一字未改**
- [x] 意图的 `check()` 的入参类型里**根本没有写入口**——这条由类型形状保证,不靠约定 → `script-api-type-surface.test.ts:255` 一条用例的第三个断言:声明里 `Snapshot` 的那几个字段全部 `readonly`,且没有任何一个写入口(mutator)名字。类型一旦给了写入口,「它不会写引擎状态」就退化成纪律而不是事实;
- [x] 与沙箱执行器的那条同步面写进注释:类型面与注入面**同源于一份形状,但只有一份形状** → `packages/schema/script-api/index.d.ts:33-35` 逐字写着「类型面(形状)归本 feature;注入面(这些名字铺进 guest 的时机、桥函数在初始化后怎么删)归沙箱执行器。两者同源于这一份形状,但只有一份形状;某个名字在这里声明了而注入面铺不出来,那是注入面的缺陷,不是「这里漏了一个名字」。往这张脸补名字的唯一理由是形状变了,不是『沙箱那边少一个』」
- [x] 一条反向用例:换成一份旧版声明 → 用例红 → `script-api-type-surface.test.ts:308`「反向用例:换成一份少一条的旧声明 → 那一条调用编译期红,其余照旧」:换成一份抽掉 `getRange` 的声明后,只有 `getRange` 那一条调用红,其余照旧——防止把声明做成「运行时可绕过的软约束」

## Answer

**做完了什么**:脚本 API 的类型面落在真源包 `packages/schema/script-api/index.d.ts`(253 行,ambient 声明),`tsconfig.scripts.json` 的 `typeRoots`/`types` 经它引入。于是「编译通过 + 白名单反转 + API 签名」三件事同时成立。

**15 条 `signature` 选了「删除」而不是「生成」**:生成会在真源包里同时留下「签名」与「类型面」两份会分叉的真源;删除之后签名只活在类型面那一份里,而符号表退成一张**只有名字**的表。「只声明形状不声明数值」这条判据随之有了机器形态——一个数值名进声明面就会让两边的名字集合对不上。

**票面的两处不一致,记在这里**:
1. 票面第一条写「那张 23 条符号表」,**实测是 22 条**:`query 6 + action 6 + seat 1 + helper 2 + error-code 7`。按「每个事实只有一个家」,符号表的家是 `packages/schema/src/script-surface.ts`,票面的数字是笔误
2. `PENDING_SHAPES` 与 ADR 编号:上个代理一度新开了一份 `docs/adr/0004-script-tsconfig-and-injection-surface.md`,与既有的 `0004-contract-api-surface-lands-in-rules-landing.md` **撞号**。已删除该文件,且销账注记改为接在既有 ADR-0004 末尾(销账是「本决定之后那句历史陈述必须改掉」的直接后果,它属于**那份**决定)

**门禁把两处「预期信号」顶红了,都改对了而不是绕开**:
1. `benchmarks.test.ts:217`「三份脚本的编译诊断里「名字未声明」归零」——`cell-a/b/c` 原本的 40 / 25 / 17 个「名字未声明」**全部归零**,剩下的只有脚本自身那两类(`implicit-any-parameter` / `possibly-undefined`,由那一条用例逐个钉住条数)
2. `api-doc.test.ts` 原本靠「未声明名字那一批诊断」反推「脚本用到了注入面」,类型面回填后这批诊断**恒为空集**,那条路随之失效(空集上「用满了」与「压根没用」无法区分)。改成两个仍然可机械取出的事实:`:139`「基准脚本的「名字未声明」诊断归零:注入面之外的名字压根调不动」+ `:164` 用「声明面的值名 ∩ 脚本源文本」取代原 `used.length > 0` 空集护栏;`:155` 另配一条**反例**:往基准脚本里插一句 `probe.getResources()` → 诊断多出一条且红在那个名字上(没有它,「归零」可能是恒真的——如果编译那一步本来就不产出诊断)

**实测读数**:`pnpm run check` 全绿(unit+property **38 文件 473 用例全绿**,改前 471);`check:deps` 45 模块 70 依赖零违规;`check:declared-deps` 43 文件 0 未声明;`check:drift` 6 件无漂移;`check:bench` 3 份绿;禁浮点 26 文件 0 违规。生成物 `docs/rules-v1/api.md` 已重跑 `pnpm run generate` 并一起提交。

**给后续票的话**:`script-api-type-surface.test.ts` 与 `api-doc.test.ts` 现在都**读类型面**(`readScriptApiDeclarations`),而不再读「未声明名字」那批诊断;沙箱执行器那一格落地后,若注入面实际铺的名字与声明面对不上,红的是这两条用例,而不是「声明漏了」。
