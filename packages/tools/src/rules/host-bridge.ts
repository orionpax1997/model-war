/**
 * 宿主桥前缀规则(纯规则层):一段源码 → 一组带行列的违规。**不碰文件系统**,也不读时钟与环境:
 * 同一段源码永远得到同一组违规,这是生成管线每轮迭代都跑它、能 diff 两轮结果的前提。
 *
 * ── 判据:任何标识符链的**根**以桥前缀开头 ──────────────────────────────────────
 * 前缀(`HOST_BRIDGE_PREFIX`,真源 `@model-war/schema` 的 `script-surface.ts`,经
 * `script-surface.ts` 读入)是**命名约定**而不是一张桥名清单:桥函数在初始化后即被删除
 * (hld §5.0 的实测结论 #5),参赛脚本能看见的桥永远是运行时才有的那一个,而静态这一层能判的
 * 只有命名约定本身。因此判据是「这个名字带前缀」,不是「这个名字是某个具体的桥」。
 *
 * 读与写都拒,读的是**出现**而不是**用法**:`__foo`、`__foo.bar()`、`__foo.x = 1`、
 * `function __foo() {}`、`const __foo = 1` 全部违规。**不需要作用域信息**——不查它是不是全局的,
 * 与禁列规则同一条纪律:静态这一层能判的只有「这个名字出现在链上」。
 *
 * ── 为什么脚本**自己声明**一个带前缀的名字也算违规 ────────────────────────────
 * 这是本规则最容易被写成「禁引用某几个名字」的地方,而它不是。判违规的理由不是「这个名字危险」
 * (脚本自己声明的同名变量并不危险),而是**命名约定本身**:脚本里任何带这个前缀的名字都在冒充
 * 宿主注入的桥,而模型没有理由知道哪个是真桥。判掉它省掉的是「模型以为自己在用宿主桥、
 * 而运行时拿到 ReferenceError」这条整轮作废的路径——桥在初始化后已被删,任何形式的触碰
 * (引用或声明)都拿不到它。所以诊断里说的是**改名**,不是「不许声明」。
 *
 * ── 边界:本规则判不了 / 不判的三处 ──────────────────────────────────────────
 * ① **键位上的名字放行**(`obj.__foo`、`{ __foo: 1 }`、`class A { __foo() {} }`):那是一次取值,
 *    链的根是 `obj`,不是 `__foo`。与禁列规则同一份「键位不算按名字找符号」的判据
 *    (见 `identifier-chain.ts` 的头注),两边不放行的理由同源:误伤在五轮迭代预算里不对称地致命。
 * ② **解构简写**(`const { __a } = g`):那个位置上的标识符是被绑定的名字,判它等于把一次取值
 *    当一次引用。放过它是一次漏报,而漏报的代价只是回到现状(桥不存在,脚本拿到 ReferenceError)——
 *    这一处的漏报比①②都**更无害**,理由值得说清:放行的只是**声明处**那一个节点,此后这个
 *    名字的每一次裸引用(`return __a`、`__a + 1`)仍然逐个判违规。于是脚本即便写出了
 *    `const { __a } = g`,也**用不了**这个局部量——能通过校验的只有「声明了但从不读」的写法。
 *    把这条当作漏报来补,代价是给 `identifier-chain.ts` 加一条「解构简写算引用」的分支,
 *    而那会让禁列规则反过来开始误报 `const { Date } = g`(同一个遍历判据,方向相反)。
 *    误伤在五轮迭代预算里不对称地致命,所以这一格选放行。
 * ③ **字符串里的名字**(`obj["__foo"]`、`"__foo"`)不在判据内:那不是标识符,链的根仍是 `obj`。
 *
 * ── 与注入面的关系:一条本 feature 之前不成立的保证 ──────────────────────────
 * 脚本 API 的注入面走的是**另一张表**(`SANDBOX_INJECTED_API_SYMBOLS`,同样是真源读入),
 * 桥走本文件这条前缀约定,两张表在本 feature 之前**没有任何机器保证它们不打架**——注入面里
 * 躺着一个带前缀的名字,静态校验器就会拒掉一个沙箱执行器本该注入的符号。现在这条不变量由真源
 * 包那侧的机器断言守着(`packages/schema/src/script-surface.test.ts`:注入面里不得出现带桥前缀
 * 的名字)。断言落在真源那侧而不是这里,因为**两张表都是它的事实**,而这张表当前为空,
 * 在校验器里断言它只能断言「空集合没有前缀名」这种恒真的废话。
 *
 * ── 与禁列的重叠:按判定链顺序判为禁列 ────────────────────────────────────────
 * 判定链是**语法失败 → 禁列 → 桥前缀 → 模块系统 → 体积**(见 `validate/pipeline.ts`),顺序是裁决。
 * 一个既命中禁列又带桥前缀的构造因此**两条都会报**,而禁列那条排在前面(同一位置按类别名兜底,
 * `forbidden-global` < `host-bridge`)。今天的禁列名单里没有任何一条带前缀,所以这处重叠
 * 造不出来源样本;真源那侧**刻意不**断言「禁列与前缀不相交」——交集将来出现或消失都合法,
 * 两种状态下都有裁决兜着。裁决因此落在两个可观察的断言上(全序比较的兜底顺序、每条禁列名
 * 只报一条),用例与理由见 `host-bridge.test.ts`。顺序在本规则上没有别的漏洞:
 * 本规则不查内置全局名:白名单反转那一层是编译器的名字解析(hld §6.2),而 `__*` 带前缀的名字
 * 同样不在内建全局名里,于是那一层并不覆盖它们——宿主桥前缀由本规则唯一承载。
 */

