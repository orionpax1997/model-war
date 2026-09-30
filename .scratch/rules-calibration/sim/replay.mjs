// replay.mjs —— 单场重放：按对局 id 从 buildMatrices() 里取出原始 job，重跑并打印/导出事件流。
//
//   node --disable-warning=ExperimentalWarning replay.mjs 'M1/center-fortress@64/dabc/s11' [--events] [--every=1]
//   node --disable-warning=ExperimentalWarning replay.mjs --list            # 列出全部可重放 id
//   node --disable-warning=ExperimentalWarning replay.mjs --curated         # 把"取证用"的那批 id 写进 data/replays.json
//
// 为什么需要它：matches.json 里只留聚合量（体积可控），但 results.md 引用了具体实例
// （例如“经济死亡后靠残兵抢了 26 个点”）。这个脚本让任何人能用**同一份 job 描述**重放该实例，
// 逐 tick 核对，不需要相信本轮留下的聚合数字。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrices, playMatch, matchArgsOf, VARIANTS } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');

const argv = process.argv.slice(2);
const id = argv.find((a) => !a.startsWith('--'));
const wantEvents = argv.includes('--events');
const every = Number(argv.find((a) => a.startsWith('--every='))?.split('=')[1] ?? 1);
const listOnly = argv.includes('--list');
const curated = argv.includes('--curated');

// 取证用实例清单：results.md 里引用的每一类现象各留 1-2 场，便于逐 tick 核对
export const CURATED = [
  // 经济死亡后靠残兵抢点续命（5.2 全部 12 场的代表）
  'M1/center-fortress@40/dabc/s11',
  'M2/center-fortress@40/avd/ddaa/s11',
  // 时间轴四段的代表：首触早 / 首触晚
  'M1/center-fortress@64/dabc/s11',
  'M1/center-fortress@64/dabc/s97',
  // 逐字入舱自认失败 vs 镜像注入的同种子对照
  'M0/center-fortress@64/abcd/s11',
  'M1/center-fortress@64/abcd/s11',
  // 农民海探针：枯竭剖面（100% 采空）与经济未死
  'M5/center-fortress@64/farmer6-mines1/s11',
  'M5/center-fortress@64/farmer2-mines1/s11',
  // 骑兵探针：mixed 与 self-play
  'M3/center-fortress@64/selfplay/raiderraiderraiderraider/s11',
  'M3/center-fortress@64/mixed/abcraider/s11',
];

const jobs = buildMatrices({ variants: VARIANTS });
const byId = new Map(jobs.map((j) => [j.id, j]));

if (listOnly) {
  console.log(`可重放 ${jobs.length} 场，例如：`);
  for (const j of jobs.slice(0, 10)) console.log(`  ${j.id}`);
  console.log(`  …（--curated 会把 ${CURATED.length} 场取证实例写进 data/replays.json）`);
  process.exit(0);
}

if (curated) {
  const out = [];
  for (const cid of CURATED) {
    const job = byId.get(cid);
    if (!job) { console.error(`[replay] 找不到 id：${cid}`); process.exit(1); }
    const r = playMatch({ ...matchArgsOf(job), includeEvents: true, sampleEvery: every });
    out.push({ id: cid, outcome: r.outcome, timeline: r.timeline, depletion: r.depletion, players: r.players, events: r.events });
    console.log(`[replay] ${cid} → ${r.outcome.reason}/${r.outcome.winner ?? '-'}@${r.outcome.tick}（事件 ${r.events.length} 条）`);
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'replays.json'), JSON.stringify(out, null, 1));
  console.log(`[replay] 写出 data/replays.json（${out.length} 场，${(fs.statSync(path.join(DATA, 'replays.json')).size / 1024).toFixed(0)} KB）`);
  process.exit(0);
}

if (!id) {
  console.error('用法：replay.mjs <对局 id> [--events] [--every=N] | --list | --curated');
  process.exit(1);
}

const job = byId.get(id);
if (!job) {
  console.error(`[replay] 找不到 id：${id}（用 --list 看格式）`);
  process.exit(1);
}
const r = playMatch({ ...matchArgsOf(job), includeEvents: wantEvents, sampleEvery: every });
console.log(`[replay] ${id}`);
console.log(`  座位：${r.meta.seats.map((s) => `${s.seat}=${s.script}${job.mirror ? '(注入)' : '(逐字)'}`).join(' ')}`);
console.log(`  结局：${r.outcome.reason}${r.outcome.winner !== null ? ` 胜者 seat ${r.outcome.winner}` : ''} @ tick ${r.outcome.tick}，领土分 ${r.outcome.territoryScores.join('/')}`);
console.log(`  时间轴：首触 ${r.timeline.firstContact}｜首伤 ${r.timeline.firstDamageTick}｜首杀 ${r.timeline.firstKillTick}｜中路争夺 ${r.timeline.contestedSiteTick}｜三方决战 ${r.timeline.multiContestSiteTick}｜首淘汰 ${r.timeline.firstEliminationTick}｜结果已定 ${r.timeline.decisionTick ?? r.timeline.territoryLockTick ?? r.timeline.lastContestedTick}`);
console.log(`  枯竭：${JSON.stringify(r.depletion.ticks)}，结束剩余 ${r.depletion.remainingEndPct}%`);
for (const p of r.players) {
  console.log(`  seat ${p.index} ${p.script}：名次 ${p.finalRank} 分 ${p.scoreEnd} 自认 ${p.identifiedIndex} 交付 ${p.delivered} 矿 ${p.minesAtEconDeath ?? '-'} 经济死 ${p.economyDeadAt ?? '-'} 死后抢点 ${p.sitesCapturedAfterEconDeath} 撑到 ${p.survivedToTick}`);
}
if (wantEvents) {
  console.log('  事件（tick, 类型, 关键字段）：');
  for (const ev of r.events) {
    const { tick, kind, ...rest } = ev;
    const short = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null));
    console.log(`    ${String(tick).padStart(3)} ${kind} ${JSON.stringify(short)}`);
  }
}
