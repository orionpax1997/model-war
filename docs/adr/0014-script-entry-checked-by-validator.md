---
status: accepted
---

# 脚本入口的「存在性」检查落在静态校验器:gen 不解析、也不执行模型产物

模型回一个空代码围栏时,`extractScriptSource` 给出空串,`tsc` 把空源码编译成 `"use strict";` 照样**成功**,
体积 / 禁列 / 桥前缀 / 模块系统四级都无事可查,冻结期试跑又只看 events/apis 两条预算轨
(见 `.scratch/generation-pipeline/issues/11-freeze-trial.md` 的分工)——于是空产物被冻进赛季,
每 tick 调 `loop()` 抛异常,靠 `exceptionTickLimit` 出局。`docs/hld.md` §6.2「编译」那一行早就把通过判据写成
「`tsc` 编译通过 **+** 顶层声明 `loop` 入口」,`tsconfig.scripts.json` 的注释也写着「它在生成管线的编译步骤里
查产物(`typeof loop === "function"`)」,但这半句**从未实现**。本 ADR 记这次落点裁定。

## 决定

新增一条静态校验规则 `script-entry`(`packages/tools/src/rules/script-entry.ts`),判**编译产物的顶层**有没有一个
引擎取得到的 `loop`:

- 放行:顶层 `function loop(...) {}`,以及顶层 `var loop = function ... / () => ...`。
- 拒绝:没有 `loop`、顶层 `let` / `const loop`、`var loop = 非函数`,以及写在块里的 `function loop`。

判据直接对齐引擎的取法(`vm.global.getProp(SCRIPT_ENTRY)` + `typeof === "function"`)而不是「源码里写没写
顶层函数声明」这句字面话:顶层 `let` / `const` 的绑定落在**全局词法环境**里,不是全局对象自己的属性,
`getProp` 取到 `undefined`(实测记录在 `docs/hld.md` §6.2「脚本入口」那一行,本 ADR 不复制取值)。
它一律 blocking(两相都拦),无源码位置(判的是「某个声明不存在」)。`docs/hld.md` §6.2 的表格随之新增「脚本入口」一行。

## 为什么不是 gen 的编译步骤

hld 那句话把检查挂在「编译」这一类,但**类的归属不等于实现宿主**——`tsconfig.scripts.json` 的注释已经点明
「配置无从要求某个名字出现」,真正的判据是产物上的一条静态性质。

- **gen 手上没有解析器**:`packages/gen` 的依赖只有真源包(`schema`),而 `packages/tools` 以源码形态执行、
  入口指向源码,直接 import 会把它的源码并进 gen 的 program(hld §3.2 / 依赖图)。
- **gen 不能执行模型产物**:`typeof loop === "function"` 要在某个 JS 环境里求值,而 gen 是唯一联网、持有
  各厂商凭证的包。用 `node:vm` 把模型产物跑在 gen 进程里破的是「沙箱隔离靠不给」这条纪律;用注入面空值桩
  还会改变顶层 API 的返回值,把一份本来能跑的脚本误判成加载失败——而误伤在五轮迭代预算里不对称地致命。
- **反馈通道只有一条**:契约 §2.2 把回喂内容限死在「校验器 stdout / tsc 诊断 / 试跑 stdout」三者。
  在 gen 里凭空造一条「空产物」诊断,等于给这条通道开了第四个来源。落进校验器,它就是既有的第一条。

## 为什么不是引擎载入期检查 / 试跑检查

- 引擎载入期拒跑会把「候选脚本没入口」升级成**整场装载失败**(`modelwar match` 的装载期决断),
  而它本该在冻结前就被拦下、回喂给模型重写。
- 冻结核试跑按票 11 的裁定只看候选座位的 events/apis 两条预算轨,未吞异常那一轨进联赛三振——
  「没入口」是产物的一条静态契约事实,不该等到真跑三场、烧掉一轮预算才发现。
- 落进静态校验器后,每一轮迭代都会得到它,模型拿到的是「补上入口」这一句可执行的修改。

## Consequences

- 空产物 / 无入口产物在冻结前一律走 contract 失败 + 回喂,进不了 `archive/`;回归用例在
  `packages/gen/src/pipeline.test.ts`(空围栏 → 失败不建存档;回喂后第 2 轮补上入口 → 冻结)。
- 入口**签名**(返回类型可省略)仍归契约面与脚本编译配置,不在本规则里单列——本规则只判「存不存在一个
  能被引擎取到的函数」。
- 规则清单从四条变五条,判定链从五级变六级(脚本入口排在模块系统之后、体积之前):`hld §6.2` 的计数、
  判定链槽位的白盒断言与各规则头注同步改过。
