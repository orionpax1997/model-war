/**
 * 变异分数的**可解释性诊断**:把「这片分数低」拆成几种互不相同的成因,给出可执行的下一步。
 *
 * ── 它补的是哪一个洞 ────────────────────────────────────────────────────────
 *
 * 棘轮(ratchet.ts)只回答一个问题:「同一分片这一次是否比入库基线低」。它不回答
 * 「为什么低」,于是低分片只有两种命运:被人补测试拉回去,或者被人「接受」一个新基线。
 * 后者已经在本仓库发生过一次(engine-processor 基线 77.66% → 75.84%,理由是基线过期),
 * 而 ADR-0026 的重评条件第三条明写:**某个分片的基线长期靠「接受」维持而非靠补测试时,
 * 应当重新考虑它的 operator 范围,或删掉该分片**。
 *
 * 要做那个决定,先得知道分片分数里各占多少的是什么。本文件把一份 Stryker 报告拆成八桶:
 *
 * | 桶 | 含义 | 该看谁 |
 * |---|---|---|
 * | `killed` | 真杀:测试确实拓住了这个变异 | 不用看 |
 * | `timeout` | 超时:Stryker 计入「已检测」,但它证明的是「测试挂死了」 | 测试或口径 |
 * | `survived-value` | 存活,变异是值替换(字符串/数字) | 多半是等价或「断言表之间的关系而不是内容」 |
 * | `survived-structure` | 存活,变异改了数组/对象/函数的形状 | 深比较断言缺失,或变异没生效 |
 * | `survived-logic` | 存活,变异改了控制流或算式 | **真缺口,该补测试** |
 * | `uncovered` | 未覆盖,且文件不在结构归因表里 | **真缺口,该补测试** |
 * | `unobservable` | 未覆盖,但文件命中结构归因表(测不到,不是没测) | 范围或夹具 |
 * | `other` | Stryker 的其它状态(RuntimeError / CompileError / Ignored / Pending) | 逐条看 |
 *
 * ── 三条与直觉相反、但必须写进判据的纪律 ────────────────────────────────────
 *
 * **① 超时不算「测试抓得住」。** `ratchet.ts` 按 Stryker 口径把 `Timeout` 计入 detected,
 * 那是分数口径;但诊断里超时单独成桶,因为「测试挂死」与「断言抓住了变异」是两件事。
 * engine-runtime 片实测 181 超时 vs 164 真杀——那一半的「分数」是噪声。
 *
 * **② 不可测与没测是两件事。** `unobservable` 是**测量能力**的边界(文件以字符串形式载入、
 * 只能被 spawn 子进程观察),不是测试质量的结论。把它们混在一起,低分片就会被误判成
 * 「测试弱」,于是人去买不该买的测试。归因表在 `structural-attribution.ts`。
 *
 * **③ 静态变异体的「存活」存疑,单列一轴。** Stryker 的 static mutant(模块加载期执行,
 * 如 `export const X = "..."`)无法在运行期激活,只能重载环境跑全部测试;其覆盖归因不可用
 * (`coveredBy` 恒空)。若某分片的变异体绝大多数是静态的,而它们全部「存活」,先怀疑
 * **变异根本没在测试环境里生效**(ESM 模块缓存没刷新),再谈测试弱。这条要靠人工复核,
 * 判据只能把它摆到台面上。
 *
 * ── 纯函数,不碰盘 ──────────────────────────────────────────────────────────
 *
 * 读文件与写文件在 `run-mutation-diagnose.ts`;这里只收「已经读到的报告」。
 * 所以反例不必造真实报告:喂一份夹具 JSON 就能验判据会红。
 */

/** 报告里一只变异体的**原始**形状(Stryker JSON 的那几列)。 */
export type RawMutant = {
  readonly status?: string;
  readonly mutatorName?: string;
  readonly static?: boolean;
  readonly coveredBy?: readonly string[];
  readonly location?: {
    readonly start?: { readonly line?: number; readonly column?: number };
  };
};

/** 一份报告的原始形状(只取诊断要用的字段)。 */
export type DiagnosableReport = {
  readonly files?: Readonly<Record<string, { readonly mutants?: readonly RawMutant[] }>>;
  /** 这次跑变异时的范围(配置文件里的 `mutate`)。用它判断「这份报告是不是全范围跑的」。 */
  readonly config?: { readonly mutate?: readonly string[] };
};