import { parseToAst, positionAt } from "../parse-source.ts";
import { isHostBridgeSymbol, HOST_BRIDGE_PREFIX } from "../script-surface.ts";
import { referenceChainsOf, type ChainSegment } from "./identifier-chain.ts";
import type { ScriptLintContext, ScriptLintStage, ScriptViolation } from "./script-lint.ts";

/** 全局对象本身。它是「等价写法」而不是「某个对象的属性」:比较之前先把它剥掉。 */
const GLOBAL_THIS = "globalThis";

/**
 * 剥掉开头的 `globalThis` 后,这条链的根是否带桥前缀。命中时返回剥完的链,
 * 好让违规的位置落在**那个带前缀的名字**上(`globalThis.__setSnapshot` 指的是桥,
 * 不是那个等价前缀)。
 */
const bridgeChainOf = (chain: readonly ChainSegment[]): readonly ChainSegment[] | undefined => {
  const effective = chain[0]?.name === GLOBAL_THIS ? chain.slice(1) : chain;
  const root = effective[0];
  return root !== undefined && isHostBridgeSymbol(root.name) ? effective : undefined;
};

const bridgeMessage = (): string =>
  `宿主桥前缀 \`${HOST_BRIDGE_PREFIX}\`:带这个前缀的名字属于宿主注入的桥,桥在初始化后就被删除,` +
  `脚本拿到的只会是一个能自己吞掉的 ReferenceError。这是命名约定而不是「不许用某几个名字」:` +
  `参赛脚本里的标识符一个都不许带这个前缀,自己声明的也算,请改名并只依赖本脚本自己的量与对局数据。`;

/** 遍历一棵已解析成功的树,收出本级的违规。规则层与判定链两个入口共用这一份扫描。 */
const scanParsed = (program: unknown, source: string): readonly ScriptViolation[] => {
  const seen = new Set<number>();
  const found: number[] = [];
  for (const { chain } of referenceChainsOf(program)) {
    const root = bridgeChainOf(chain)?.[0]?.start;
    // **同一次出现会以多段链的形式走到手上**:遍历既访问 `__host` 这个标识符,也访问整条链
    // `__host.x`,两者的根是同一个名字。判据只看根,所以按根的偏移去重——一次出现一条违规,
    // 否则面向模型层那行会报「2 处」而模型只看得见一个名字。
    if (root !== undefined && !seen.has(root)) {
      seen.add(root);
      found.push(root);
    }
  }

  return found.map((start) => {
    const { line, column } = positionAt(source, start);
    return {
      rule: "host-bridge",
      message: bridgeMessage(),
      line,
      column,
      blocking: true,
    };
  });
};

/**
 * 判定链上的第二级(桥前缀一级)。上下文里已经带着解析结果,所以这里**不重复解析**——
 * 判定链把「解析失败独占」这件事挡在前面(见 `validate/pipeline.ts`),上下文里没有可用解析结果时
 * 本级返回空数组:那条路径的结论属于解析层,不由规则层重复产出。
 */
export const hostBridgeStage: ScriptLintStage = (context: ScriptLintContext) => {
  const { parsed } = context;
  return parsed === undefined || !parsed.ok ? [] : scanParsed(parsed.program, context.source);
};

/**
 * 规则层的对外缝:一段源码 → 一组带行列的违规。形状与 `forbiddenGlobalViolations` 同形,
 * 判据与上面那条完全同一份扫描,所以两个入口永远给出一致的结论。
 *
 * 解析不过时返回空数组:「解析失败」是判定链独占的那一条结论,它产自 `validate/pipeline.ts`。
 * 规则层在这里再产一份就等于同一件事有两个家,而调用方拿到的会是两条互相矛盾的违规。
 *
 * 源形态是 script-mode 的单文件(hld §2.2.2 的入口契约),规则跑在**编译后的产物**上,
 * 不在原始 TS 上跑(spec《规则跑在编译产物上》)。
 */
export const hostBridgeViolations = (source: string): readonly ScriptViolation[] => {
  const parsed = parseToAst(source, "script");
  return parsed.ok ? scanParsed(parsed.program, source) : [];
};
