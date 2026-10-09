// THROWAWAY probe for 01-seat-reduce-probe.md. No tests, no reuse, no imports beyond node stdlib.
// Usage: node .scratch/seat-rotation/prototype/seat-reduce.mjs runs/<runId>/report.json
// Reads report.json matches[] (seats[4]/rankings[4]/perMatchScores[4]); excluded matches
// (matchIssues[].excludedFromRanking === true) are dropped from numerator AND denominator.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: seat-reduce.mjs <report.json>");
  process.exit(1);
}
const root = process.cwd();
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const excluded = new Set(
  (report.matchIssues ?? []).filter((i) => i.excludedFromRanking).map((i) => i.matchId),
);
const counted = report.matches.filter((m) => !excluded.has(m.matchId));

// Wilson score interval, 95% (z = 1.96).
const wilson = (wins, n, z = 1.96) => {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [(c - m) / d, (c + m) / d];
};

const seats = [0, 1, 2, 3].map((seat) => {
  let wins = 0;
  let scoreSum = 0;
  for (const m of counted) {
    // Win = rankings[seat] === 1. Ties share rank 1: every rank-1 seat counts a win (stated assumption).
    if (m.rankings[seat] === 1) wins++;
    scoreSum += m.perMatchScores[seat];
  }
  const n = counted.length;
  const [lo, hi] = wilson(wins, n);
  return { seat, n, wins, rate: n === 0 ? 0 : wins / n, lo, hi, mean: n === 0 ? 0 : scoreSum / n };
});

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`report: ${reportPath}`);
console.log(`counted matches: ${counted.length} (excluded: ${excluded.size})`);
console.log("seat | n | wins | winRate | Wilson95% | meanScore");
for (const s of seats) {
  console.log(
    `${s.seat} | ${s.n} | ${s.wins} | ${pct(s.rate)} | [${pct(s.lo)}, ${pct(s.hi)}] | ${s.mean.toFixed(2)}`,
  );
}

const rates = seats.map((s) => s.rate);
const spread = Math.max(...rates) - Math.min(...rates);
const tier = spread < 0.1 ? "绿(<10%)" : spread <= 0.15 ? "灰(10-15%)" : "红(>15%)";
console.log(`max spread: ${pct(spread)} -> ${tier}`);
const thinSample = seats.filter((s) => s.lo < 0.2).map((s) => s.seat);
console.log(
  `topup advice: ${tier.startsWith("灰") || thinSample.length > 0 ? "补矩阵" : "不补"} ` +
    `(tier=${tier}, Wilson下限<20%的座位=[${thinSample.join(",") || "无"}])`,
);

// ── Second independent path: cross-check 4 matches via replay.jsonl ──
// meta line players[].seat + final line result.rankings must equal the report entry.
const pick = [
  counted[0]?.matchId,
  counted[Math.floor(counted.length / 3)]?.matchId,
  counted[Math.floor((2 * counted.length) / 3)]?.matchId,
  counted.find((m) => m.matchId === "c3-corridor-split-s2")?.matchId,
].filter(Boolean);
const reportDir = reportPath.includes("/")
  ? reportPath.slice(0, reportPath.lastIndexOf("/"))
  : ".";
let checked = 0;
for (const matchId of new Set(pick)) {
  const entry = counted.find((m) => m.matchId === matchId);
  const lines = readFileSync(join(reportDir, "matches", matchId, "replay.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.type === "meta");
  const last = lines[lines.length - 1];
  const result = last?.type === "result" ? last : lines.filter((l) => l.type === "result").at(-1);
  const bySeat = [...meta.players].sort((a, b) => a.seat - b.seat);
  const seatOk =
    bySeat.length === 4 && bySeat.every((p, i) => p.seat === i && p.archiveRef === entry.seats[i]);
  const rankOk =
    result &&
    result.rankings.length === 4 &&
    result.rankings.every((r, i) => r === entry.rankings[i]);
  if (!seatOk || !rankOk) {
    console.error(`CROSSCHECK FAIL ${matchId}: seatOk=${seatOk} rankOk=${rankOk}`);
    process.exit(1);
  }
  checked++;
}
console.log(`crosscheck: ${checked}/4 replay.jsonl entries agree with report.json`);
