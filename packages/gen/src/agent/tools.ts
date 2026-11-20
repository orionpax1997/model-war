/**
 * 会话的**工具面**:五个工具的声明(名字 + 描述 + JSON Schema 参数),以及传输层交回的一次调用。
 *
 * ── 它是「模型看得见的世界」的一半 ──
 *
 * 请求里的 `tools` 是模型认知面的**结构**:`check` / `probe` / `evaluate` / `finish` 存在、要不要
 * 参数、`evaluate` 只有三次——这些在 API 层就写得下,比 `prompts/agent.md` 里一段散文可靠。
 * 所以描述文案不是注释,是协议的一部分:改它等于改 harness(进 `harnessDigest`,票 06)。
 * 与之配对的那一半在 `prompts/agent.md`(票 04),两者由 `check:prompt-tools` 对住。
 *
 * ── 为什么不带 `parallel_tool_calls` / `tool_choice: "required"` ──
 *
 * 两个都是 OpenAI 专有键,别的渠道收到不确定的键可能直接 400(ADR-0032 修订)。「一步恰好一次
 * 调用」由**动作层的判据**兜住(票 02 的 `multiple-tool-calls` 拒绝档),不靠请求体里的开关。
 * `tool_choice: "auto"` 本身写在 `chat-completions` 族的 `buildBody` 里(传输决定,不是声明内容)。
 *
 * ── 为什么 `argumentsJson` 是字符串,不是对象 ──
 *
 * 渠道给的就是一串 JSON 文本,我们不解析:解析失败是**模型可自我修正的格式失败**
 * (`malformed-arguments`,归动作层判、计一步、回纠正消息),放进传输层就变成了端点错误。
 * 另一头同样重要:发回历史时 `tool_calls[0].function.arguments` 就是这串字节,于是
 * 「发回去的 == 落盘的」(ADR-0031)在工具调用轮次里重新成立。
 *
 * ── 改常量写法就同步改门禁取法 ──
 *
 * `check:prompt-tools`(票 04)是**零构建**门禁:它不能 import `@model-war/gen`,只能读本文件的
 * **源码文本**并按 `name: "xxx"` 取名字(`packages/tools/src/prompt-commands.ts` 与
 * `rootfs-drift.ts` 同一套 fail-closed 取法)。所以这里必须是**字面量数组**:别改成函数生成、
 * 别跨文件拼装、别用 `satisfies`,否则那条门禁读不到五个名字。
 */

/**
 * 一条工具声明。
 *
 * `description` 是**给模型看的**,不是给维护者看的;`parameters` 是一份 JSON Schema 对象,
 * 原样进请求体的 `tools[].function.parameters`(chat 族)。不收参数的四个工具声明成空的
 * `properties` + `additionalProperties: false`——这比「省略 parameters」更明确:省略让模型
 * 猜「是不是可以带参数」。
 */
export type ToolDeclaration = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
};

/**
 * 一次工具调用(渠道形状归一后)。
 *
 * **没有 id**:渠道给的 id 是每次不同的无意义字节,进历史就等于进了档案与 digest 的路径;
 * 而 id 的唯一用途是让 assistant 与 `tool` 消息在**自己的历史里**配对,那一对 id 由历史构造处
 * 确定性派生(`call-<步号>`,见 `history.ts`)。所以这里只留「调了哪个工具、参数原文」。
 */
export type ToolCall = {
  readonly name: string;
  readonly argumentsJson: string;
};

/**
 * 自家历史里配对用的 id:确定性派生,一个会话内步号唯一。
 *
 * ── 为什么不用渠道给的 id ──
 *
 * 渠道 id 是每次不同的无意义字节(`call_1b5d910870c9444ca6fea2d4` / `chatcmpl-tool-97e8…`),
 * 进历史就进了档案与 digest 的路径:同一份会话重跑一次,`steps[i]` 的字节就不再相等。而 id 的
 * **唯一用途**是让 assistant 的 `tool_calls[i].id` 与 `tool` 消息的 `tool_call_id` 在自己的
 * 历史里配对——两处都由我们写,所以确定性的 `call-<步号>` 足够,且比渠道 id 更强:重跑可比。
 *
 * 真请求探针已验证:自己编的 `call-1` 被渠道接受(200),不配对的 id 与缺少 `id` 分别会
 * 静默接受与 400 `messages.2.tool_calls.0.id expected string`。
 */
export const toolCallIdOf = (step: number): string => `call-${String(step)}`;

