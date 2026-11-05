// `pnpm run mutate` 的入口,保持旧行为不变:只变异 engine 结算管线。
//
// 真正的配置在 `stryker/base.mjs`(共享底座 + TS7 接口错位的绕法)与
// `stryker/engine-processor.mjs`(本分片的 mutate / testFiles 范围)。
// 这里只做转发,避免同一段配置有两个家。
//
// 要跑全仓的其它包:`pnpm run mutate:schema` / `mutate:replay` / `mutate:runner` /
// `mutate:gen` / `mutate:tools`,或更宽的 `pnpm run mutate:engine`。
// 分片的共同前提与已知盲区见 `stryker/base.mjs` 头注。
//
// @ts-check
export { default } from "./stryker/engine-processor.mjs";