/** 诊断用的变异体(归一化后的形状)。 */
export type DiagnosedMutant = {
  /** 仓库根相对路径。 */
  readonly file: string;
  /** Stryker 的状态字符串。 */
  readonly status: string;
  /** 变异算子名(如 `StringLiteral`)。 */
  readonly mutator: string;
  /** 是否为 Stryker 的静态变异体(模块加载期执行)。 */
  readonly static: boolean;
  /** 归因到该变异体的测试 id;静态变异体恒为空。 */
  readonly coveredBy: readonly string[];
  /** 变异位置,形如 `45:43`(行:列);没有位置时为空串。 */
  readonly location: string;
};

/** 八桶。名字即判据,不需要额外解释。 */
export const BUCKETS = [
  "killed",
  "timeout",
  "survived-value",
  "survived-structure",
  "survived-logic",
  "uncovered",
  "unobservable",
  "other",
] as const;

export type Bucket = (typeof BUCKETS)[number];

/** 值替换类算子:改的是「值」,不是形状也不是逻辑。 */
const VALUE_MUTATORS: ReadonlySet<string> = new Set([
  "BigIntLiteral",
  "BooleanLiteral",
  "NumberLiteral",
  "StringLiteral",
]);

/** 结构类算子:改的是「形状」(数组、对象、函数的体)。 */
const STRUCTURE_MUTATORS: ReadonlySet<string> = new Set([
  "ArrayDeclaration",
  "ArrowFunction",
  "ClassExpression",
  "FunctionExpression",
  "MethodExpression",
  "ObjectLiteral",
  "PropertyAssignment",
  "ShorthandPropertyAssignment",
]);

/**
 * 结构归因由调用方注入(见 `structural-attribution.ts`)。
 *
 * 注入而不是 import,是为了让纯函数层不依赖任何表——判据的输入由入口组装,
 * 反例因此可以喂一张假表。
 */
export type StructuralAttribution = {
  /** 命中即判「不可测」。 */
  readonly matches: (file: string) => boolean;
  /** 这个文件为什么测不到(命中时给理由)。 */
  readonly reasonOf: (file: string) => string | undefined;
};

/** 一个文件一行的构成。 */
export type FileDiagnosis = {
  readonly file: string;
  readonly total: number;
  readonly buckets: Readonly<Record<Bucket, number>>;
  /** 其中静态变异体数。 */
  readonly staticMutants: number;
  /** 不可测归因的理由(文件命中归因表时才有)。 */
  readonly unobservableReason: string | undefined;
};

/** 一片一节的结论。 */
export type DiagnosisFlag = {
  /** 标志名。 */
  readonly kind:
    | "static-doubt"
    | "timeout-noise"
    | "unobservable"
    | "real-gap"
    | "value-survived"
    | "scope-partial"
    | "clean";
  /** 该成因涉及多少个变异体。 */
  readonly count: number;
  /** 占有效变异体的比例(0~1)。 */
  readonly share: number;
  /** 一句话说清「为什么这是问题 / 下一步看哪里」。 */
  readonly note: string;
  /** 这一条对应的**具体动作**(下一步做什么,不是「注意什么」)。 */
  readonly action: string;
};

/** 一片一节的完整诊断。 */
export type ShardDiagnosis = {
  readonly shard: string;
  /** 报告里一共多少个变异体(含不进分母的状态)。 */
  readonly total: number;
  /** Stryker 口径的分母:detected + survived + NoCoverage。 */
  readonly valid: number;
  /** Stryker 口径的分子:Killed + Timeout。 */
  readonly detected: number;
  readonly buckets: Readonly<Record<Bucket, number>>;
  /** 原始分 = detected / valid(Stryker 口径,与基线可比)。 */
  readonly score: number;
  /** 去超时分 = killed / valid:把「挂死」从分子里拿掉。 */
  readonly scoreExcludingTimeout: number;
  /** 覆盖内分 = (killed+timeout) / (killed+timeout+survived)。 */
  readonly coverageBased: number;
  /** 可信分 = killed / (killed + 真缺口):真缺口 = 逻辑存活 + 结构存活 + 真未覆盖。 */
  readonly credibleScore: number;
  /** 静态变异体数,以及其中存活的个数。 */
  readonly staticMutants: number;
  readonly staticSurvivors: number;
  /** 各桶里的静态变异体数。与桶数对照即可知道「真缺口」里有多少是判定存疑的那部分。 */
  readonly staticByBucket: Readonly<Record<Bucket, number>>;
  /** 按「真缺口」排序的文件构成(全部文件,不在这里截断)。 */
  readonly files: readonly FileDiagnosis[];
  readonly flags: readonly DiagnosisFlag[];
  /** 一句话结论:按占比排出的标志名。 */
  readonly headline: string;
};