/**
 * 同一轮里第 `index` 条调用的 id。
 *
 * 首条就是基准 id(它对应我们真正会执行的那一次),其余加上序号后缀——渠道不校验配对关系,
 * 但**要求每条都有 `id`**,而两条调用共用一个 id 会让工具消息的归属变得不可读。
 * `call-<step>` / `call-<step>-1` 这个形状已被真请求验证接受。
 */
export const toolCallIdAt = (base: string, index: number): string =>
  index === 0 ? base : `${base}-${String(index)}`;

/** 不收参数的那四个工具的参数 Schema:同一份,不手抄四遍。 */
const NO_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/**
 * 五个工具,顺序固定(`bash` → `check` → `probe` → `evaluate` → `finish`)。
 *
 * `probe` 排在 `check` 之后是有意的:它是「检查」的**运行期那一半**(`check` 是 tsc + 静态校验,
 * 看不到预算占用),两者相邻,模型按顺序读下来就是「先静态、再探预算、最后评测」。
 */
export const AGENT_TOOLS = [
  {
    name: "bash",
    description:
      "在沙箱里执行一条命令串。这是这一步的全部动作:整串交给一次 bash 执行,多行、`&&`、" +
      "`for … do … done`、heredoc 都按 bash 的规则走。工作目录是 /workspace(唯一可写),/contract 只读。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "一条 bash 命令串,可以含换行。多行命令请写成一条命令串,不要拆成多次调用。",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "check",
    description:
      "检查当前 /workspace/script.ts 能否过类型检查与静态校验,回编译错误与契约错误码。" +
      "不收参数,计一步。它看不到运行期的预算占用——那要 probe。",
    parameters: NO_PARAMETERS,
  },
  {
    name: "probe",
    description:
      "拿当前 /workspace/script.ts 跑完整评测计划的**前 8 场**(1 个组合 × 4 个座位 × 2 张地图)," +
      "回每一条预算轨的最坏占用读数(单 tick 控制流事件、单 tick API 调用、内存),而不是只回过或不过。" +
      "**这不等于整张 32 场网格通过**:另 24 场仍可能越线,evaluate 会照旧拦下。" +
      "不收参数,计一步,不占 evaluate 的三次额度。",
    parameters: NO_PARAMETERS,
  },
  {
    name: "evaluate",
    description:
      "把当前 /workspace/script.ts 送去跑一次完整评测(32 场),回聚合对差表、逐场一行与最差几场的展开。" +
      "不收参数,计一步,而且每个会话总共只有三次——这是你唯一能看见自己排第几的机会。",
    parameters: NO_PARAMETERS,
  },
  {
    name: "finish",
    description:
      "收工。调用它之后不会有下一轮:会话在这一步结束,成绩取你最后一次 evaluate 评的那一版。" +
      "不收参数,计一步。想收工就只发这一个调用,不要再夹一条 bash。",
    parameters: NO_PARAMETERS,
  },
] as const;

/**
 * 五个名字,**从 `AGENT_TOOLS` 派生**。
 *
 * 不手写第二份:声明的顺序与名字是真源,派生一次就够(两份会分叉的事实本仓一律不许留)。
 * 门禁那一侧按源码文本取名字,理由见头注「改常量写法就同步改门禁取法」。
 */
export type ToolName = (typeof AGENT_TOOLS)[number]["name"];

export const TOOL_NAMES: readonly ToolName[] = AGENT_TOOLS.map((tool) => tool.name);

/**
 * **宿主服务**那几个工具的名字:`bash` 之外的全部。
 *
 * 分界线只有一条:`bash` 由 loop 交给沙箱执行(「一步一次 `bash -c`」那条铁律的落点),
 * 其余四个由宿主分派。所以这一份是**派生值**,不手写第二份——手写的那一份会与声明分叉,而
 * 分叉的形状是「声明里加了工具、宿主不认」或反过来,两种都不报错。
 *
 * 两处读它:dispatcher 的白名单(`host/dispatcher.ts`)与身份清单的 `services.tools`
 * (`identity.ts`)。
 */
export const HOST_SERVICE_TOOLS: readonly ToolName[] = TOOL_NAMES.filter((name) => name !== "bash");

/**
 * 这个工具收不收 `arguments`。
 *
 * 只有 `bash` 收(`{command}`);另外四个做什么由「当前的 `/workspace/script.ts`」唯一决定,
 * 命令行没有可填的东西。带了参数的那一次是一条**被拒的请求**:不执行、不耗配额
 * (判据在 action 层,与 `host/dispatcher.ts` 的 `argumentRefusal` 同源)。
 */
export const acceptsArgumentsOf = (name: ToolName): boolean => name === "bash";
