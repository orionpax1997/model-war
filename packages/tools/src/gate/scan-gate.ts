/**
 * `scan` 观测的纯函数层:把「读到的事实」拼成落盘用的 meta,以及那条观测命令的 argv。
 *
 * ── 为什么 `scan` 也走「薄壳 + 纯函数」两层(而不是像别处那样一段直白脚本) ──
 * `scan`(scc)不是本仓库的门禁:它没有判据、不设红线,只把行数与复杂度观测落盘
 * (hld §2.2.7 的「按需 → 夜间」层,spec §7)。既然没有判据,能进测试的就只剩**落盘形状**,
 * 而落盘形状必须在两处成立:装了 scc 的那一晚(带版本号)、没装的那一晚(带 skipped)。
 * 把它拆成纯函数,第二条这一支就不再依赖运行环境——「缺二进制要写 skipped 而不是静默退出」
 * 这条纪律因此可测,而不是靠一句注释。
 *
 * ── scc 版本号不是锦上添花,是必需品 ──
 * scc 4.0.0 是 major,上游自陈语言识别换成 Linguist 启发式、JSON 输出新增百分比字段。带版本号,
 * 三夜之间的基线才可比;不带,自己跟自己打架时无从归因。所以 meta 里 `version` 与 `skipped`
 * 二者必居其一。
 *
 * ── `--no-config` 是口径的一部分,不是可选项 ──
 * scc 会自动发现 `./.sccconfig` 与 `SCC_CONFIG_PATH`,而配置文件**可以改变计数口径**。
 * 观测命令统一带 `--no-config`,把口径钉死,免得好心人往仓库里放一份 `.sccconfig` 悄悄改掉基线。
 *
 * 本文件不读文件系统、不读时钟、不读环境:同一份事实永远拼出同一份 meta。
 */

/** 产物的落点(相对仓库根)。三者一起看才是「原始 JSON + 文本 + 口径元数据」。 */
export const SCAN_OUTPUT_DIR = "reports/scan";
export const SCAN_JSON_PATH = "reports/scan/scc.json";
export const SCAN_TEXT_PATH = "reports/scan/scc.txt";
export const SCAN_META_PATH = "reports/scan/meta.json";

/**
 * 观测命令的固定参数(hld:95 登记的 `scc --by-file --cognitive --hotspots` 是同一条口径的手动形态;
 * `--hotspots` 要 git 历史,离线/浅克隆下会给出空报告,所以落盘这一路不挂它)。
 */
export const SCAN_ARGS = [
  "--no-config",
  "--by-file",
  "--cognitive",
  "--sort",
  "complexity",
] as const;

/** 一次出两种格式:JSON 给机器、tabular 给人;两者都落盘,不进控制台。 */
export const scanFormatMulti = (): string => `json:${SCAN_JSON_PATH},tabular:${SCAN_TEXT_PATH}`;

/** 完整 argv:固定参数 + 多格式落盘。`scc` 自身从 PATH 解析,不在这里拼。 */
export const scanArgumentList = (): readonly string[] => [
  ...SCAN_ARGS,
  "--format-multi",
  scanFormatMulti(),
];

/** 落盘的 meta。`version` 与 `skipped` 二者必居其一:要么记下「哪一版扫的」,要么记下「没扫」。 */
export type ScanMeta = {
  readonly tool: "scc";
  /** 口径钉死:永远是不读配置的那一档。 */
  readonly config: "none(--no-config)";
  readonly args: readonly string[];
  readonly gitSha: string;
  readonly scannedAt: string;
  /** 装了 scc 才有,值是 `scc --version` 的原文。 */
  readonly version?: string;
  /** 没装 scc 时的跳过标记。看到它 = 这一晚没有扫描产物,而不是「这一晚没有代码」。 */
  readonly skipped?: string;
  /** 真跑过才有:观测命令自身的成败(与任何分数/行数红线无关)。 */
  readonly outcome?: "ok" | "failed";
};

/** 拼 meta 需要的事实,全部由调用方从外部读入。 */
export type ScanFacts = {
  /** `scc --version` 的原文;`null` = 探测不到二进制。 */
  readonly sccVersion: string | null;
  readonly gitSha: string;
  readonly scannedAt: string;
  readonly args: readonly string[];
  readonly outcome?: "ok" | "failed";
};

/** 事实 → meta。缺 scc 时只记 `skipped`,不伪造成一次「空扫描」。 */
export const buildScanMeta = (facts: ScanFacts): ScanMeta => {
  const base = {
    tool: "scc",
    config: "none(--no-config)",
    args: facts.args,
    gitSha: facts.gitSha,
    scannedAt: facts.scannedAt,
  } as const;
  if (facts.sccVersion === null) {
    return { ...base, skipped: "scc-not-installed" };
  }
  return {
    ...base,
    version: facts.sccVersion,
    ...(facts.outcome === undefined ? {} : { outcome: facts.outcome }),
  };
};
