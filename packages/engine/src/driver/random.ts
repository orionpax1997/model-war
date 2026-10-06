/**
 * 随机源:整数 LCG(hld §4.6「对局内不消费随机数;唯一 Random 在 engine 内、
 * 开局前一次性用于地图变体填充」)。
 *
 * 三条纪律,每条都写在代码里而不是只写在注释里:
 * - **对局内不消费随机数**:本模块没有任何一个调用点挂在结算管线上,只挂在开局前的地图变体填充上。
 *   一旦有人在对局中取号,重放一致性(NFR-1)当场失效,而这类漂移极难查。
 * - **整数闭包**:乘法走 `Math.imul`(白名单内),取模走位与,**全程不出现浮点**;
 *   `packages/engine/src` 里一个浮点字面量都不许有(门禁 `check:no-float`)。
 * - **消费顺序 = 变体槽位声明顺序**:同一种子必须得到同一张图,否则「同配置重跑」不成立。
 *
 * 为什么是纯函数而不是一个带内部计数器的小对象:填充要被复算,而「拿一个数」这件事一旦藏在
 * 可变对象里,复算就得先把对象快照下来——纯函数让「消费顺序」变成调用点的书写顺序,看得见。
 */

import type { MapDefinition } from "@model-war/replay";

/** 乘数与增量取自 ANSI C 的 `rand48` 参数族;模取 2 的幂是为了让取模落到位运算上。 */
const LCG_MULTIPLIER = 1103515245;
const LCG_INCREMENT = 12345;
const LCG_MODULUS = 0x80000000;
const LCG_MASK = LCG_MODULUS - 1;

/**
 * 抽签取高位:`nextInt` 的值域是 `[0, 2^31)`,`>>> 16` 拿到的是最高的 15 位。
 *
 * 为什么不能取低位(本文件一度取的是 `value % bound`,踩过这个坑):
 * 模 2^31 的 LCG 里,乘数与增量**都是奇数**,于是
 * `bit0(state_{n+1}) = bit0(a·state_n + c) = bit0(state_n) XOR 1`——最低位每步必然翻转。
 * `bound = 2` 时 `value % 2` 取的就是这个最低位,于是抽签恒是 `01010101`(或它的补),
 * **与种子的取值无关,只与种子的奇偶有关**;全仓种子只产得出两张地图(见 `random.test.ts`
 * 里那两条反例用例)。
 *
 * 一般地,位 k 的周期是 `2^(k+1)`(`a ≡ 1 mod 4`、`c` 为奇数时 LCG 满周期,低位是它的
 * 最短循环),所以只有高位能承载「种子取值 → 不同图」这件事。取 15 位而不是全部 31 位:
 * 低 16 位里最靠上的那一位的周期也只有 `2^16`,留在抽样里会把坏周期性漏进来。
 */
const LCG_DRAW_SHIFT = 16;

export type Random = {
  readonly state: number;
};

export const createRandom = (seed: number): Random => ({ state: seed % LCG_MODULUS });

/**
 * 取下一个整数(值域 `[0, 2^31)`),并返回取数之后的随机源。
 *
 * 这里只负责推进状态;「哪些位可以拿来用」是 `nextBelow` 的事(理由见 `LCG_DRAW_SHIFT`)。
 */
export const nextInt = (random: Random): { readonly value: number; readonly random: Random } => {
  const state = (Math.imul(random.state, LCG_MULTIPLIER) + LCG_INCREMENT) & LCG_MASK;
  return { value: state, random: { state } };
};

/**
 * 取 `[0, bound)` 内的一个整数,**抽的是状态的高位**(理由与反例见 `LCG_DRAW_SHIFT`)。
 *
 * 取模带来的偏差对**装饰性**用途是可接受的:地图变体只决定「哪些槽位填上墙」(gdd §4.1),
 * 它不进任何裁决,于是偏差不改变任何一局的结果。这也是本仓唯一一处「近似」可接受的地方——
 * 一旦这个取值的消费方从地图装饰挪到任何裁决上,这条理由即失效,必须换成无偏取法。
 */
export const nextBelow = (
  random: Random,
  bound: number,
): { readonly value: number; readonly random: Random } => {
  const drawn = nextInt(random);
  return { value: (drawn.value >>> LCG_DRAW_SHIFT) % bound, random: drawn.random };
};

const PLAIN = ".";
const WALL = "#";

/**
 * 按种子把变体槽位填成墙(hld §7.3:种子驱动地图变体,**只做装饰性微扰**)。
 *
 * 一条槽位是**一条完整四重旋转轨道的 4 个坐标**(`MapVariantSlot` 是定长 4 元组),
 * 所以一次抽签要么把四个坐标全填上、要么一个不填——四重对称由此在形状上成立,
 * 不需要这里再实现一次旋转。点位与初始单位一字不改:变体不改变玩法。
 *
 * 消费顺序 = 槽位在地图里声明的顺序(地图数据按 id 升序落库),这是「同种子同图」的前提。
 */
export const fillVariantWalls = (
  random: Random,
  map: MapDefinition,
): { readonly map: MapDefinition; readonly random: Random } => {
  // 逐行拆成字符数组。用 `split("")` 而不是 `[...row]`:地形字符只有 `.` 与 `#` 两个 ASCII,
  // 两者结果逐字相同,而展开运算符在码点层面拆串,会被类型感知 lint 判成「拆 emoji 拆错了」——
  // 那条担忧对一份由两个 ASCII 字符构成的字符表不成立。
  const rows = map.terrain.map((row) => row.split(""));
  let state = random;
  for (const slot of map.variantSlots) {
    const drawn = nextBelow(state, 2);
    state = drawn.random;
    if (drawn.value !== 0) {
      continue;
    }
    // 越界的那一格被 `row?.[x]` 的 undefined 挡掉:地图的跨字段自洽归 map-lint,引擎不重复判。
    for (const [x, y] of slot) {
      const row = rows[y];
      if (row !== undefined && row[x] === PLAIN) {
        row[x] = WALL;
      }
    }
  }
  return { map: { ...map, terrain: rows.map((row) => row.join("")) }, random: state };
};
