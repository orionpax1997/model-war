/**
 * 薄壳—宿主通道的**协议体**:一行 JSON 一请求、一行 JSON 一响应。
 *
 * ── 这条通道是什么(ADR-0032「受限工具不是二进制,是宿主侧的服务」) ──
 * 沙箱里的 `check` / `evaluate` / `done` 不是实现,是三个薄壳:它们把「要做什么」写成一行
 * JSON 交给继承的 fd 3,读回一行响应,按响应里的退出码与两路输出落地。真执行、`evaluate`
 * 的调用计数、会话墙钟全在宿主侧的服务里,超限时宿主回一份伪造的 stderr 且**不执行**。
 *
 * ── 信任方向由位置保住,不由协议保住 ──
 * 响应方向**只在宿主侧写**:管道的另一端只存在于宿主进程里,跨步读不到。所以模型能构造伪造
 * **请求**(那只会消耗它自己的配额,而配额只按调用次数计、不信请求里的任何字段),构造不出
 * 伪造**响应**。这条性质是结构性的,不要把它降级成「协议里加一个签名」。
 *
 * ── 为什么形状是手写解析 + 手写序列化 ──
 * 消费者是沙箱里的 `bash`:`packages/gen/src/agent/shim/shim.sh` 只有 `bash` 与三个 coreutils,
 * 没有 `jq`。所以**响应的字节形态是协议的一部分**,由本模块的 `serializeToolResponse` 定死:
 *
 * - 键序固定 `exitCode` → `result` → `stdout` → `stderr`(最后一个字段永远是 `stderr`);
 * - 字符串转义只许这七个: `\\` `\"` `\n` `\r` `\t` `\f` `\b`;其余 C0 控制字节与 DEL 写成
 *   `\u00XX` 的**字面拼法**——沙箱侧不解释 `\u`,于是这类字节在模型眼里是它自己的拼写。
 *   这不是漏洞:文本通道本来就载不动控制字节,而选择「保留拼写」而不是「悄悄换成 U+FFFD」
 *   是为了让「模型看到的字节」与「宿主手里的字节」之间的差异只有一种、并且可被读懂;
 * - 字段分隔串 `,"stdout":"` / `,"stderr":"` 在**转义之后的字符串里不可能出现**(引号必为
 *   `\"`),所以薄壳可以按分隔串切字段,不需要一个 JSON 解析器。
 *
 * 请求方向宽松一些:薄壳自己拼 `{"tool":…,"args":[…]}`,宿主用 `parseToolRequest` 校验。
 * **额外键一律忽略、永不解释**——「额度」这类字段不可能从请求侧生效(配额按调用次数计)。
 *
 * ── 为什么不与 `packages/gen` 的解析器分家 ──
 * 协议体只有一份:宿主侧的生产代码(dispatcher / 服务)与 gate、单测都读这一份。薄壳那一侧
 * 是 `bash`,它的字段切法在 `shim.sh` 里,由 `packages/gen/src/agent/shim/shim.test.ts` 与
 * 本模块的序列化逐字节对齐(测试直接喂序列化输出给真 `bash`)。
 */

/** 通道用的 fd 序号。执行器(`packages/gen`)与薄壳写死同一个数。 */
export const TOOL_CHANNEL_FD = 3;

/**
 * 受限工具名。白名单由宿主侧的 dispatcher 执行,这里只定**名字的取值域**。
 *
 * `done` 也在里面:块级哨兵正常由宿主侧的执行准备切掉,但模型把它写进管道或写成
 * `true; done` 时薄壳照样会被执行,此时它必须是一条**认得但什么也不做**的合法请求。
 */
export const TOOL_NAMES = ["check", "evaluate", "done"] as const;

/** 受限工具名。 */
export type ToolName = (typeof TOOL_NAMES)[number];

/** `evaluate` 的会话级调用上限(ADR-0030:三次,总量固定、自由分配)。 */
export const EVALUATE_CALL_LIMIT = 3;

/** 一行请求的形状。`args` 是模型给薄壳的参数(目前三个工具都不读它)。 */
export type ToolRequest = {
  /** 工具名。原文交回,白名单判定归宿主(本模块不判)。 */
  readonly tool: string;
  /** 命令行参数(原样转发,薄壳用 `"$@"` 拼)。 */
  readonly args: readonly string[];
};

/** 结果侧的派生视图:进了档案 `steps[i].result` 的那一格。 */
export type ToolResult = {
  /** 诊断来自哪一侧:`tsc` 的类型检查,还是契约的静态校验。 */
  readonly kind: "tsc" | "contract";
  /** 稳定的小集合:`TSxxxx` 错误码,或契约侧的规则标签。 */
  readonly errorCodes: readonly string[];
};

/** 一行响应的形状。**只由宿主写**。 */
export type ToolResponse = {
  /** 命令的退出码。伪造成与「真跑了一次」同形的值。 */
  readonly exitCode: number;
  /** 命令的 stdout(模型看到的第一路)。 */
  readonly stdout: string;
  /** 命令的 stderr(模型看到的第二路)。 */
  readonly stderr: string;
  /** 结果侧派生视图;没有可归纳的东西时缺席。 */
  readonly result?: ToolResult;
};

/** 请求解析的结论。失败时给一条**能读**的理由(它会被写进伪造响应)。 */
export type ToolRequestParse =
  | { readonly ok: true; readonly request: ToolRequest }
  | { readonly ok: false; readonly reason: string };

/** 响应解析的结论。薄壳不读它;宿主侧测试与 gate 用它对齐字节形态。 */
export type ToolResponseParse =
  | { readonly ok: true; readonly response: ToolResponse }
  | { readonly ok: false; readonly reason: string };

