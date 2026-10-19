import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ARCHIVE_SELECTION_JSON_SCHEMA,
  SELECTION_VERSION,
  SELECTION_SEEDS,
  SELECTION_MATCHES_PER_CANDIDATE,
  type ArchiveSelection,
  type JsonValue,
  type SelectionPlan,
  type SelectionCandidate,
  type SelectionCandidateIdentity,
  type SelectionMatch,
  type SelectionMatchResult,
} from "@model-war/schema";
import { rotateSeats } from "./enumerate.js";
import { perMatchScores, rankSeason } from "./ranker.js";

/** 对象键排序、数组保序；不依赖 metadata 的书写键序。 */
const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const hashOf = (value: JsonValue): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const same = (a: JsonValue, b: JsonValue): boolean => canonicalJson(a) === canonicalJson(b);

export type BuildSelectionPlanInput = Pick<
  SelectionPlan,
  "ruleset" | "rulesetSha256" | "sandboxRuntimeHash" | "map" | "mapSha256" | "baselines"
>;

/** 一个候选对三基准；每 seed 四次整组左移，不需要也不接受 archive ref。 */
export const buildSelectionPlan = (input: BuildSelectionPlanInput): SelectionPlan => {
  const ids = input.baselines.map((baseline) => baseline.id);
  if (new Set(["candidate", ...ids]).size !== 4)
    throw new Error("选拔基准 id 必须互异且不能为 candidate");
  const base = [
    "candidate",
    input.baselines[0].id,
    input.baselines[1].id,
    input.baselines[2].id,
  ] as const;
  const matches = SELECTION_SEEDS.flatMap((seed, seedIndex) =>
    [0, 1, 2, 3].map((rotation): SelectionMatch => {
      const seats = rotateSeats(base, rotation);
      return {
        matchIndex: seedIndex * 4 + rotation,
        seed,
        rotation,
        candidateSeat: seats.indexOf("candidate"),
        seats,
      };
    }),
  );
  const body = {
    version: SELECTION_VERSION,
    seeds: SELECTION_SEEDS,
    matchesPerCandidate: SELECTION_MATCHES_PER_CANDIDATE,
    ruleset: input.ruleset,
    rulesetSha256: input.rulesetSha256,
    sandboxRuntimeHash: input.sandboxRuntimeHash,
    map: input.map,
    mapSha256: input.mapSha256,
    baselines: [input.baselines[0], input.baselines[1], input.baselines[2]] as const,
    matches,
  };
  return { ...body, planSha256: hashOf(body) };
};

const checkPlan = (plan: SelectionPlan): void => {
  if (!same(plan, buildSelectionPlan(plan))) throw new Error("选拔计划或 plan hash 不一致");
};

/** 同 JS、同计划共享输入身份；TS、阶段和协议轮不影响执行条件。 */
export const selectionInputSha256 = (
  plan: SelectionPlan,
  scriptSha256: string,
  match: SelectionMatch,
): string => hashOf({ planSha256: plan.planSha256, scriptSha256, match });

export type SelectionResultEvidence = Omit<SelectionMatchResult, "candidatePoints">;

const scoreCandidate = (
  plan: SelectionPlan,
  identity: SelectionCandidateIdentity,
  evidence: readonly SelectionResultEvidence[],
): SelectionCandidate => {
  if (evidence.length !== SELECTION_MATCHES_PER_CANDIDATE)
    throw new Error("选拔必须有完整十二场终局，不能缩小分母");
  const sorted = [...evidence].sort((a, b) => a.matchIndex - b.matchIndex);
  const ranked = sorted.map((reading, index) => {
    const match = plan.matches[index]!;
    if (
      reading.matchIndex !== match.matchIndex ||
      reading.inputSha256 !== selectionInputSha256(plan, identity.scriptSha256, match)
    )
      throw new Error("选拔结果场次或 candidate/input hash 不一致");
    const rankings = reading.result.rankings;
    const ranks = [...rankings].sort((a, b) => a - b);
    if (
      ranks.length !== 4 ||
      ranks.some((rank, seat) => rank !== (ranks[seat - 1] === rank ? ranks[seat - 1] : seat + 1))
    )
      throw new Error("选拔终局名次不符合四座竞争排名");
    return {
      matchId: String(match.matchIndex),
      standings: match.seats.map((player, seat) => ({ player, rank: rankings[seat]! })),
    };
  });
  const matches = sorted.map((reading, index): SelectionMatchResult => ({
    ...reading,
    candidatePoints: perMatchScores(ranked[index]!.matchId, ranked[index]!.standings)[
      plan.matches[index]!.candidateSeat
    ]!,
  }));
  const score = rankSeason(ranked, { players: ["candidate"] }).find(
    (entry) => entry.player === "candidate",
  )!;
  return {
    ...identity,
    matches,
    totalPoints: score.totalPoints,
    averagePoints: score.averagePoints,
    countedMatches: SELECTION_MATCHES_PER_CANDIDATE,
  };
};

