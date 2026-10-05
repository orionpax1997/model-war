# 08:解析层的源形态比入口契约宽(script 形态按 `lang: "ts"` 解析)

Type: task
Status: resolved
Blocked by:

## 来源

`.scratch/script-validator` 这个 feature 的票 06(四份盲写脚本验收)里的发现,
由该 feature 的收口 merger 复核确认。**本票不在那个 feature 的范围内**,因为它取决于
参赛脚本的编译配置(归 E)何时落地。

## 现象

`packages/tools/src/parse-source.ts` 对 script 源形态走的是:

```ts
parseSync(kind === "script" ? "script.ts" : "source.ts", source, { lang: "ts", sourceType: kind });
```

即**源形态选了 `.ts` 文件名、`lang` 固定 `ts`**。后果:一份**未经编译**的参赛脚本
(带 `function loop(): void`、`Map<number, number>`、`as` 断言)能直接拿退出码 0,
而契约(hld §6.2「四条规则跑在编译产物上」)写死校验器唯一的源形态是**编译后的 script-mode JS**。

实测证据(票 06,2026-10-03):四份盲写脚本 cell-a/b/c 都带 TS 注解(cell-a 5 处 `as`、
cell-c 7 处 `as` + 7 处 `Map<`,三份各有 1 处 `function loop(): void`),原样通过。

## 判据

**这不是误伤**:误伤是「合规脚本被拒」,这里是「判据更宽,放行了不该由本工具判的东西」。
两者的失效方向相反,不能一起处置——这也是票 06 决定按兵不动的原因。

## 为什么现在不修

1. `tsc` 那一步是 **E 的编译步骤**的交付物。在它落地之前收紧,有可能把 E 交出的某种编译配置判死。
2. 收紧方式本身还没定:要么 `parse-source.ts` 对 script 形态改用 `lang: "js"`(文件名与 `lang` 一起改),
   要么在校验入口处显式声明源形态并据此选解析器。两种做法对「注释是否算源码」的答案不同
   (注释在两种源形态下都存在,但 JS 的解析器对 TS 特有的注释里写法可能有别)。

## 触发条件与验收

- **触发条件**:参赛脚本的编译配置(脚本 tsconfig,归 E)落地。
  在那之前本票不动——它不是「忘了做」,是「现在做会判死一个还没交出来的东西」。
- **验收**:
  ① 决定收紧的形态与落点(解析层 `lang` 还是入口声明源形态),写进 hld §6.2;
  ② 用例钉住「带 TS 注解的源码被拒」,并钉住「编译后的 JS 产物仍然放行」——
     **只钉前者会有人把产物一起拒掉**,那正是误伤;
  ③ 四份盲写脚本重跑一遍,确认仍然零违规(它们带 TS 注解,收紧后必然要重新判读:
     它们本来就不是编译产物)。

## Answer

**裁法(验收①)**:静态校验器的源形态只有编译后的 JS,且这条**由解析层独占地兑现**——
`packages/tools/src/parse-source.ts` 对 `script` 形态改用 `lang: "js"` 与 `.js` 文件名
(`module` 那侧不动,仓库自身源码照旧 `lang: "ts"` + `.ts`)。落点选**解析层**而不是校验入口。

**为什么落点在解析层**:规则层的禁列 / 桥前缀 / 模块系统三条各自独立调 `parseToAst(source, "script")`,
加上判定链入口共四个调用点。入口声明源形态的话要在四处各传一次,任何一处漏传就静默回到
「判据更宽」——而更宽正是本票要消除的方向。改解析层一处,四个调用点一起受益且绕不开。
裁决与实测写进 `docs/hld.md` §6.2(「四条规则统一跑在编译产物上」那一段的扩写 + 同节实测表新增第 3–6 条)。

**下刀前的探针(2026-10-04,oxc-parser 0.152.0 + Node 24.15.0,不落库)**——票里点名的两条风险都复验了:

- **`lang: "js"` 不挡模块语法**:`export const` / `import x` / `import()` / `require()` 四种在
  `sourceType: "script"` 下**一律零解析错误**(静态 `import` / `export` 另外置
  `module.hasModuleSyntax = true`,而动态 `import()` / `require()` 不置——但规则层读的是 AST 节点、
  不读那个标志,所以两种口径对本票的结论没有影响)。所以模块系统**仍是独立一级**,
  `rules/module-system.ts` 头注那条实测在候选配置下逐字不变。唯一由解析层判失败的是 `import.meta`。
- **文件名是自述不是开关**:文件名给 `.js` 或 `.ts` 配 `lang: "js"` 逐条行为相同(oxc 只在缺 `lang` 时看扩展名)。
  两处一起改是为了让传给解析器的名字不再与实际形态说反话。
- 附带排掉票里列的那个顾虑:「注释是否算源码」在两种 `lang` 下逐字相同(`comments` getter 的条目与
  `Line`/`Block` 类型都对得上),它不是这次收紧的变量。

**收紧带出的三处连带改动**(都不是「顺手改」,是被收紧直接推翻的旧事实):