/**
 * 请求的 JSON Schema(手写对齐 TypeScript,与 `trial-observation.ts` 同一条纪律)。
 *
 * `additionalProperties` 刻意不写(默认放行):多出来的键**不解释**,而不是把整条请求拒掉。
 * 关掉它会造出「带一个无关字段的请求被拒 → 配额没消耗」这条可被利用的差异。
 */
export const TOOL_REQUEST_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 薄壳通道请求",
  type: "object",
  required: ["tool"],
  properties: {
    tool: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
  },
} as const;

/** 响应的 JSON Schema:**键序与转义由 `serializeToolResponse` 定死**,这里只描形状。 */
export const TOOL_RESPONSE_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 薄壳通道响应",
  type: "object",
  additionalProperties: false,
  required: ["exitCode", "stdout", "stderr"],
  properties: {
    exitCode: { type: "integer" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    result: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "errorCodes"],
          properties: {
            kind: { enum: ["tsc", "contract"] },
            errorCodes: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 解析一行请求。
 *
 * 只判**形状**:`tool` 非空、`args` 若在则是字符串数组。白名单与配额都不在这里——那两件是
 * 宿主 dispatcher 的活,而且它们的判据是「调用次数」,与请求里写了什么无关。
 */
export const parseToolRequest = (line: string): ToolRequestParse => {
  const text = line.trim();
  if (text === "") {
    return { ok: false, reason: "空行不是一条工具请求" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "不是一行合法 JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "请求必须是一个 JSON 对象" };
  }
  const tool = parsed.tool;
  if (typeof tool !== "string" || tool === "") {
    return { ok: false, reason: `请求缺少字符串字段 "tool"(收到 ${JSON.stringify(tool)})` };
  }
  const rawArgs = parsed.args;
  if (rawArgs === undefined) {
    return { ok: true, request: { tool, args: [] } };
  }
  if (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string")) {
    return { ok: false, reason: `"args" 必须是字符串数组(收到 ${JSON.stringify(rawArgs)})` };
  }
  return { ok: true, request: { tool, args: [...rawArgs] } };
};

/**
 * 序列化一行请求。薄壳那一侧是 `bash` 自己拼的(`shim.sh`),这里给宿主侧(测试、gate)用。
 */
export const serializeToolRequest = (request: ToolRequest): string =>
  JSON.stringify({ tool: request.tool, args: request.args });

/**
 * 字符串 → 协议字符串体(**不含两侧引号**)。
 *
 * 转义表就是头注里那七个;其余 C0 控制字节与 DEL 写成 `\u00XX` 的字面拼法(沙箱侧不解释它,
 * 于是这类字节在模型眼里是它自己的拼写)。
 */
export const escapePayload = (text: string): string => {
  // 逐码点走而不是一条正则:转义表本身就是协议,写成 switch 与薄壳里那七行一一对应,
  // 也避免在正则字面量里塞控制字符(那会让「表里有什么」变成一道眼睛的题)。
  let escaped = "";
  for (const char of text) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\f":
        escaped += "\\f";
        break;
      case "\b":
        escaped += "\\b";
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        escaped += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : char;
      }
    }
  }
  return escaped;
};

/**
 * 序列化一行响应。**键序就是协议**(见头注):`exitCode` → `result` → `stdout` → `stderr`。
 *
 * 没有 `result` 时写 `null` 而不是省掉键:薄壳靠「`stderr` 是最后一个字段」切尾巴,字段数
 * 在三行之间摇摆会让那条切法分叉。
 */
export const serializeToolResponse = (response: ToolResponse): string => {
  const result =
    response.result === undefined
      ? "null"
      : `{"kind":"${response.result.kind}","errorCodes":[${response.result.errorCodes
          .map((code) => `"${escapePayload(code)}"`)
          .join(",")}]}`;
  return (
    `{"exitCode":${String(response.exitCode)},"result":${result}` +
    `,"stdout":"${escapePayload(response.stdout)}"` +
    `,"stderr":"${escapePayload(response.stderr)}"}`
  );
};

/** 解析一行响应。宿主侧测试与 gate 用它,薄壳不用(它按分隔串切,见头注)。 */
export const parseToolResponse = (line: string): ToolResponseParse => {
  const text = line.trim();
  if (text === "") {
    return { ok: false, reason: "空行不是一条工具响应" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "不是一行合法 JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "响应必须是一个 JSON 对象" };
  }
  const { exitCode, stdout, stderr } = parsed;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    return { ok: false, reason: `"exitCode" 必须是整数(收到 ${JSON.stringify(exitCode)})` };
  }
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    return { ok: false, reason: `"stdout" 与 "stderr" 必须是字符串` };
  }
  const rawResult = parsed.result;
  if (rawResult === undefined || rawResult === null) {
    return { ok: true, response: { exitCode, stdout, stderr } };
  }
  if (!isRecord(rawResult)) {
    return { ok: false, reason: `"result" 必须是对象或 null(收到 ${JSON.stringify(rawResult)})` };
  }
  const { kind, errorCodes } = rawResult;
  if (kind !== "tsc" && kind !== "contract") {
    return {
      ok: false,
      reason: `"result.kind" 必须是 "tsc" 或 "contract"(收到 ${JSON.stringify(kind)})`,
    };
  }
  if (!Array.isArray(errorCodes) || errorCodes.some((code) => typeof code !== "string")) {
    return { ok: false, reason: `"result.errorCodes" 必须是字符串数组` };
  }
  return {
    ok: true,
    response: { exitCode, stdout, stderr, result: { kind, errorCodes: [...errorCodes] } },
  };
};
