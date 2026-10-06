/**
 * tools 侧沙箱探针用到的最小 `WebAssembly` 名字面。
 *
 * 类型基座的 `lib` 是 `["es2023"]`(不把 DOM 带进工具包;`WebAssembly` 全域只在 DOM / WebWorker
 * 那两份 lib 里),而探针只用到 `WebAssembly.compile` 与 `WebAssembly.Module` 两个名字。
 * 就地声明最小面,而不是把整份 DOM 拉进来。形态与 `packages/engine/src/webassembly.d.ts` 同源。
 *
 * 它不引入任何运行时代码:`.d.ts` 只描述既有的宿主全局 `WebAssembly`(Node ≥ 22 自带)。
 */
declare namespace WebAssembly {
  interface Module {}

  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
}
