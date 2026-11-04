/**
 * 子命令参数解析的公共一格:摘取**带值的 flag**(`--root <值>`、`--observations <值>`、
 * `--expected-plan <值>`)与**不带值的 flag**(`--plan`)。
 *
 * `match` 与 `verify` 都收 `[--root <仓库根>] <位置参数>`。摘取不能写成
 * `args.filter((arg) => !arg.startsWith("-"))`:`--root` 的**值**不以 `-` 开头,于是它会被当成
 * 位置参数。`match --root <根> <input>` 那一序下 `positional[0]` 就成了根目录(一个目录被当成
 * `input.json` 去 `JSON.parse`)。用法串把位置参数写在前面只是惯例,不是解析器的免责理由——
 * 参数顺序不该决定命令能不能跑。
 *
 * ── 这里认得 flag,但**不决定哪个子命令收哪个** ──
 *
 * 本格只回答「一个带值的 flag 该怎么摘」,值摘出来之后**谁读它**由各子命令自己决定。
 * 于是 `--observations`(`trial/run-trial-script.ts` 用;gen 私有协议的一半)出现在
 * `match --observations x` 里也只是被摘走、不生效——与 `--root` 出现在试跑入口里同理。
 * 一个子命令要新增带值 flag 时在这里登记它(解析形状只有一家),而不是自己去扫 argv。
 *
 * ── 值必须不以 `-` 开头,否则不给 ──
 *
 * `--observations --root /x` 里,若不设这条规则,`--root` 会被当成 `--observations` 的值吃掉,
 * 真正的根反而丢成位置参数(实测:根目录被当成 `input.json` 去 `JSON.parse`,与本文件头注
 * 描述的那次事故同一形状)。缺值与「值长得像 flag」都按**不给**处理。
 */

export type SplitArgs = {
  readonly root: string | undefined;
  /** `--model` 的值(模型 slug)。只由试跑入口读:在位陪练随模型而定。 */
  readonly model: string | undefined;
  /** `--observations` 的值(观测文件落盘点)。只由试跑入口读;其余子命令摘到也不生效。 */
  readonly observationsPath: string | undefined;
  /** `--expected-plan` 的值(预期试跑计划文件)。只由试跑入口读;其余子命令摘到也不生效。 */
  readonly expectedPlanPath: string | undefined;
  /** `--plan` 出现即 true(试跑入口:只造计划并打印,不跑对局)。 */
  readonly planMode: boolean;
  readonly positional: readonly string[];
};

/** 带值的 flag 清单:登记一处,各子命令从这里认(本格之外的 argv 扫描一律不做)。 */
const VALUED_FLAGS = {
  "--root": "root",
  "--model": "model",
  "--observations": "observationsPath",
  "--expected-plan": "expectedPlanPath",
} as const satisfies Record<string, keyof SplitArgs>;

/** 不带值的 flag 清单:出现即 true(没有值要摘,也不会吃掉后面的位置参数)。 */
const SWITCH_FLAGS = {
  "--plan": "planMode",
} as const satisfies Record<string, keyof SplitArgs>;

/**
 * 摘出带值的 flag(就地跳过它们的值),返回剩下的位置参数。
 *
 * 缺值或值以 `-` 开头 → 该 flag 按不给处理(见头注「值必须不以 `-` 开头」)。
 */
export const splitArgs = (args: readonly string[]): SplitArgs => {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let planMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== undefined && Object.hasOwn(SWITCH_FLAGS, arg)) {
      planMode = true;
      continue;
    }
    const field = arg === undefined ? undefined : VALUED_FLAGS[arg as keyof typeof VALUED_FLAGS];
    if (field !== undefined) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        flags.set(field, value);
        index += 1;
      }
      continue;
    }
    if (arg !== undefined && !arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  return {
    root: flags.get("root"),
    model: flags.get("model"),
    observationsPath: flags.get("observationsPath"),
    expectedPlanPath: flags.get("expectedPlanPath"),
    planMode,
    positional,
  };
};
