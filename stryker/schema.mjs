// 分片:packages/schema —— 契约与 schema 形状。
//
// 19 个文件全是纯数据形状/校验,测试用 `from "./index.js"` 相对 import → 变异可见。
// 注意:全仓有 29 个 engine 测试、17 个 cli 测试经 `@model-war/schema` 引它,但那批读的是
// 仓库里的 dist(见 base.mjs 头注),**看不见本分片的变异**。
//
// ── 实测:231 个变异体,分数 0%,而且这个 0% 不是缺陷 ──────────────────
// 全部 231 个都是 `static: true`(模块顶层声明),且按文件高度集中:
//   script-surface.ts 97、script-outcome.ts 55、builtin-globals.ts 54、ruleset.ts 9 …
// 它们的 mutatorName 几乎全是 StringLiteral —— 变异的是**名单里的名字**
// (`{ "JSON", "Object", "Map" … }` 这一类的表)。
// 杀这种变异体只说明「测试把名单又抄了一遍」,而 hld 明确禁止那种抄写:
// 「参数取值真源是 rulesets/*.json;docs/rules-vN 的数值表由它生成,文档里不复制取值」。
// 所以本分片的分数**没有解释力**:它低不代表测试弱,高也不代表测试强。
//
// 保留这个分片是为了两件事:312 里那点真逻辑(ruleset.ts / ruleset-keys.ts / trial-plan.ts)
// 的变异仍有意义;以及「分数无解释力」这件事本身有据可查,不必每半年重新发现一次。
// 判断 schema 该不该有测试,看它的消费者(engine / cli 的解析路径),不看这行数字。
//
// ── 但 0% 里至少有一条是真缺口,别把整片当噪声 ────────────────────
// `script-surface.ts` 的 `export const HOST_BRIDGE_PREFIX: string = "__"` → `""` **存活**。
// 原因不是「没测试」,而是两边的覆盖错位:
//   - schema 自己的测试只用 `startsWith(HOST_BRIDGE_PREFIX)` 自洽地使用它,
//     前缀变成空串时它们全部照旧通过 → 这个值本身没有任何断言。
//   - 唯一钉住 `expect(HOST_BRIDGE_PREFIX).toBe("__")` 的是 engine 的
//     `runner/stub.test.ts:27`,而它经 `@model-war/replay` 取值——跨包,看不见本包的变异。
// 所以这一条既说明分数低不全是噪声,也说明修复点在 schema 自己的测试里,不在分片配置里。
//
// 耗时:231 个变异体 / 128 秒(本机 8 核,concurrency 50%)。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "schema",
  mutate: [
    "packages/schema/src/**/*.ts",
    "!packages/schema/src/**/*.test.ts",
    "!packages/schema/src/**/*.d.ts",
  ],
  testFiles: ["packages/schema/src/**/*.test.ts"],
});
