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

/**
 * 分配器的起点,也是**没有地图号时的地板**。
 *
 * 号空间自 0 起稠密,而**地图声明的那批点位号占据低端**——本仓三张真图的点位号是 0..27,
 * 其中就有 0 号点位。所以「0 是留空的、不作对象号」是句假话;0 在本仓是一个合法的点位号。
 * `ID_START` 只是单位分配器在「地图一个点位都没有」时从哪个号起,不是「号空间的下界」。
 * 开局时 `createInitialState` 会把它抬到所有地图号之上(见 `world/initial-state.ts`)。
 */
export const ID_START = 1;

export const createIdGen = (): IdGen => ({ next: ID_START });

/** 取一个号,并返回取号之后的分配器。取号不读也不写任何世界状态。 */
export const allocateId = (gen: IdGen): { readonly id: number; readonly gen: IdGen } => ({
  id: gen.next,
  gen: { next: gen.next + 1 },
});

/** 只看不取:装载期与测试用它断言「下一个号是多少」,取号本身必须走 `allocateId`。 */
export const peekNextId = (gen: IdGen): number => gen.next;