/** 对称计分后按阶段、协议轮、JS hash 定序；新选拔优先较晚阶段，旧档按其理由复算。 */
const compareCandidates = (
  a: SelectionCandidate,
  b: SelectionCandidate,
  stageReason: "later-stage" | "earlier-stage",
): number =>
  b.averagePoints - a.averagePoints ||
  (stageReason === "later-stage" ? b.stage - a.stage : a.stage - b.stage) ||
  a.protocolRound - b.protocolRound ||
  (a.scriptSha256 < b.scriptSha256 ? -1 : a.scriptSha256 > b.scriptSha256 ? 1 : 0);
const identityOf = (candidate: SelectionCandidateIdentity): SelectionCandidateIdentity => ({
  stage: candidate.stage,
  protocolRound: candidate.protocolRound,
  scriptSha256: candidate.scriptSha256,
  sourceSha256: candidate.sourceSha256,
});
const decisionOf = (
  candidates: readonly SelectionCandidate[],
  stageReason: "later-stage" | "earlier-stage" = "later-stage",
): Pick<ArchiveSelection, "selected" | "reason"> => {
  const [winner, second] = [...candidates].sort((a, b) => compareCandidates(a, b, stageReason));
  if (winner === undefined || second === undefined) throw new Error("选拔缺少三个有效候选");
  return {
    selected: identityOf(winner),
    reason:
      winner.averagePoints !== second.averagePoints
        ? "highest-average-points"
        : winner.stage !== second.stage
          ? stageReason
          : winner.protocolRound !== second.protocolRound
            ? "earlier-protocol-round"
            : "script-hash",
  };
};

const selectionSchema = z.fromJSONSchema(
  JSON.parse(JSON.stringify(ARCHIVE_SELECTION_JSON_SCHEMA)) as z.core.JSONSchema.JSONSchema,
);

/** 完整复算证据与决胜；earlier-stage 仅用于按原算法兼容读取历史档。 */
export const validateSelection = (value: unknown): ArchiveSelection => {
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success) throw new Error("选拔记录形状不合法或缺少完整十二场终局");
  const selection = parsed.data as ArchiveSelection;
  checkPlan(selection.plan);
  for (const [index, candidate] of selection.candidates.entries()) {
    if (
      candidate.stage !== index ||
      candidate.protocolRound <= (selection.candidates[index - 1]?.protocolRound ?? 0)
    )
      throw new Error("选拔候选阶段或协议轮不一致");
    const recomputed = scoreCandidate(selection.plan, identityOf(candidate), candidate.matches);
    if (!same({ ...candidate, reusedFromStage: null }, { ...recomputed, reusedFromStage: null }))
      throw new Error("选拔候选计分或结果顺序不一致");
    if (candidate.reusedFromStage !== undefined) {
      const source = selection.candidates[candidate.reusedFromStage];
      if (
        source === undefined ||
        source.stage >= candidate.stage ||
        source.scriptSha256 !== candidate.scriptSha256 ||
        !same(source.matches, candidate.matches)
      )
        throw new Error("选拔重复 JS 的复用证据不一致");
    }
    const duplicate = selection.candidates
      .slice(0, index)
      .find((prior) => prior.scriptSha256 === candidate.scriptSha256);
    if (duplicate !== undefined && !same(duplicate.matches, candidate.matches))
      throw new Error("同 JS、同计划的选拔结果不一致");
  }
  const decision = decisionOf(
    selection.candidates,
    selection.reason === "earlier-stage" ? "earlier-stage" : "later-stage",
  );
  if (!same(decision.selected, selection.selected) || decision.reason !== selection.reason)
    throw new Error("选拔胜者身份或选择理由不一致");
  return selection;
};

export type SelectionCandidateEvidence = SelectionCandidateIdentity & {
  readonly matches: readonly SelectionResultEvidence[];
  readonly reusedFromStage?: 0 | 1 | 2;
};

/** probe 只交完整终局证据；统一计算而不是让 probe 决定分数或胜者。 */
export const buildArchiveSelection = (
  plan: SelectionPlan,
  evidence: readonly SelectionCandidateEvidence[],
): ArchiveSelection => {
  checkPlan(plan);
  const candidates = [...evidence]
    .sort((a, b) => a.stage - b.stage)
    .map((candidate) => ({
      ...scoreCandidate(plan, identityOf(candidate), candidate.matches),
      ...(candidate.reusedFromStage === undefined
        ? {}
        : { reusedFromStage: candidate.reusedFromStage }),
    }));
  return validateSelection({
    version: SELECTION_VERSION,
    plan,
    candidates,
    ...decisionOf(candidates),
  });
};
