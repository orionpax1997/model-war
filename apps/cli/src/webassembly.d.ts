/**
 * CLI 侧用到的 `WebAssembly` 最小名字面。
 *
 * 类型基座的 `lib` 是 `["es2023"]`,而 `WebAssembly` 全域只在 DOM / WebWorker 那两份 lib 里。
 * CLI 组装层只用到 `WebAssembly.compile`(把 wasm 字节编译成一个 `Module`,四 VM 复用)与
 * 返回的 `Module` 两个名字,故在此就地声明最小面,而不是把 DOM 拉进来。
 *
 * 与 `packages/engine/src/webassembly.d.ts` 同形:两处各在自己的 TS 程序里声明,不构成重复。
 */
declare namespace WebAssembly {
  interface Module {}

  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
}
