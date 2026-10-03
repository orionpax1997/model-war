/**
 * 内置全局白名单的**真源**。名单类数据一律住在本包(hld §6.2:白名单由 `schema` 提供,
 * 与沙箱 runtime 暴露的 API 面同源;ADR-0003 把「同源」落成同一套生成器机制)。
 * 名单按域分文件:内置全局白名单在本文件,参赛脚本可见面的其余三张表在 `script-surface.ts`。
 *
 * 消费者一个名字都不许自己存:① `packages/tools` 的禁浮点规则(读 `Math` 成员那一半);
 * ② 面向模型的规则文档里的内置全局表。白名单反转那一侧**不读本表**(见本文件末尾那一节),
 * 它由编译器的名字解析执行。所以「同源」保证的是「名字只有一处定义」,不是「校验器能判
 * 这个名字存不存在」——后者要的是类型面,符号表给不出(hld §6.2「API 误用」行)。
 *
 * 分界线(ADR-0003):「谁在运行时决定这个值」归实现包,「这个值叫什么、什么形状」归本包。
 * 白名单是「什么名字」,归本包;门禁怎么查(AST 遍历、违规产出、退出码)归工具包。
 *
 * 本文件里的两张表**收录判据不同、方向也不同**:`ALLOWED_MATH_MEMBERS` 判的是成员级
 * (整数闭包),`BUILTIN_GLOBAL_NAMES` 判的是全局级(不越界)。两张表各自不共享一句理由,
 * 也不互相引用为依据。
 */

/**
 * 收录判据:输入全整数时,输出**必为整数**(精确整数域 → 整数值域)。
 *
 * 明确不收:
 * - `sqrt`/`pow`/`cbrt`/`log*`/`sin` 等——产出非整数;
 * - `random`——非确定源(hld §6.2 确定性污染源);
 * - `E`/`PI`/`LN2` 等——常量本身即非整数值,取出来就破坏整数闭包;
 * - `round` 收:`Math.round` 只做就近取整,整数入整数出;
 * - `min`/`max`/`imul` 收:整数入整数出(`imul` 出的是 32 位有符号整数)。
 *
 * 判据从前身 `packages/tools/src/allowlist.ts` 的手写表一句不丢地迁到这里。手写表已随生成器
 * 落地而退役:从这一刻起,本文件是唯一出处,工具包内那份由它生成、**不许手改**。
 */
export const ALLOWED_MATH_MEMBERS: readonly string[] = [
  "abs",
  "ceil",
  "clz32",
  "floor",
  "imul",
  "max",
  "min",
  "round",
  "sign",
  "trunc",
];

