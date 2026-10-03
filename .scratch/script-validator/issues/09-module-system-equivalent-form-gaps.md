# 09:模块系统规则的两处「等价写法没兑现」(`eval(("1+1"))` 与 `globalThis["eval"]`)

Type: task
Status: ready-for-agent
Blocked by:

## 来源

`fix/code-review` 那次 review 修复(commit `23766ae`,合并进 `feature/script-validator`)的
收口复核里发现。**本票不在那次修复的范围内**,理由见下面「为什么这次没顺手改」。

## 现象

同一条「括号在 JS 里是纯分组、不改变被引用的是谁」这条遍历层纪律,在
`rules/module-system.ts` 上有**两处没兑现**。两处都让同一段代码在加一层括号 /
换一种等价写法之后得到相反的结论。

### ① `eval(("1+1"))` 被按**动态** eval 拦下,而 `eval("1+1")` 放行

静态 `eval` 的判据落在**实参的形状**上(`isStaticEvalArgument`):第一个实参**是裸 `Literal`**
且值为字符串即算静态,不拦。而 `oxc` 为 `("1+1")` 产出独立的 `ParenthesizedExpression`,
实参节点的 `type` 因此是 `ParenthesizedExpression` 而不是 `Literal`,于是走「其余一切算动态」
那一支被拦下。

实测(2026-10-03,`oxc-parser` 0.152.0,入口 `run-validate-script.ts`,`--phase freeze`):

| 源码 | 结论 |
|---|---|
| `eval("1+1")` | 通过 |
| `eval(("1+1"))` | **拦截**· 模块系统 · 1:1 · 动态 `eval()` |

而被求值的文本在两种写法下**完全相同**,且都在编译期就写定了——按模块系统那条裁决的
第一条理由(「静态 `eval` 被求值的文本是编译期就完全写定的一段常量」),它与
`eval("1+1")` 属于同一类,没有理由一个放行一个拦。

**它与同文件里已有的「不做常量折叠」裁决是不是一回事:不是。** 无插值模板串
``eval(`1+1`)`` 与字符串拼接 `eval("a"+"b")` 被拦,是因为判定那件事本身需要一层
求值/求值器(常量折叠),那是另一个成本层级,已被显式裁决挡住。而剥一层括号**不改变
实参是什么**,它与 `(Math).random()` 那一侧是同一条纪律,零额外成本。

### ② `globalThis["eval"](s)` 看不见,而 `globalThis.eval(s)` 拦下

`calleeNameOf` 的 `globalThis` 那一支要求 `callee.computed !== true`,即**只认非计算的成员名**。
于是计算属性里那个**字符串字面量**成员名取不到,整个被调用者取不到名字。
实测 `(globalThis)["eval"](s)` 放行、`globalThis.eval(s)` 拦截。

**同一份包里两处对计算属性的答案相反**,这本身就是一处不一致:`rules/forbidden-globals.ts`
经 `identifier-chain.ts` 的 `memberNameOf` **认** `Math["random"]()`(有钉住用例),
模块系统**不认** `globalThis["eval"](s)`。

## 判据

两处都是**误伤**,不是漏报:合规脚本(`eval(("1+1"))` 是完全静态的一段常量)被拒。
误伤在五轮迭代预算里是不对称地致命的(spec《承载的重新划分》)。

## 为什么这次没顺手改

`fix/code-review` 那次修复把括号剥离**只做在两个位置**:取链的入口 `chainOf` 与
模块系统取被调用者 `calleeNameOf`。理由记在 `rules/identifier-chain.ts` 的头注里——
不是把树上的括号节点统统换成内层节点,那会**顺手改掉别的判据看得见的形状**,而
`isStaticEvalArgument` 看的正是**实参**的形状,那形状是模块系统自己的一条独立裁决。
要让 `eval(("1+1"))` 放行,得在**实参那一侧**也剥括号,那是动静态/动态那条裁决的判据
本身,不在一次 review 修复的范围里。

## 验收

① 两条都补上用例,且**必须同时钉住相反的一侧**:
- `eval(("1+1"))` 放行 **且** `eval(s)`、`eval("a"+"b")`、``eval(`1+1`)`` 仍然拦下
  (只钉前者会有人把「不做常量折叠」那条裁决一起推翻,那正是误伤);
- `globalThis["eval"](s)` 拦下 **且** `o["eval"](s)`、`(o)["eval"](s)` 放行
  (只钉前者会有人把「别的对象上的同名成员不是全局 eval」那条边界一起推翻)。
② 落点写进 `rules/module-system.ts` 的头注:静态 `eval` 的判据是「剥掉括号后的第一个
实参是字符串字面量」,并把「剥括号只做在这一侧」的理由与 `identifier-chain.ts` 头注对齐。
③ 两处要么都收进 `identifier-chain.ts` 的公共件,要么各自留一份并注明为什么——
**不得留三处各写一遍的形态**(与 `withoutGlobalThis` 同一纪律)。