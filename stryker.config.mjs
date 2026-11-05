// 裸 `stryker run`(不带配置文件)的入口,保持旧行为不变:只变异 engine 结算管线。
//
// 真正的配置在 `stryker/base.mjs`(共享底座 + TS7 接口错位的绕法)与
// `stryker/engine-processor.mjs`(本分片的 mutate / testFiles 范围)。
// 这里只做转发,避免同一段配置有两个家。
//
// 命名脚本 `pnpm run mutate` 现在显式写 `stryker run stryker/engine-processor.mjs`,
// 并在后面串上棘轮门禁(`run-mutation-ratchet-gate.ts --shard=engine-processor`):
// 一份脚本读到的分片配置名与它比较的基线名必须一眼对得上,不必再穿一层转发。
//
// 要跑全仓的其它包:`pnpm run mutate:schema` / `mutate:replay` / `mutate:runner` /
// `mutate:gen` / `mutate:tools`,或更宽的 `pnpm run mutate:engine`。
// 分片的共同前提与已知盲区见 `stryker/base.mjs` 头注。
//
// @ts-check
export { default } from "./stryker/engine-processor.mjs";
