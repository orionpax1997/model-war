/**
 * `renderReplay`:`modelwar replay` 的处理器(hld §9 那一格,provider 是 `@model-war/replay`)。
 *
 * ── 为什么这个处理器住在 `replay` 而不是 `engine` ──
 *
 * `apps/cli/src/commands.ts` 登记的 provider 就是 `@model-war/replay`,而 provider 的含义是
 * 「处理器从哪个包来」——它和 hld §9「模块」列写的组装路径不是同一条纪律,两者不互为校验。
 * 更硬的理由是**依赖方向**:渲染器要读的东西全在回放行里,而引擎在写出之后与「怎么显示它」无关;
 * 让 `replay` 反过来依赖 `engine` 会把 `schema ← replay ← engine` 这条单向依赖掰弯。
 * 顺带满足本票另一条硬约束:**它不依赖引擎状态**。回放行是自足的,画面只从行里读。
 *
 * ── 为什么入参是 `readonly string[]` 而不是「三行的类型」 ──
 *
 * 子命令处理器的入参是该命令名之后的一切(见 `CommandHandler`),**自带参数解析**。
 * 读盘、逐行 JSON 解析、按 `type` 收窄成带类型的行,这三步归读入端 `./parse.ts`
 * (`readLinesOf` / `parseReplay`);本模块只做**渲染**。拿到行后仍按**结构**取值(小取值器):
 * 行的**形状**归真源包 `packages/schema`(hld §7.5,ADR-0003),某一栏形状不对时渲染器不崩,
 * 也**不因此拒跑**——缺 meta / 缺 result 画出来是 `(缺失)` 与跳过,这正是「逐字节一致」要保住的容错。
 *
 * ── 退出码 ──
 * 全仓退出码表(hld §9)是:`0` 正常 / `1` 用法或校验错 / `2` 引擎崩溃 / `3` 不确定超时 / `4` 内部错。
 * 渲染器跑在**已落盘的回放**上,所以它这里只可能出现 0 与 1(缺参、文件读不出、某行不是合法 JSON
 * 都是装载期拒跑)。
 *
 * ── 为什么画面只画最后一 tick ──
 *
 * 一场对局上千 tick,逐 tick 一屏会把终端刷爆,而人看回放问的是「终局长什么样」。所以
 * 头部给全部 tick 的一行摘要(含 `stateHash` 前缀,哈希不符一眼可见),画面只给最后一 tick。
 *
 * ── 为什么头部必须显出 `runner` 栏 ──
 *
 * meta 行第 12 栏记的是这一局**是谁跑的**:桩执行器还是真沙箱。两者产出的回放在结构上无法区分,
 * 而「座位轮换有没有效」「跨版本行为一不一致」这类结论只在真沙箱上成立。不显出来,
 * 有人会拿桩跑的读数当结论——所以 `runner` 为桩时额外打一行显式的警告,不是脚注。
 */

import type { JsonValue } from "@model-war/schema";

import { parseReplay, ReplayReadError } from "./parse.js";

/** 一行读出来之后的样子。渲染器只认这三类,其余按行序忽略。 */
const META = "meta";
const TICK = "tick";
const RESULT = "result";

/** 装载期拒跑。`modelwar replay` 只可能落在 `0`(出了画面)与 `1`(拒绝读这份回放)上。 */
const REFUSED = 1;

/** 缺参、读不到、某行不是合法 JSON、某行不是回放行:都是**装载期**拒跑,退出码 1。 */
const refuse = (message: string): number => {
  process.stderr.write(`modelwar replay: ${message}\n`);
  return REFUSED;
};

// ── 结构化取值:行是外部数据,渲染器不得因某一栏的形状不对而崩 ──────────────────────

type Record_ = { readonly [key: string]: JsonValue };

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** `Array.isArray` 的类型谓词是 `any[]`,收窄不掉 `readonly JsonValue[]`,所以这里自己写一个。 */
const isRecord = (value: JsonValue): value is Record_ =>
  typeof value === "object" && value !== null && !isJsonArray(value);

const recordsOf = (lines: readonly JsonValue[]): readonly Record_[] => lines.filter(isRecord);

const asArray = (value: JsonValue | undefined): readonly JsonValue[] =>
  value !== undefined && isJsonArray(value) ? value : [];

