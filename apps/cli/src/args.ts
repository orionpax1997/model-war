/**
 * 子命令参数解析的公共一格:`--root <值>` 的摘取。
 *
 * `match` 与 `verify` 都收 `[--root <仓库根>] <位置参数>`。摘取不能写成
 * `args.filter((arg) => !arg.startsWith("-"))`:`--root` 的**值**不以 `-` 开头,于是它会被当成
 * 位置参数。`match --root <根> <input>` 那一序下 `positional[0]` 就成了根目录(一个目录被当成
 * `input.json` 去 `JSON.parse`)。用法串把位置参数写在前面只是惯例,不是解析器的免责理由——
 * 参数顺序不该决定命令能不能跑。
 */

export type SplitArgs = {
  readonly root: string | undefined;
  readonly positional: readonly string[];
};

/** 摘出 `--root <值>`(就地跳过它的值),返回剩下的位置参数。 */
export const splitArgs = (args: readonly string[]): SplitArgs => {
  const positional: string[] = [];
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      root = args[index + 1];
      // 跳过 `--root` 与它的值;缺值时下一条会被当成位置参数,与不写 `--root` 同义。
      if (root !== undefined) {
        index += 1;
      }
      continue;
    }
    if (arg !== undefined && !arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  return { root, positional };
};