1. **TS 专有的模块写法退出模块系统那一级的域**:`import x = require(…)` 与 `export = x` 在产物里
   不存在——`tsconfig.scripts.json` 的 `module: esnext` 让 `tsc` 先判红(实测 TypeScript 7.0.2,
   TS1202 / TS1203,诊断由编译步骤透传,归 hld §6.2「编译」那一行),解析层则把它们判成解析错误。
   已从五形态表移出,并用一条用例钉住「本规则不再判它们」。
2. **一条判据取样必须避开**:`export { a, a }` 在 `lang: "ts"` 下放行、在 `lang: "js"` 下报
   `Duplicated export 'a'`。原来拿它当「一个 export 节点只报一条违规」的样本,收紧后整条落进
   `syntax-error`——钉的就不再是原来那件事了。改成两个不同名字。
3. **`syntax-error` 的文案原来会说谎**:它写的是「参赛脚本是单文件、无 import/export 的 script-mode 模块」,
   而被拒的对象现在是**未经编译的 TS 源码**——照原文案会把模型引向改模块语法(既改不动病因,又烧一轮
   迭代预算)。改成指向编译(`按 tsconfig.scripts.json 编译出来的单文件裸脚本` + 「先编译再校验」),
   并在入口那层(spawn 子进程、读 stdout,也就是模型真正读到的那份文本)钉住这句文案。

**验收②(两侧对称的用例)**:

- 拒的那半:`parse-source.test.ts` 逐条钉八种 TS 注解写法(返回类型标注 / 可选形参 / 泛型实参 / `as` 断言 /
  非空断言 / `interface` / `enum` / 泛型函数)全部被拒;**另加一条反向钉**——同段注解在 `module` 形态下
  仍通过,防止有人把收紧做成「解析层一律不认 TS」(那样一刀下去禁浮点门禁与声明依赖门禁会同时失效)。
  `pipeline.test.ts` 另有一条钉「未编译源码独占一条 `syntax-error`、零条规则违规」。
- 放行的那半:`benchmarks.test.ts` 用**入库的三份真产物**(`benchmarks/*/script.js`,5–8 KB,
  逐字节由 `check:bench` 钉住是基座跑出来的)过完整条判定链,断言零违规。只钉拒绝侧的话,
  把 script 形态整个判死(连真产物一起拒)同样能变绿,那正是误伤。

**验收③(四份盲写脚本重跑)**:一次跑八份(标定环四舱的 `cell-a/b/c/d` v1 加 `cell-d` v2,以及落库那一轮
三舱的 `.ts`),**每份先按 `tsconfig.scripts.json` 编译再过判定链**——它们本来就不是编译产物。

| 脚本 | 原样喂解析层 | 编译后判定链 |
|---|---|---|
| `rules-calibration/…/cell-a/work/script.v1.js` | `syntax-error @ 6:5` | 零违规 |
| `rules-calibration/…/cell-b/work/script.v1.js` | `syntax-error @ 5:7` | 零违规 |
| `rules-calibration/…/cell-c/work/script.v1.js` | `syntax-error @ 8:5` | 零违规 |
| `rules-calibration/…/cell-d/work/script.v1.js` | 零违规(本就无 TS 注解) | 零违规 |
| `rules-calibration/…/cell-d/work/script.v2.js` | `syntax-error @ 538:1` | 零违规 |
| `rules-landing/…/cell-a/work/script.v1.ts` | `syntax-error @ 66:18` | 零违规 |
| `rules-landing/…/cell-b/work/script.v1.ts` | `syntax-error @ 8:18` | 零违规 |
| `rules-landing/…/cell-c/work/script.v1.ts` | 零违规(本就无 TS 注解) | 零违规 |

**为什么跑了八份而不是四份**:票面点名的四份是标定环 `cell-{a,b,c,d}` 的 v1(那张表里逐份列字节数的就是它们),
四份全部在列;另加 `cell-d` v2(它当年替换掉了 v1 的两处静态不符)与落库那一轮的三舱 `.ts`,
是**顺带把另一个 feature 留下的同类脚本也重判一遍**——交接单点名的正是后三份。多跑不改变结论,
少跑会漏掉「同一批脚本在两轮契约下的读数是否一致」这个对照。

**判读:八份的规则结论仍然全是零违规,收紧没有误伤任何一份**;变的是**原样喂进去时的读数**——
六份从「零违规」变成「一条 `syntax-error`」,这正是本票要消除的「判据比契约宽」那一侧。
两相(`iteration` / `freeze`)结论一致。产物字节数与票 06 那张表**不可比**:那次跑在草案契约与旧的
编译选项下,本次是终稿契约 + `target: es2023`,本票不重算体积标定(那是 K 的账)。

**一件顺带记下、不在本票范围内的事**:这八份编译时,`unexpected` 那一档诊断非零(`TS2532` / `TS2345` /
`TS2322` / `TS7034` / `TS7005` 等,标定环那几份尤甚)。那不是本票造成的——它们是**草案契约下**的脚本,
在终稿 `strict` + `noUncheckedIndexedAccess` 下的写法账,而 `DiagnosticClass` 那三类是按基准脚本的
形状定义的。本票只判「规则结论零违规」,编译诊断的分类口径不在这里动;若要收,是另一张票的事。