const text = (value: JsonValue | undefined, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const num = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === "number" ? value : fallback;

/** 摘要里只显示哈希前 12 位:够认出「同一 tick 的两次算出同一个哈希」,又不至于盖住画面。 */
const HASH_PREFIX_LENGTH = 12;

const shortHash = (value: string): string => value.slice(0, HASH_PREFIX_LENGTH);

// ── 画面 ────────────────────────────────────────────────────────────────────────

/** 四个座位的字母。座位号 → 字母是**显示**上的约定,不是任何规则的编码。 */
const SEAT_LETTERS = ["A", "B", "C", "D"] as const;

const EMPTY_CELL = ".";
/** 中立点位。归属 `-1` 不是座位,画不出座位字母,故另给一个符号。 */
const NEUTRAL_SITE = "+";
/** 有单位站在别人的点位上:单看一个字母分不出「占了谁的地」,标出来。 */
const UNIT_ON_SITE = "*";

type Cell = {
  readonly x: number;
  readonly y: number;
  readonly unit: number;
  readonly site: number;
};

const seatLetter = (owner: number): string => SEAT_LETTERS[owner] ?? "?";

/** 画面只按坐标落格,故坐标相等的两个对象会**互相覆盖**。落格规则固定为「点位优先于单位」。 */
const cellsOf = (line: Record_): readonly Cell[] => {
  const cells: Cell[] = [];
  for (const site of asArray(line["sites"])) {
    if (!isRecord(site)) {
      continue;
    }
    cells.push({
      x: num(site["x"], 0),
      y: num(site["y"], 0),
      unit: -1,
      site: num(site["owner"], -1),
    });
  }
  for (const unit of asArray(line["units"])) {
    if (!isRecord(unit)) {
      continue;
    }
    cells.push({
      x: num(unit["x"], 0),
      y: num(unit["y"], 0),
      unit: num(unit["owner"], -1),
      site: -1,
    });
  }
  return cells;
};

const gridOf = (line: Record_): readonly string[] => {
  const cells = cellsOf(line);
  const width = cells.reduce((widest, cell) => Math.max(widest, cell.x), 0) + 1;
  const height = cells.reduce((tallest, cell) => Math.max(tallest, cell.y), 0) + 1;
  const grid: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => EMPTY_CELL),
  );
  for (const cell of cells) {
    if (cell.site >= 0) {
      grid[cell.y]![cell.x] = seatLetter(cell.site);
    } else if (cell.site === -1) {
      grid[cell.y]![cell.x] = NEUTRAL_SITE;
    }
  }
  // 第二趟才放单位:同格的「单位压点位」需要在知道「这里有点位」之后才判得出来。
  for (const cell of cells) {
    if (cell.unit < 0) {
      continue;
    }
    grid[cell.y]![cell.x] =
      grid[cell.y]![cell.x] === EMPTY_CELL ? seatLetter(cell.unit).toLowerCase() : UNIT_ON_SITE;
  }
  return grid.map((row) => row.join(" "));
};

const frameOf = (line: Record_): readonly string[] => {
  const rows = gridOf(line);
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return [`  +${"-".repeat(width)}+`, ...rows.map((row) => `  | ${row.padEnd(width)} |`)];
};

const LEGEND = `  A-D 座位点位(所属玩家的座位字母) / a-d 单位 / + 中立点位 / * 单位站在非自家点位上 / ${EMPTY_CELL} 空`;

/**
 * `modelwar replay <replay.jsonl>`:把回放渲染成 ASCII 画面,**返回进程退出码**。
 *
 * 退出码走返回值而不是 `process.exitCode`,理由见 `apps/cli/src/commands.ts` 的 `CommandHandler`
 * 头注:顶层那句无条件赋值会把全局通道覆盖掉。
 */
export const renderReplay = async (args: readonly string[]): Promise<number> => {
  const path = args[0];
  if (path === undefined) {
    return refuse("用法:modelwar replay <replay.jsonl>");
  }
  try {
    process.stdout.write(renderLines(parseReplay(path)));
  } catch (cause) {
    if (cause instanceof ReplayReadError) {
      return refuse(cause.message);
    }
    throw cause;
  }
  return 0;
};

const renderLines = (lines: readonly JsonValue[]): string => {
  const all = recordsOf(lines);
  const meta = all.find((line) => line["type"] === META);
  const ticks = all.filter((line) => line["type"] === TICK);
  const result = all.findLast((line) => line["type"] === RESULT);

  const runner = meta === undefined ? "" : text(meta["runner"], "");
  const out: string[] = [
    "== 回放 ==",
    `  schema ${String(num(meta?.["schemaVersion"], 0))} · ruleset ${text(meta?.["ruleset"], "?")} · ` +
      `seed ${String(num(meta?.["seed"], 0))} · map ${shortHash(text(meta?.["mapHash"], ""))} · ` +
      `runner ${runner === "" ? "(缺失)" : runner}`,
  ];
  if (runner !== "" && runner !== "quickjs") {
    // 显式警告而不是脚注:这一栏不显出来,桩跑的读数就会被当成真沙箱的结论。
    out.push(
      "  ⚠ runner 不是 quickjs:本局由桩执行器产出,沙箱行为类结论(座位轮换、跨版本一致性)不可由它得出。",
    );
  }
  for (const player of asArray(meta?.["players"])) {
    if (!isRecord(player)) {
      continue;
    }
    out.push(
      `  座位 ${seatLetter(num(player["seat"], -1))} · ${text(player["model"], "?")} · ${text(player["archiveRef"], "?")}`,
    );
  }

  out.push("", `== 逐 tick 摘要(共 ${String(ticks.length)} 行)==`);
  for (const tick of ticks) {
    out.push(
      `  t${String(num(tick["tick"], 0))} · 单位 ${String(asArray(tick["units"]).length)}` +
        ` · 点位 ${String(asArray(tick["sites"]).length)}` +
        ` · 事件 ${String(asArray(tick["events"]).length)}` +
        ` · hash ${shortHash(text(tick["stateHash"], ""))}`,
    );
  }

  const last = ticks.at(-1);
  if (last !== undefined) {
    out.push("", `== 画面(tick ${String(num(last["tick"], 0))})==`, ...frameOf(last), LEGEND);
  }
  if (result !== undefined) {
    const rankings = asArray(result["rankings"]).map(
      (value, seat) => `${seatLetter(seat)}=${String(num(value, 0))}`,
    );
    out.push(
      "",
      "== 终局 ==",
      `  reason ${text(result["reason"], "?")} · 名次 ${rankings.join(" ")} · ` +
        `领土分 ${asArray(result["territoryScores"])
          .map((value, seat) => `${seatLetter(seat)}=${String(num(value, 0))}`)
          .join(" ")}`,
    );
  }
  return `${out.join("\n")}\n`;
};