/**
 * 内置全局名白名单:引擎与参赛脚本都可引用的**内置全局名**。
 *
 * 「内置」是这一格的定义域,边界也是判据的一部分:宿主提供的东西(`console`、`setTimeout`、
 * `fetch`、`process`、`crypto` 等)不在内置之列,它们是 `script-surface.ts` 里那张注入面表的
 * 东西;宿主桥更是禁列而不是白名单(`__` 前缀)。这张表只装 JS 语言自己定义在全局上的名字。
 *
 * ── 收录判据:一句话,对所有内置全局一视同仁 ──
 *
 *   **收:拿它算出的值完全由脚本自己已经给定的输入决定**。即调用它既不改变这个 VM 之外的
 *   可观察状态(宿主、文件系统、时钟、调度队列、共享内存),也不读这个 VM 之外的任何状态。
 *   任何一边沾了就是不收——判据没有第三种形态,也没有「但这个例外」的口子。
 *
 *   它与 `FORBIDDEN_GLOBAL_NAMES` 的判据构成一对**方向相反**的判据:禁列是「一律禁」
 *   (不可复算),本表是「一律收」(不越界)。两张表因此**不得相交**——相交意味着白名单里躺着一个
 *   禁列名字,而它的失败模式恰恰是「白名单放行了禁列」。判定链把禁列排在白名单之前判,就是为了
 *   在那种状态下也不至于放行;不靠次序兜底,靠的是 `builtin-globals.test.ts` 里那条不相交的
 *   机器断言(两表相交时它先红)。
 *
 * ── 明确不收:逐条理由,理由本身也是判据的实例 ──
 *
 * - `eval` / `Function` / `AsyncFunction` —— 求值器与构造器把「构造点的闭包」「引擎在何时
 *   以什么参数调用它」变成了输入,产出不再是给定输入的函数;副作用那一端也一并沾上。
 * - `Proxy` —— 代理的可观察行为由 trap 的调用次数与时机决定,那是引擎实现而不是脚本输入。
 *   `Reflect` 是它的对照:纯反射,把操作原样转给目标对象,故收。
 * - `globalThis` —— 它的值就是这个 VM 的全局环境本身。收它等于把判据要证明的那件事
 *   (不读 VM 之外的状态)交给被校验者去证明,判据在这一个名字上不可判,因而它不构成一次收录。
 * - `Intl` —— 输出取决于宿主的 ICU 数据与 locale 设置,那是这个 VM 之外的状态:同一份输入在两台
 *   宿主上可以给出不同的字符串。
 * - `Atomics` / `SharedArrayBuffer` —— 读写的是别的执行上下文共享的内存(`wait` 还把调度权交出去),
 *   两头都越界。
 * - `WeakRef` / `FinalizationRegistry` —— 可观察的内容取决于 GC 何时发生,不是脚本给定的输入。
 * - `escape` / `unescape` —— 规范未定义(Annex B 遗留),结果由实现决定,不是纯计算的确定结果。
 * - `Date` / `performance` / `queueMicrotask` / `Math.random` —— 与禁列同向:要么读宿主时钟,
 *   要么给出「跑到哪儿了」或不可复算的读数。判据在这个方向上给出的理由与禁列逐条一致,
 *   所以它们的名字只出现在禁列里、不出现在本表里。`Math.random` 是成员路径而不是全局名,
 *   它因此连「能不能进这张表」的问题都不问:这张表只装全局名。
 *
 * ── 逐个名字为什么收(判据的实例;加名字的门槛就是这些行) ──
 *
 * - `Array` —— 构造与 `isArray`/`from`/`of` 都只读传入的元素,不产生副作用;
 * - `ArrayBuffer` —— 分配的是这个 VM 自己那段线性内存,不共享、不跨执行上下文;
 * - `BigInt` —— 精确整数构造与 `asIntN`/`asUintN` 换算,输出只由输入的整数决定;
 * - `Boolean` —— `Boolean(x)` 就是 `x` 的真值化,输入定值;
 * - `DataView` —— 对脚本自己持有的那段缓冲读写,不共享;
 * - `Infinity` / `NaN` / `undefined` —— 常量:值就是它自己,不读任何状态;
 * - `JSON` —— `parse`/`stringify` 双向确定,同一段文本给出同一个结果;
 * - `Map` / `Set` / `WeakMap` / `WeakSet` —— 容器:状态是脚本自己那份数据;后两个的对不上键查询
 *   一律给出 `undefined`,GC 时机因此不可观察;
 * - `Math` —— 成员全是纯函数,唯一读 VM 之外状态的是 `Math.random`,而它是成员路径、在禁列里;
 *   本表判的是全局名,所以收 `Math` 这个名字;
 * - `Number` —— `isFinite`/`isNaN`/`parseInt`/`parseFloat`/`toString(radix)` 都是输入定值的纯转换;
 * - `Object` —— `keys`/`values`/`entries`/`assign`/`fromEntries`/`freeze` 都只作用在传入的对象上;
 * - `Reflect` / `RegExp` —— 分别是纯反射与对输入字符串的匹配计算;`RegExp` 的 `lastIndex`
 *   是脚本自己那份状态,不出这个 VM;
 * - `String` —— `fromCharCode`/`raw` 与各个成员方法都是输入定值的字符串变换;
 * - `Symbol` —— `Symbol()` 给唯一标识,`Symbol.for`/`keyFor` 查的是这个 VM 里脚本自己写的注册表;
 * - `Int8Array` / `Uint8Array` / `Uint8ClampedArray` / `Int16Array` / `Uint16Array` /
 *   `Int32Array` / `Uint32Array` / `Float32Array` / `Float64Array` / `BigInt64Array` /
 *   `BigUint64Array` —— 视图:底层缓冲由脚本自己分配,读写结果只由缓冲内容决定;
 * - `decodeURI` / `decodeURIComponent` / `encodeURI` / `encodeURIComponent` —— 规范里写死的
 *   字符串变换,实现之间没有差异;
 * - `Error` / `EvalError` / `RangeError` / `ReferenceError` / `SyntaxError` / `TypeError` /
 *   `URIError` —— 构造与抛出的结果只由抛出点的输入决定;抛出是脚本自己的控制流,
 *   不是对 VM 之外的影响。
 *
 * ── 这张表不参与白名单反转的判定 ──
 *
 * 白名单反转那一侧由**编译器的名字解析**执行(参赛脚本的编译配置归 E),本表**不**参与它;
 * 本表的消费者是**面向模型的规则文档**里的内置全局表(也归 E 的文档生成)。
 * 两侧**不得互相引用为「依据」**:反转那一侧的依据是编译器的名字解析规则,不是这张名单;
 * 这张名单的依据是上面那一句判据,不是反转的实现。把任一侧当成另一侧的证明,两条链就会
 * 在其中一侧被改动时悄悄分叉,而分叉的形状正是「文档说能用、编译器说不能用」。
 *
 * 回填历史:判据未裁决时这张表刻意空着(位置留着,回填有触发条件);判据由本 feature 裁决后
 * 按判据回填——回填不是一次「把空表填满」的动作,是判据在每一个名字上的一次应用。
 * 删掉一个名字需要一个与判据同等具体的理由,正如加进一个名字需要理由。
 */
export const BUILTIN_GLOBAL_NAMES: readonly string[] = [
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Error",
  "EvalError",
  "Float32Array",
  "Float64Array",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "undefined",
  "WeakMap",
  "WeakSet",
];