/** 把一只变异体归到桶里。 */
export const bucketOf = (mutant: DiagnosedMutant, attribution: StructuralAttribution): Bucket => {
  if (mutant.status === "Killed") return "killed";
  if (mutant.status === "Timeout") return "timeout";
  if (mutant.status === "Survived") {
    if (VALUE_MUTATORS.has(mutant.mutator)) return "survived-value";
    if (STRUCTURE_MUTATORS.has(mutant.mutator)) return "survived-structure";
    return "survived-logic";
  }
  if (mutant.status === "NoCoverage") {
    return attribution.matches(mutant.file) ? "unobservable" : "uncovered";
  }
  return "other";
};

const emptyBuckets = (): Record<Bucket, number> => ({
  killed: 0,
  timeout: 0,
  "survived-value": 0,
  "survived-structure": 0,
  "survived-logic": 0,
  uncovered: 0,
  unobservable: 0,
  other: 0,
});

const percent = (value: number): number => Math.round(value * 100) / 100;

/** 从报告里把变异体摊平成一条条记录。 */
export const flattenMutants = (report: DiagnosableReport): readonly DiagnosedMutant[] => {
  const out: DiagnosedMutant[] = [];
  for (const [file, info] of Object.entries(report.files ?? {})) {
    for (const mutant of info.mutants ?? []) {
      const start = mutant.location?.start;
      out.push({
        file,
        status: mutant.status ?? "",
        mutator: mutant.mutatorName ?? "",
        static: mutant.static === true,
        coveredBy: mutant.coveredBy ?? [],
        location: start?.line === undefined ? "" : `${start.line}:${start.column ?? 0}`,
      });
    }
  }
  return out;
};

/** 真缺口:逻辑存活 + 结构存活 + 真未覆盖。这三类是「该补测试」的量。 */
export const realGap = (buckets: Readonly<Record<Bucket, number>>): number =>
  buckets["survived-logic"] + buckets["survived-structure"] + buckets.uncovered;

/**
 * 诊断一片。
 *
 * @param shard 分片名(报告路径的那一份)。
 * @param report Stryker 报告。
 * @param attribution 结构归因(命中即判「不可测」)。
 * @param options.declaredScope 分片配置里声明的 mutate 范围;拿它与报告里的范围比对,
 *   认出「这份报告其实是单文件标定跑」。
 */
