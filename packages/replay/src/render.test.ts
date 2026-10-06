/**
 * `renderReplay`:`modelwar replay` 的处理器(回放 → ASCII 画面)。
 *
 * 断言打的是**处理器**(参数、退出码、stdout),不是内部那个纯渲染函数——CLI 走的就是这条路。
 * 钉住它**不依赖引擎状态**(只从回放行里读),以及 **`runner` 栏被显出来**:
 * 后者是票里点名的验收——不显出来,有人会拿桩跑的读数当座位轮换的结论。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { renderReplay } from "./render.js";

const META = (runner: string) => ({
  type: "meta",
  schemaVersion: 1,
  ruleset: "v1",
  quickjsWasiVersion: runner === "quickjs" ? "0.8.0" : null,
  sandboxRuntimeHash: runner === "quickjs" ? "b".repeat(64) : null,
  wasiClock: null,
  wasiRandomFill: null,
  timezoneOffset: "+08:00",
  mapHash: "a".repeat(64),
  seed: 20260101,
  players: [
    { model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 },
    { model: "beta", archiveRef: "archive/beta/r1", seat: 1 },
    { model: "gamma", archiveRef: "archive/gamma/r1", seat: 2 },
    { model: "delta", archiveRef: "archive/delta/r1", seat: 3 },
  ],
  runner,
});

const TICK = (tick: number, hash: string) => ({
  type: "tick",
  tick,
  players: [],
  units: [
    { id: 1, owner: 0, x: 0, y: 0 },
    { id: 2, owner: 1, x: 2, y: 0 },
  ],
  sites: [
    { id: 3, kind: "base", x: 0, y: 0, owner: 0 },
    { id: 4, kind: "base", x: 2, y: 2, owner: -1 },
  ],
  events: [],
  stateHash: hash,
});

const RESULT = {
  type: "result",
  rankings: [1, 2, 3, 4],
  reason: "timeout",
  territoryScores: [8, 4, 0, 0],
};

/** 跑处理器并把它写到 stdout 的那段收回来:断言对象是命令的外部可观察行为。 */
const run = async (path: string | undefined): Promise<{ status: number; out: string }> => {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const status = await renderReplay(path === undefined ? [] : [path]);
    return { status, out };
  } finally {
    process.stdout.write = write;
  }
};

let dir = "";
let stubPath = "";
let quickjsPath = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-render-"));
  stubPath = join(dir, "stub.jsonl");
  quickjsPath = join(dir, "quickjs.jsonl");
  writeFileSync(
    stubPath,
    `${JSON.stringify(META("stub"))}\n${JSON.stringify(TICK(0, "c".repeat(64)))}\n`,
    "utf8",
  );
  writeFileSync(
    quickjsPath,
    `${JSON.stringify(META("quickjs"))}\n${JSON.stringify(TICK(0, "c".repeat(64)))}\n${JSON.stringify(TICK(1, "d".repeat(64)))}\n${JSON.stringify(RESULT)}\n`,
    "utf8",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("把 meta 行的 runner 栏读出来显在头部", async () => {
  const { status, out } = await run(quickjsPath);
  expect(status).toBe(0);
  expect(out).toContain("runner quickjs");
  expect(out).toContain("seed 20260101");
  expect(out).toContain("ruleset v1");
  // 四个座位的模型与存档引用也要看得见:回放是「可复算原始数据」,模型对不上就复算不了。
  expect(out).toContain("archive/beta/r1");
});

it("桩跑的局额外打一行显式警告(否则有人拿桩的读数当真沙箱的结论)", async () => {
  const stub = await run(stubPath);
  // 「不显出 runner」的反例:这一条红,而危险的不是渲染,是有人据它下结论。
  expect(stub.out).toContain("⚠ runner 不是 quickjs");
  const quickjs = await run(quickjsPath);
  expect(quickjs.out).not.toContain("⚠");
});

it("画面按坐标落格:座位点位大写,中立点位 +,单位小写,压在点位上标 *", async () => {
  const { out } = await run(stubPath);
  expect(out).toContain("== 画面(tick 0)==");
  expect(out).toContain("A");
  expect(out).toContain("+");
  expect(out).toContain("*");
  expect(out).toContain("a-d 单位");
});

it("逐 tick 摘要带 stateHash 前缀,末行 result 给出名次与领土分", async () => {
  const { out } = await run(quickjsPath);
  expect(out).toContain(`hash ${"c".repeat(12)}`);
  expect(out).toContain(`hash ${"d".repeat(12)}`);
  expect(out).toContain("共 2 行");
  expect(out).toContain("reason timeout");
  expect(out).toContain("A=1");
});

it("缺参、读不到、某一行不是合法 JSON:一律装载期拒跑,退出码 1", async () => {
  const broken = join(dir, "broken.jsonl");
  writeFileSync(broken, `${JSON.stringify(META("stub"))}\n{oops\n`, "utf8");
  // 静默返回 0 的反例:这三条一起红——自动化流程把「没跑成」读成「跑通了」。
  expect((await run(undefined)).status).toBe(1);
  expect((await run(join(dir, "no-such.jsonl"))).status).toBe(1);
  expect((await run(broken)).status).toBe(1);
});
