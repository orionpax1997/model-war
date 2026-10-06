/**
 * engine 侧用到的最小 `WebAssembly` 名字面。
 *
 * 类型基座的 `lib` 是 `["es2023"]`(hld §2.2.8 的隔离条款:不把 DOM 带进内核),而 TypeScript 的
 * `WebAssembly` 全域只在 DOM / WebWorker 那两份 lib 里。引擎并不需要整份 DOM——沙箱这一格只用到
 * `WebAssembly.compile` 与 `WebAssembly.Module` / `WebAssembly.Memory` 三个名字,故在此就地声明
 * 最小面,而不是把 DOM 拉进来。
 *
 * 它不引入任何运行时代码:`.d.ts` 只描述既有的宿主全局 `WebAssembly`(Node ≥ 22 自带)。
 */
declare namespace WebAssembly {
  interface Module {}

  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }

  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
}