export const diagnoseShard = (
  shard: string,
  report: DiagnosableReport,
  attribution: StructuralAttribution,
  options: { readonly declaredScope?: readonly string[] } = {},
): ShardDiagnosis => {
  const buckets = emptyBuckets();
  const staticByBucket = emptyBuckets();
  const perFile = new Map<string, FileDiagnosis>();
  let staticMutants = 0;
  let staticSurvivors = 0;

  for (const mutant of flattenMutants(report)) {
    const bucket = bucketOf(mutant, attribution);
    buckets[bucket] += 1;
    const isStatic = mutant.static;
    if (isStatic) {
      staticMutants += 1;
      staticByBucket[bucket] += 1;
      if (bucket.startsWith("survived")) staticSurvivors += 1;
    }
    const prev = perFile.get(mutant.file);
    if (prev) {
      const merged = { ...prev.buckets, [bucket]: prev.buckets[bucket] + 1 } as Record<
        Bucket,
        number
      >;
      perFile.set(mutant.file, {
        ...prev,
        total: prev.total + 1,
        buckets: merged,
        staticMutants: prev.staticMutants + (isStatic ? 1 : 0),
      });
    } else {
      const fresh = emptyBuckets();
      fresh[bucket] = 1;
      perFile.set(mutant.file, {
        file: mutant.file,
        total: 1,
        buckets: fresh,
        staticMutants: isStatic ? 1 : 0,
        unobservableReason: attribution.reasonOf(mutant.file),
      });
    }
  }

  const survivedTotal =
    buckets["survived-value"] + buckets["survived-structure"] + buckets["survived-logic"];
  const valid =
    buckets.killed + buckets.timeout + survivedTotal + buckets.uncovered + buckets.unobservable;
  const detected = buckets.killed + buckets.timeout;
  const gap = realGap(buckets);
  const score = valid > 0 ? (detected / valid) * 100 : 0;
  const scoreExcludingTimeout = valid > 0 ? (buckets.killed / valid) * 100 : 0;
  const coverageBased =
    detected + survivedTotal > 0 ? (detected / (detected + survivedTotal)) * 100 : 0;
  const credibleScore =
    buckets.killed + gap > 0 ? (buckets.killed / (buckets.killed + gap)) * 100 : 0;

  const share = (count: number): number => (valid > 0 ? count / valid : 0);
  const staticInGap =
    staticByBucket["survived-logic"] +
    staticByBucket["survived-structure"] +
    staticByBucket.uncovered;
  const flags: DiagnosisFlag[] = [];

  // 触发条件有两条,任一即可:
  // ① 静态变异体占了分片的大头(≥50%):整片基本没有运行时变异体;
  // ② 静态变异体的存活率极高(≥80% 且数量 ≥20):而实测里,静态变异体**有时是能被杀的**
  //    (gen-core 153/247、runner 148/310 被杀),所以「几乎全存活」比「占比高」更可疑。
  if (
    staticMutants > 0 &&
    staticSurvivors > 0 &&
    (share(staticMutants) >= 0.5 || (staticMutants >= 20 && staticSurvivors / staticMutants >= 0.8))
  ) {
    const killedStatic = staticMutants - staticSurvivors;
    flags.push({
      kind: "static-doubt",
      count: staticSurvivors,
      share: share(staticMutants),
      note:
        `${staticMutants} 个变异体是 Stryker 的静态变异体(模块加载期执行,覆盖归因不可用),` +
        `其中 ${staticSurvivors} 个存活、${killedStatic} 个被杀。静态变异体只能靠` +
        `「重载环境 + 跑全部测试」判定,若测试环境没有真的重载(ESM 模块缓存),` +
        `变异根本没生效,存活是假的。schema 片已实测坐实这一点:报告里 ` +
        `script-surface.ts 的「getTick」→「空串」报 Survived,` +
        `手工按同一位置注入后 schema 测试当场红两条。`,
      action:
        "先做一次人工复核(挑一只存活的静态变异体,按报告里的位置与替换值手工注入,跑该分片的测试)," +
        "红了就说明是测量失效——这时该修的是测量口径(让静态变异真正生效,或把它们排除出分数)," +
        "**不是**补测试。",
    });
  }
  if (share(buckets.timeout) >= 0.05) {
    flags.push({
      kind: "timeout-noise",
      count: buckets.timeout,
      share: share(buckets.timeout),
      note:
        `${buckets.timeout} 个变异体以超时收场,占 ${percent(share(buckets.timeout) * 100)}%。` +
        `Stryker 把超时计入「已检测」,于是「测试挂死」会被算成分数——` +
        `去超时分比原始分低 ${percent(score - scoreExcludingTimeout)} 个百分点就是这部分。`,
      action:
        "逐个文件看超时集中在哪(报告的文件构成表里「超时」列大的那几个)。" +
        "常见形态是「变异的代码把 guest 挂死」——那测的是 VM 会不会挂,不是测试好不好;" +
        "处置要么修夹具(让挂死变成断言失败),要么把这类文件移出变异范围。",
    });
  }
  if (share(buckets.unobservable) >= 0.1) {
    flags.push({
      kind: "unobservable",
      count: buckets.unobservable,
      share: share(buckets.unobservable),
      note:
        `${buckets.unobservable} 个变异体落在结构归因表里(测不到,不是没测),` +
        `占 ${percent(share(buckets.unobservable) * 100)}%。这部分不是测试质量结论;` +
        `要么把它们移出变异范围,要么换一种夹具让它们可测。`,
      action:
        "把归因表里命中的文件从该分片的 mutate 范围排除(像 `tools.mjs` 排除 `run-*-gate.ts` 那样)," +
        "并显式抬一次基线;不要用补测试去补这一段——那是测不到,不是没测。",
    });
  }
  if (share(buckets["survived-value"]) >= 0.2) {
    flags.push({
      kind: "value-survived",
      count: buckets["survived-value"],
      share: share(buckets["survived-value"]),
      note:
        `${buckets["survived-value"]} 个值替换类变异体存活,占 ` +
        `${percent(share(buckets["survived-value"]) * 100)}%。值替换存活有两种成因:` +
        `等价变异体(改了但行为不变),或断言只钉「表之间的关系」不钉「表的内容」。` +
        `逐条判需要人,但这一栏的量级本身决定了该分片的分数能不能当质量读。`,
      action:
        "对值替换类变异体,先人工复核几只:把报告里的替换值按位置注进去,跑该分片的测试。" +
        "红了 → 断言只钉「表之间的关系」,补内容级断言;仍绿 → 多半是等价变异体,考虑按算子过滤。",
    });
  }
  if (share(gap) >= 0.1) {
    flags.push({
      kind: "real-gap",
      count: gap,
      share: share(gap),
      note:
        `${gap} 个真缺口(逻辑存活 ${buckets["survived-logic"]} + 结构存活 ` +
        `${buckets["survived-structure"]} + 真未覆盖 ${buckets.uncovered}),占 ` +
        `${percent(share(gap) * 100)}%。这部分是补测试的靶子。` +
        `其中 ${staticInGap} 个是静态变异体,判定存疑(见上一条),` +
        `真正可据以补测试的是 ${gap - staticInGap} 个。`,
      action:
        "按文件构成表里「存活·逻辑」「存活·结构」「未覆盖·真」三列最高的文件逐个补断言;" +
        "补完跑一次该分片,分数会真的涨(这与「刷分」相反:它把行为钉住,不是把数字做高)。",
    });
  }
  // 「这份报告是不是全范围跑的」:Stryker 把这次实际用的 `mutate` 写进报告,
  // 而分片配置(`stryker/<片名>.mjs`)里声明的范围是另一份。
  // 两者对不上(声明的范围带通配、这份报告却只标定了字面路径)时,这份报告是
  // 分片改造前的单文件标定跑,不是全范围跑——`stryker/baseline/README.md` 记的正是这件事。
  const reportScope = report.config?.mutate ?? [];
  const declaredScope = options.declaredScope ?? [];
  const hasGlob = (patterns: readonly string[]): boolean =>
    patterns.some((pattern) => /[*?]/.test(pattern));
  if (
    reportScope.length > 0 &&
    declaredScope.length > 0 &&
    hasGlob(declaredScope) &&
    !hasGlob(reportScope)
  ) {
    flags.push({
      kind: "scope-partial",
      count: reportScope.length,
      share: 1,
      note:
        `这份报告只标定了 ${reportScope.length} 个字面目标(${reportScope.join("、")}),` +
        `而该分片声明的范围是通配形式(${declaredScope.filter((p) => !p.startsWith("!")).join("、")})` +
        `——它是单文件标定跑,不是全范围跑,分数不能当整片读。`,
      action:
        "跑一次该分片的全范围变异(`pnpm run mutate:<分片>`),再谈播种与棘轮;" +
        "在这之前,这个数字既不能当质量读,也不能当基线。",
    });
  }
  if (flags.length === 0) {
    flags.push({
      kind: "clean",
      count: 0,
      share: 0,
      note: "没有触到任何一条结构性成因:分数低就是测试真的弱,直接补测试。",
      action: "按文件构成表逐文件补断言即可。",
    });
  }

  const files = [...perFile.values()].sort((a, b) => {
    const weightA = realGap(a.buckets) + a.buckets.timeout + a.buckets.unobservable;
    const weightB = realGap(b.buckets) + b.buckets.timeout + b.buckets.unobservable;
    if (weightA !== weightB) return weightB - weightA;
    return b.total - a.total;
  });

  const headline = flags
    .slice()
    .sort((a, b) => b.share - a.share)
    .map((f) => f.kind)
    .join(" / ");

  return {
    shard,
    total: Object.values(buckets).reduce((a, b) => a + b, 0),
    valid,
    detected,
    buckets,
    score: percent(score),
    scoreExcludingTimeout: percent(scoreExcludingTimeout),
    coverageBased: percent(coverageBased),
    credibleScore: percent(credibleScore),
    staticMutants,
    staticSurvivors,
    staticByBucket,
    files,
    flags,
    headline,
  };
};

/** 报告里出现的、但不在 Stryker 已知状态集合里的状态名。 */
export const unknownStatuses = (report: DiagnosableReport): readonly string[] => {
  const known = new Set(["Killed", "Timeout", "Survived", "NoCoverage"]);
  const seen = new Set<string>();
  for (const mutant of flattenMutants(report)) {
    if (!known.has(mutant.status)) seen.add(mutant.status);
  }
  return [...seen].sort();
};
