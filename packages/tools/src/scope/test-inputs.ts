/**
 * 观测 map 的聚合、落盘与比对(ADR-0038 第三条)。
 *
 * 输入是 `recorder.ts` 写的 JSONL(一条 = 某次 `open` / `spawn`),输出是**按测试文件归并**
 * 的 map:
 *
 * ```json
 * { "version": 1, "files": { "packages/engine/src/sandbox.test.ts": ["rulesets/basic.json", …] } }
 * ```
 *
 * 为什么按文件归并、不按用例:选中的单位是文件(vitest 的并行单位也是文件)。用例级的粒度
 * 记了但没用上,留着是因为事后想拆就拆不出来了。
 *
 * 为什么要入库:判据随仓库走。与 ADR-0027 让变异基线随仓库走是同一条理由——CI 产物 14 天
 * 就过期,而"哪段代码读哪个文件"是一年都不会变的事实。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const INPUTS_MAP_PATH = "test-inputs/inputs.json";

export interface InputsMap {
  readonly version: 1;
  readonly files: Record<string, readonly string[]>;
}

/**
 * 这些前缀下的路径是**产物**,不是输入:测试写它们、报告落它们。记进来会让 map 把"我刚写的
 * 报告"当成"我依赖的输入",于是改一个报告路径就触发一批无关用例。
 */
const OUTPUT_PREFIXES: readonly string[] = [
  "reports/",
  "runs/",
  ".vitest/",
  ".stryker-tmp/",
  ".scratch/",
  ".workspaces/",
  "node_modules/",
  ".git/",
];

export const isInputPath = (path: string): boolean =>
  path !== "" && !OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix));

interface Line {
  /** `<测试文件>::<用例名>`,setup 文件贴的标签。 */
  readonly t: string;
  readonly k: "open" | "spawn";
  readonly p: string;
}

const parseLines = (jsonl: string): readonly Line[] =>
  jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Line];
      } catch {
        // 进程被杀时最后一行可能不完整。丢一条记录比让整次比对失败便宜。
        return [];
      }
    });

/**
 * 把 JSONL 聚合成入库的形状。键是**仓库相对**的测试文件路径,值是它读到的仓库内路径(排序去重)。
 *
 * 归一化这一步不能省:标签来自 `expect.getState().testPath`,它是**绝对路径**。直接把绝对路径
 * 写进 map,键就与 `git diff` 给的相对路径对不上——选择器永远匹配不到,而且匹配不到是静默的
 * (只是少跑)。同一台机器上它还带着 home 目录,换个 clone 位置 map 就全废。
 */
export const aggregate = (jsonl: string, repoRoot: string): InputsMap => {
  const prefix = `${repoRoot.replace(/\/+$/, "")}/`;
  const relative = (path: string): string =>
    path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const byFile = new Map<string, Set<string>>();
  for (const line of parseLines(jsonl)) {
    const file = relative(line.t.split("::")[0] ?? "");
    if (file === "" || !isInputPath(line.p)) continue;
    const set = byFile.get(file) ?? new Set<string>();
    set.add(line.p);
    byFile.set(file, set);
  }
  const files: Record<string, readonly string[]> = {};
  for (const file of [...byFile.keys()].sort()) {
    files[file] = [...(byFile.get(file) ?? [])].sort();
  }
  return { version: 1, files };
};

export const loadInputsMap = (repoRoot: string): InputsMap => {
  const path = join(repoRoot, INPUTS_MAP_PATH);
  if (!existsSync(path)) return { version: 1, files: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InputsMap>;
  return { version: 1, files: parsed.files ?? {} };
};

export const writeInputsMap = (repoRoot: string, map: InputsMap): void => {
  const path = join(repoRoot, INPUTS_MAP_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const files: Record<string, readonly string[]> = {};
  for (const file of Object.keys(map.files).sort()) files[file] = map.files[file] ?? [];
  writeFileSync(path, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
};

export interface Drift {
  /** 新出现的测试文件 → 它们读到的输入。 */
  readonly addedFiles: readonly string[];
  /** 不再出现的测试文件。 */
  readonly removedFiles: readonly string[];
  /** 已有文件新增/移除了哪些输入。 */
  readonly changedFiles: readonly {
    readonly file: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }[];
}

export const diffInputs = (before: InputsMap, after: InputsMap): Drift => {
  const addedFiles: string[] = [];
  const removedFiles: string[] = [];
  const changedFiles: { file: string; added: string[]; removed: string[] }[] = [];
  for (const file of Object.keys(after.files)) {
    if (before.files[file] === undefined) addedFiles.push(file);
  }
  for (const file of Object.keys(before.files)) {
    if (after.files[file] === undefined) {
      removedFiles.push(file);
      continue;
    }
    const beforeSet = new Set(before.files[file] ?? []);
    const afterSet = new Set(after.files[file] ?? []);
    const added = [...afterSet].filter((path) => !beforeSet.has(path));
    const removed = [...beforeSet].filter((path) => !afterSet.has(path));
    if (added.length > 0 || removed.length > 0) changedFiles.push({ file, added, removed });
  }
  return { addedFiles, removedFiles, changedFiles };
};

export const isClean = (drift: Drift): boolean =>
  drift.addedFiles.length === 0 &&
  drift.removedFiles.length === 0 &&
  drift.changedFiles.length === 0;

/** 反向索引:某个路径被哪些测试文件读到。选择器用它把"改了这个文件"翻成"要跑哪些文件"。 */
export const invert = (map: InputsMap): ReadonlyMap<string, ReadonlySet<string>> => {
  const index = new Map<string, Set<string>>();
  for (const [file, inputs] of Object.entries(map.files)) {
    for (const input of inputs) {
      const set = index.get(input) ?? new Set<string>();
      set.add(file);
      index.set(input, set);
    }
  }
  return index;
};
