/**
 * id 分配器(hld §4.1)。
 *
 * **它的全部状态就是 `GameState.nextId`**,所以本模块不持有任何可变的全局量:分配号是一次
 * (取号, 号+1) 的纯函数调用。id 全局单调递增且**含被销毁对象**——被销毁对象的号不回收,
 * 于是「一个号曾经属于谁」在整局里是可追溯的事实,而不是靠「当前谁活着」倒推。
 *
 * 为什么单调递增这件事要落在类型之外的一个专门模块里:结算管线里每一次创建对象都要取号,
 * 而「取号」与「写状态」必须同在 `apply()` 里(hld §4.1 的唯一写入口)。把取号单独做成一个
 * 纯函数,是为了让「号从哪儿来」这件事只有一个落点,而不是散成 `state.nextId++` 与
 * `id: state.nextId` 两处写法不同的分配。
 */

/** 分配器的状态:下一个将被分配的号。 */
export type IdGen = {
  readonly next: number;
};

/** 起始号。对象号从 1 起,0 留空——「0 号」在本仓不作任何有意义的对象。 */
export const ID_START = 1;

export const createIdGen = (): IdGen => ({ next: ID_START });

/** 取一个号,并返回取号之后的分配器。取号不读也不写任何世界状态。 */
export const allocateId = (gen: IdGen): { readonly id: number; readonly gen: IdGen } => ({
  id: gen.next,
  gen: { next: gen.next + 1 },
});

/** 只看不取:装载期与测试用它断言「下一个号是多少」,取号本身必须走 `allocateId`。 */
export const peekNextId = (gen: IdGen): number => gen.next;