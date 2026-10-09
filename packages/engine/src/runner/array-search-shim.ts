/**
 * 上游缺陷的**宿主侧**规避:`Array.prototype.find` 家族在中断点上二次释放元素。
 *
 * ── 缺陷是什么(quickjs-ng #1792) ──
 *
 * `js_array_find`(find / findIndex / findLast / findLastIndex 共用这一份 C 实现)在每轮循环的
 * **顶部**先 `js_poll_interrupts(ctx)`,再读元素;不匹配的那一轮末尾 `JS_FreeValue(val)` 释放元素
 * 却**不复位 `val`**。于是当宿主的中断处理器恰好在顶部那次检查处返回真时,异常出口会把上一轮
 * 已经释放过的 `val` **再释放一次**——数组自己还持有该元素的引用,却已被提前释放。后果:
 * 下一次 `JS_RunGC` 在 `gc_decref_child` 命中 `JS_REF_COUNT(p) > 0`、随后在 `js_free_shape0`
 * 命中 `JS_REF_COUNT(sh) == 0`,WASM trap → 子进程 `exitCode 2`。
 *
 * 上游线索:https://github.com/quickjs-ng/quickjs/issues/1792(0.16.2 起存在,master 仍在;
 * 建议修法是循环内释放后把 `val` 复位为 `undefined`)。`quickjs-wasi@3.6.2` 内置的正是
 * quickjs-ng 0.17.0,故本仓无法靠升级取到修复。
 *
 * ── 为什么规避放在**宿主侧**而不是入 guest runtime bundle ──
 *
 * guest runtime bundle 的字节 sha256 是 `SANDBOX_RUNTIME_HASH`,**每份存档的 `meta.json` 都钉住
 * 它**,装载期逐字节比对(见 `apps/cli/src/match/assemble.ts` 的 `validateArchiveMeta`)。改 bundle
 * 会让所有历史存档判为「沙箱未被信任」而拒跑——包括本缺陷要救的那一局。故规避必须落在
 * **不改变 bundle 字节**的地方:建 VM 时由宿主 `evalCode` 一段小 shim,把四个方法换成等价的
 * JS 实现。JS 实现即使自身被中断也只是普通异常,引用计数由解释器正常回退,**不具备那份 C
 * 实现的二次释放口子**。
 *
 * ── 语义等价 ──
 *
 * 四个方法按 ECMA-262 的 `Array.prototype.find` 家族语义实现(ToObject / LengthOfArrayLike /
 * `HasProperty` / `Call(predicate, thisArg, [value, index, O])` / 从右或从左扫描)。它只改**实现**,
 * 不改名字、不改 `this` 语义、不加全局名。未被本 shim 覆盖的内建保持原样。
 */

/**
 * `Array.prototype.find` 家族的等价 JS 实现,建 VM 时由宿主灌进 guest(见 `quickjs.ts` 的
 * `openSandbox`)。它只替换实现、不新增任何全局名,因此不改变脚本的可见 API 面。
 */
export const ARRAY_PROTOTYPE_SEARCH_SHIM = [
  "(function () {",
  "  function toLength(value) {",
  "    var n = Number(value);",
  "    if (n !== n || n <= 0) { return 0; }",
  "    if (n > 9007199254740991) { return 9007199254740991; }",
  "    return Math.floor(n);",
  "  }",
  "  function toObject(receiver, name) {",
  "    if (receiver === null || receiver === undefined) {",
  '      throw new TypeError("Array.prototype." + name + " called on null or undefined");',
  "    }",
  "    return Object(receiver);",
  "  }",
  "  function checkPredicate(predicate) {",
  '    if (typeof predicate !== "function") {',
  '      throw new TypeError("predicate must be a function");',
  "    }",
  "  }",
  "  // 一次 GetValue 后即用:find / findLast 返回那个值,findIndex / findLastIndex 返回下标。",
  "  // 同一元素读两次会与规范(kValue 只读一次)在有 getter 的数组上不等价。",
  "  function search(o, predicate, thisArg, fromRight, wantValue) {",
  "    var len = toLength(o.length);",
  "    var k = fromRight ? len - 1 : 0;",
  "    while (fromRight ? k >= 0 : k < len) {",
  "      if (k in o) {",
  "        var value = o[k];",
  "        if (predicate.call(thisArg, value, k, o)) { return wantValue ? value : k; }",
  "      }",
  "      k += fromRight ? -1 : 1;",
  "    }",
  "    return wantValue ? undefined : -1;",
  "  }",
  "  function install(name, impl) {",
  '    if (typeof Array.prototype[name] === "function") { Array.prototype[name] = impl; }',
  "  }",
  '  install("find", function (predicate, thisArg) {',
  '    var o = toObject(this, "find");',
  "    checkPredicate(predicate);",
  "    return search(o, predicate, thisArg, false, true);",
  "  });",
  '  install("findIndex", function (predicate, thisArg) {',
  '    var o = toObject(this, "findIndex");',
  "    checkPredicate(predicate);",
  "    return search(o, predicate, thisArg, false, false);",
  "  });",
  '  install("findLast", function (predicate, thisArg) {',
  '    var o = toObject(this, "findLast");',
  "    checkPredicate(predicate);",
  "    return search(o, predicate, thisArg, true, true);",
  "  });",
  '  install("findLastIndex", function (predicate, thisArg) {',
  '    var o = toObject(this, "findLastIndex");',
  "    checkPredicate(predicate);",
  "    return search(o, predicate, thisArg, true, false);",
  "  });",
  "})();",
].join("\n");
