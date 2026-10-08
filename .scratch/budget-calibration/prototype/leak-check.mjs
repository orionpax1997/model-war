#!/usr/bin/env node
// PROTOTYPE(throwaway)——隔离一个问题:存活堆随 tick 单调增长是运行时行为,还是插桩引入的?
//
// 只做**真实 runner 的次序**、不加任何额外动作(beginTick → loop → pumpJobs → endTick →
// drainIntents),每 50 tick 一次 runGC + mallocSize 取样。脚本为空。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const load = async (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const schema = await load("packages/schema/dist/index.js");
const { openSandbox } = await load("packages/engine/dist/runner/quickjs.js");

const ruleset = JSON.parse(readFileSync(join(ROOT, "rulesets", "v1.json"), "utf8"));
const runtimeCode = readFileSync(join(ROOT, schema.SANDBOX_RUNTIME_ARTIFACT_PATH), "utf8");
const wasm = readFileSync(join(ROOT, schema.QUICKJS_WASI_WASM_PATH));

const session = await openSandbox({
  wasm: await WebAssembly.compile(wasm),
  runtimeCode,
  scriptCode: "function loop() {}\n",
  seat: 0,
  ruleset,
  eventTickLimit: Number.MAX_SAFE_INTEGER,
});

const snapshot = { tick: 0, size: 64, terrain: [], players: [], units: [], sites: [] };
for (let tick = 0; tick < 601; tick += 1) {
  session.setSnapshot({ ...snapshot, tick });
  session.beginTick();
  session.runLoop();
  session.pumpJobs();
  session.endTick();
  session.drainIntents();
  if (tick % 50 === 0) {
    session.runGC();
    const u = session.memoryUsage();
    console.log(`tick=${tick} mallocSize=${u.mallocSize} memoryUsedSize=${u.memoryUsedSize} objCount=${u.objCount ?? "-"}`);
  }
}
session.runGC();
console.log("final", session.memoryUsage());
session.dispose();
