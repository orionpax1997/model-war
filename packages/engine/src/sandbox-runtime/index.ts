/**
 * 沙箱运行时(guest 侧):宿主桥的载体 + 注入 API 面的**最小骨架**。
 *
 * ── 它是什么、不是什么 ──
 *
 * 本文件是**跑在 guest 里**的代码,不是引擎的运行时依赖:它被 esbuild 打成单文件 IIFE
 * (票 04 固化成入库产物),经 `evalCode(runtimeCode)` 铺进 VM。所以它**不 import 任何模块**、
 * 不碰 `node:*`、不读盘——它唯一的外部事实是两个桥名,由构建脚本经 esbuild 的 `define` 注入。
 *
 * ── 为什么桥名不手写、要由构建期注入 ──
 *
 * 宿主桥的命名约定住在真源包(`HOST_BRIDGE_PREFIX`,`__`),引擎侧由 `runner/index.ts` 拼成
 * `HOST_BRIDGE_SET_SNAPSHOT` / `HOST_BRIDGE_DRAIN_INTENTS` 两个常量。本文件在 guest 里,
 * import 不到那条常量链(import `@model-war/replay` 会把 `node:crypto` 一起拖进 bundle),
 * 于是那两个标识符在这里声明为**未绑定**,由构建脚本注入字面量。源码里因此一个桥名都不手写:
 * 桥名的家只有一处,构建期一次性传进来。
 *
 * ── 本票只交「桥 + 最小骨架」 ──
 *
 * 注入面的**全表**由 `packages/schema` 的 `SANDBOX_INJECTED_API_SYMBOL_CATALOG` 定稿,铺全是
 * 票 06 的账。本票需要的只有三件事:桥按约定的次序被删、闭包内引用照常、一笔意图能经脊梁
 * (`move`)走到底。所以这里只铺 `getTick` / `getObjectsByType` / `move` 三样,其余留给票 06。
 *
 * ── 座位自认为什么不在本文件 ──
 *
 * 四份 runtime bundle 是**同一串字节**(它的 sha256 就是 `sandboxRuntimeHash`),而 `getMyIndex()`
 * 的返回值每个 VM 不同。所以座位由**宿主按座位注入常量函数**([自证夹具的同一条办法]),
 * 不在 runtime 里留一个可写全局(那会让脚本改掉自己的座位)。
 */

// 由构建脚本注入的两个桥名。声明为未绑定标识符:esbuild 的 `define` 在 bundle 时替换它们。
declare const HOST_BRIDGE_SET_SNAPSHOT: string;
declare const HOST_BRIDGE_DRAIN_INTENTS: string;

/** guest 里的一个单位(形状与 `packages/schema/script-api` 的 `Unit` 同源,这里只读)。 */
type GuestUnit = {
  readonly id: number;
  readonly owner: number;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly carrying: number;
};

/** guest 里的一个点位。 */
type GuestSite = {
  readonly id: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly owner: number;
  readonly progressOwner: number;
  readonly progress: number;
  readonly remaining?: number;
  readonly producing: unknown;
};

/** guest 里的一个玩家。 */
type GuestPlayer = {
  readonly index: number;
  readonly resources: number;
  readonly alive: boolean;
  readonly exceptionTicks: number;
};

/**
 * 交给 guest 的只读快照。
 *
 * 它比契约面的 `Snapshot` 多 `size` / `terrain` 两栏:那是 `getTerrainAt` 与越界判定将来要读的,
 * 而宿主传进来的是引擎快照的**原样**(多这两栏不是本文件添的,是快照本来就带)。
 */
type GuestSnapshot = {
  readonly tick: number;
  readonly size: number;
  readonly terrain: readonly (readonly boolean[])[];
  readonly players: readonly GuestPlayer[];
  readonly units: readonly GuestUnit[];
  readonly sites: readonly GuestSite[];
};

/** 一条待交回的意图。形状由动作函数(`move` 等)构造,真正合法性终裁在引擎。 */
type GuestIntent = Record<string, unknown>;

const guest = globalThis as unknown as Record<string, unknown>;

/** 本 tick 的只读快照。`null` = 宿主还没交过。 */
let snapshot: GuestSnapshot | null = null;

/** 本 tick 已收集、待 `__drainIntents()` 交回的意图。每 tick 由 `__setSnapshot` 清空。 */
let pending: GuestIntent[] = [];

// ── 桥:唯一两个与宿主约定名字的符号 ─────────────────────────────────────────
//
// 它们在脚本执行**之前**被宿主从全局删掉,但本闭包仍持有它们,所以宿主仍能经函数 handle 调用。
// 删桥是纵深防御的第二层,不是判罚手段:删掉之后脚本引用它们只是一次普通 `ReferenceError`。

guest[HOST_BRIDGE_SET_SNAPSHOT] = (next: GuestSnapshot): void => {
  snapshot = next;
  pending = [];
};

guest[HOST_BRIDGE_DRAIN_INTENTS] = (): readonly GuestIntent[] => {
  const drained = pending;
  pending = [];
  return drained;
};

// ── 注入 API 面的最小骨架(铺全归票 06) ──────────────────────────────────────

guest.getTick = (): number => (snapshot === null ? -1 : snapshot.tick);

guest.getObjectsByType = (
  kind: string,
  filter?: { readonly owner?: number; readonly type?: string; readonly kind?: string },
): readonly unknown[] => {
  if (snapshot === null) {
    return [];
  }
  if (kind === "unit") {
    return snapshot.units.filter(
      (unit) =>
        (filter?.owner === undefined || unit.owner === filter.owner) &&
        (filter?.type === undefined || unit.type === filter.type),
    );
  }
  if (kind === "site") {
    return snapshot.sites.filter(
      (site) =>
        (filter?.owner === undefined || site.owner === filter.owner) &&
        (filter?.kind === undefined || site.kind === filter.kind),
    );
  }
  if (kind === "player") {
    return snapshot.players.filter(
      (player) => filter?.owner === undefined || player.index === filter.owner,
    );
  }
  return [];
};

guest.move = (unitId: number, dx: number, dy: number): void => {
  pending = [...pending, { kind: "move", unitId, dx, dy }];
};

// 本文件是一个模块(而非全局脚本):它的顶层声明住在 IIFE 的闭包里,不是一个 guest 全局。
export {};
