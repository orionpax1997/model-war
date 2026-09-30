#!/usr/bin/env python3
"""Throwaway, standard-library-only calibration workbench for rules-calibration issue 02.

This is an arithmetic screening tool, not an engine or a balance oracle. Assumptions
and the deliberately small integer search grid are documented in README.md.
"""
from __future__ import annotations

import argparse
import itertools
import math
from functools import lru_cache
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class Unit:
    name: str
    cost: int
    hp: int
    damage: int
    speed: int = 1
    attack_range: int = 1


@dataclass
class Side:
    unit: Unit
    hp: list[int]


def lcm(a: int, b: int) -> int:
    return a * b // math.gcd(a, b)


def army(unit: Unit, budget: int) -> Side:
    assert budget % unit.cost == 0
    return Side(unit, [unit.hp] * (budget // unit.cost))


def alive(hp: list[int]) -> bool:
    return any(value > 0 for value in hp)


def fire(shooters: Side, targets: Side) -> list[int]:
    """One deterministic focus-fire volley; damage lands simultaneously."""
    hits = [0] * len(targets.hp)
    live_targets = [i for i, hp in enumerate(targets.hp) if hp > 0]
    if not live_targets:
        return hits
    target = min(live_targets, key=lambda i: (targets.hp[i], i))
    shots = sum(hp > 0 for hp in shooters.hp)
    hits[target] = shots * shooters.unit.damage
    return hits


def apply(targets: Side, hits: list[int]) -> None:
    targets.hp[:] = [max(0, hp - damage) for hp, damage in zip(targets.hp, hits)]


@lru_cache(maxsize=None)
def fight(
    left: Unit,
    right: Unit,
    *,
    budget: int,
    right_opening_volley_ticks: int = 0,
    left_opening_volley_ticks: int = 0,
) -> tuple[str | None, float, int]:
    """Equal-spend, integer-unit, focus-fire fight after any right-side opening volleys.

    Returns (winner name or draw, winner's remaining fraction of initial HP, combat ticks).
    """
    a, b = army(left, budget), army(right, budget)
    initial_hp_a = sum(a.hp)
    initial_hp_b = sum(b.hp)
    for _ in range(right_opening_volley_ticks):
        if not alive(a.hp):
            return right.name, 1.0, 0
        apply(a, fire(b, a))
    for _ in range(left_opening_volley_ticks):
        if not alive(b.hp):
            return left.name, 1.0, 0
        apply(b, fire(a, b))

    for tick in range(1, 10_001):
        if not alive(a.hp) and not alive(b.hp):
            return None, 0.0, tick - 1
        if not alive(a.hp):
            return right.name, sum(b.hp) / initial_hp_b, tick - 1
        if not alive(b.hp):
            return left.name, sum(a.hp) / initial_hp_a, tick - 1
        # Both volleys use the same pre-tick alive snapshot; a unit killed now still fires.
        hits_a = fire(b, a)
        hits_b = fire(a, b)
        apply(a, hits_a)
        apply(b, hits_b)
    raise RuntimeError("combat did not terminate within 10,000 ticks")


def opening_ticks(attack_range: int, advancing_speed: int, start_distance: int = 6) -> int:
    """Ranged volleys before the advancing range-1 unit can return fire."""
    ticks_to_melee = math.ceil(max(0, start_distance - 1) / advancing_speed)
    ticks_to_ranged_range = math.ceil(max(0, start_distance - attack_range) / advancing_speed)
    return max(0, ticks_to_melee - ticks_to_ranged_range)


def c4_melee_efficiency(melee: Unit, others: Iterable[Unit]) -> bool:
    for other in others:
        # Cross-multiplication preserves exact integer comparisons.
        if melee.hp * other.cost < other.hp * melee.cost:
            return False
        if melee.damage * other.cost < other.damage * melee.cost:
            return False
    return True


def check_roster(worker: Unit, melee: Unit, ranged: Unit, cavalry: Unit) -> dict[str, bool]:
    budget_mr = lcm(melee.cost, ranged.cost)
    budget_rc = lcm(ranged.cost, cavalry.cost)
    budget_mc = lcm(melee.cost, cavalry.cost)
    c1_winner, _, _ = fight(
        melee,
        ranged,
        budget=budget_mr,
        right_opening_volley_ticks=opening_ticks(ranged.attack_range, melee.speed),
    )
    c2_winner, _, _ = fight(
        ranged,
        cavalry,
        budget=budget_rc,
        left_opening_volley_ticks=opening_ticks(ranged.attack_range, cavalry.speed),
    )
    c3_winner, c3_margin, _ = fight(melee, cavalry, budget=budget_mc)
    return {
        "C1": c1_winner == melee.name,
        "C2": c2_winner == ranged.name,
        "C3": c3_winner == melee.name and c3_margin >= 0.25,
        "C4": c4_melee_efficiency(melee, (worker, ranged, cavalry)),
        "C5": cavalry.speed == 2 and cavalry.cost >= 2 * melee.cost,
        "C6": ranged.attack_range > 1 and math.ceil(ranged.hp / melee.damage) <= 2,
    }


def ranges(values: list[int]) -> str:
    if not values:
        return "—"
    ordered = sorted(set(values))
    if len(ordered) == 1:
        return str(ordered[0])
    if ordered == list(range(ordered[0], ordered[-1] + 1)):
        return f"{ordered[0]}–{ordered[-1]}"
    return ", ".join(map(str, ordered))


def combat_report() -> str:
    workers = [Unit("worker", cost, hp, 0) for cost in (4, 5, 6, 8) for hp in (2, 3, 4, 6)]
    melees = [
        Unit("melee", cost, hp, damage)
        for cost in (8, 10, 12)
        for hp in (12, 16, 20)
        for damage in (3, 4, 5)
    ]
    rangeds = [
        Unit("ranged", cost, hp, damage, attack_range=attack_range)
        for cost in (12, 16, 20)
        for hp in (4, 6, 8, 10)
        for damage in (2, 3, 4)
        for attack_range in (2, 3, 4)
    ]
    cavalries = [
        Unit("cavalry", cost, hp, damage, speed=2)
        for cost in (16, 20, 24, 30, 40)
        for hp in (6, 8, 10)
        for damage in (2, 3, 4)
    ]
    labels = ("C1", "C2", "C3", "C4", "C5", "C6")
    counts = {label: 0 for label in labels}
    pair_counts = {(a, b): 0 for a, b in itertools.combinations(labels, 2)}
    feasible = 0
    domains: dict[str, list[int]] = {}
    witness: tuple[Unit, Unit, Unit, Unit, dict[str, bool]] | None = None
    tested = 0

    for melee, ranged, cavalry in itertools.product(melees, rangeds, cavalries):
        tested += len(workers)
        # fight() memoizes each unique equal-budget pair: evaluating all Cartesian roster
        # combinations keeps single-constraint counts honest without repeating each battle.
        base_results = check_roster(workers[0], melee, ranged, cavalry)
        for worker in workers:
            full_results = dict(base_results)
            full_results["C4"] = c4_melee_efficiency(melee, (worker, ranged, cavalry))
            for label, passes in full_results.items():
                counts[label] += int(passes)
            for pair in pair_counts:
                pair_counts[pair] += int(full_results[pair[0]] and full_results[pair[1]])
            if all(full_results.values()):
                feasible += 1
                roster = (worker, melee, ranged, cavalry)
                if witness is None:
                    witness = (*roster, full_results)
                for unit in roster:
                    for key, value in ((f"{unit.name}.cost", unit.cost), (f"{unit.name}.hp", unit.hp)):
                        domains.setdefault(key, []).append(value)
                    if unit.name != "worker":
                        domains.setdefault(f"{unit.name}.damage", []).append(unit.damage)
                    domains.setdefault(f"{unit.name}.speed", []).append(unit.speed)
                    domains.setdefault(f"{unit.name}.range", []).append(unit.attack_range)

    lines = [
        "### 1) 站桩对拼可行域",
        "",
        f"- 搜索网格：worker {len(workers)} × melee {len(melees)} × ranged {len(rangeds)} × cavalry {len(cavalries)}；共评估 {tested} 个完整 roster（战斗配对用缓存复用）。",
        f"- 同时成立解：**{feasible} 个完整 roster**（候选离散网格内）；因此 C1–C6 在本工作台的操作化定义下**有同时成立解**。单项通过数是该约束在全网格中的通过数量，不能相加。",
        "- 等成本方式：双方预算取造价最小公倍数，按整数单位组成；每方每 tick 全体存活单位集火当前最低 HP 目标，同时结算。假定无遮挡接敌起点为 Chebyshev 距离 6，按射程/速度算远程先手 volley（忽略同时进入近战射程的那一轮）。",
        "",
        "| 约束 | 满足候选数 | 判定 |",
        "|---|---:|---|",
    ]
    for label in labels:
        lines.append(f"| {label} | {counts[label]} | {'有解' if counts[label] else '无解'} |")
    lines += ["", "| 同时解中的参数 | 可行区间（候选搜索网格内） |", "|---|---:|"]
    display_keys = (
        "worker.cost", "worker.hp", "melee.cost", "melee.hp", "melee.damage",
        "ranged.cost", "ranged.hp", "ranged.damage", "ranged.range",
        "cavalry.cost", "cavalry.hp", "cavalry.damage",
    )
    for key in display_keys:
        lines.append(f"| `{key}` | {ranges(domains.get(key, []))} |")
    lines += [
        "| 速度 | worker/melee/ranged = 1；cavalry = 2（约束固定） |",
        "| `spawnTicks` | C1–C6 对它无约束；可行关系只有外部给定的 `spawnTicks = ceil(cost × α)`（α>0）。不能从这六条约束推出 α 的有限上下界。 |",
    ]
    if witness:
        worker, melee, ranged, cavalry, _ = witness
        lines += [
            "",
            "一个具体见证（非推荐终值）：",
            "",
            "| 兵种 | cost | hp | damage | range | speed | spawnTicks（α=0.5） |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
        for unit in (worker, melee, ranged, cavalry):
            lines.append(f"| {unit.name} | {unit.cost} | {unit.hp} | {unit.damage} | {unit.attack_range} | {unit.speed} | {math.ceil(unit.cost * 0.5)} |")
        lines += [
            "",
            "对该见证取 `harvestRate=1, carryLimit=20, D=4`，单农完整周期 25 tick、净收入 0.8/tick；所有兵种按 `spawnTicks=ceil(cost×0.5)` 生产时，单基地满产烧钱率均为 2/tick。因此这组数在上述经济假设下也给出 **C1–C7 同时成立解**。",
            "C3 清晰优势阈值：近战胜后至少保留初始总 HP 的 25%；该见证附近的约束仍需后续桩模拟实证。",
        ]
    else:
        lines += ["", "没有发现全约束见证。零解约束对如下："]
        conflicts = [f"{a}+{b}" for (a, b), count in pair_counts.items() if count == 0]
        lines.append(", ".join(conflicts) if conflicts else "候选网格分辨率不足；扩展候选网格再测。")
    lines += [
        "",
        "> 区间是有限候选格点投影，不是连续数学可行域或推荐平衡值。焦点集火、接敌距离 6 和 25% 的 C3 阈值均是工作台假设；改任一假设须重跑。"
    ]
    return "\n".join(lines)


def economy_report() -> str:
    lines = [
        "### 2) 经济回路与 C7 可行域",
        "",
        "假设矿/基地中心 Chebyshev 距离为 D；农民在二者各自相邻一格作业，故每程走 `max(0,D−2)` 格、速度 1；满载后往返并花 1 tick 交付，不计争夺/堵路/采矿停工。令携带量 = `harvestRate × 有效采集 tick`（20–50 tick），则：",
        "",
        "```text",
        "cycleTicks = carryTicks + 2×max(0,D−2) + 1",
        "workerIncome = carryLimit / cycleTicks",
        "baseBurn(unit) = unit.cost / unit.spawnTicks",
        "C7 ⇔ baseBurn > workerIncome；舒适筛选带（启发式）= 2–4 × workerIncome",
        "```",
        "",
        "| harvestRate | D | 携带量范围（20–50 tick） | 单农净收入/ tick 区间 | 单基地舒适满产消耗/ tick（2–4×） |",
        "|---:|---:|---:|---:|---:|",
    ]
    for rate in (1, 2, 5, 10):
        for distance in (4, 8, 12):
            leg = max(0, distance - 2)
            values = [
                (rate * harvest_ticks) / (harvest_ticks + 2 * leg + 1)
                for harvest_ticks in (20, 50)
            ]
            low, high = min(values), max(values)
            lines.append(
                f"| {rate} | {distance} | {rate * 20}–{rate * 50} | {low:.2f}–{high:.2f} | {2 * low:.2f}–{4 * high:.2f} |"
            )
    lines += [
        "",
        "- 对给定回路，C7 的硬边界是 `min_unit(cost/spawnTicks) > workerIncome`（要声称任何满产兵种组合都满足，需比较其实际生产组合，而不是只挑高消耗兵种）。在连续比例 `spawnTicks≈cost×α` 下，`baseBurn≈1/α`，故 C7 可行当 `α < 1/workerIncome`；2–4× 收入的启发式舒适带为 `1/(4×workerIncome) ≤ α ≤ 1/(2×workerIncome)`。它不是 GDD 规范。",
        "- `initialResources` 不改变稳态 C7；仅决定开局现金跑道。若要求起始存款至少能购买一名补充农民或一名近战兵，必要且充分条件是 `initialResources ≥ max(worker.cost, melee.cost)`；在 combat 搜索网格中的可行下界为 8–12（按具体 roster），此算术没有上界，过高风险须由实战 pacing 定案。",
        "- 存在与 combat witness 兼容的 C7 取值：`harvestRate=1,D=4,carryTicks=20` 时收入 `20/25=0.8/tick`，可设 `carryLimit=20`；近战 `cost=8,spawnTicks=4` 的满产消耗为 `2/tick`，满足 C7。此例 `α=0.5`，连续 2–4× 舒适带为 `[0.3125,0.625]`。"
    ]
    return "\n".join(lines)


def exhaustion_report() -> str:
    sites = (8, 16, 32)
    workers = (4, 8, 16)
    rate = 2
    tick_limit = 600
    efficiency = 0.5
    lines = [
        "### 3) 枯竭与 `tickLimit` 自洽域",
        "",
        "`N` 个资源点、`W` 个等效持续采集农民、采集利用率 η 时，理想化可采总量 `Q = harvestRate × W × η × tickLimit`；全图储量 `S=N×resourcePerSite`。在 2/3–1.0 个 `tickLimit` 才被采空的筛选带为：",
        "",
        "```text",
        "ceil( (2/3) × harvestRate × W × η × tickLimit / N )",
        "    ≤ resourcePerSite ≤",
        "floor( harvestRate × W × η × tickLimit / N )",
        "```",
        "",
        f"敏感性表固定 `harvestRate={rate}`, `tickLimit={tick_limit}`, `η={efficiency}`；变化 N 与持续等效农民数 W。表内上下界分别对应理想采空时间约 2/3 与 1.0 个上限：",
        "",
        "| 资源点 N | 等效农民 W | 2/3–1.0 时间轴可行 `resourcePerSite` |",
        "|---:|---:|---:|",
    ]
    for n_sites, active_workers in itertools.product(sites, workers):
        capacity_per_site = rate * active_workers * efficiency * tick_limit / n_sites
        lower = math.ceil(capacity_per_site * (2 / 3))
        upper = math.floor(capacity_per_site)
        lines.append(f"| {n_sites} | {active_workers} | {lower}–{upper} |")
    lines += [
        "",
        "- 此式只给出参数自洽必要的量级，不证明真实对局会采空。`W` 与 η 必须来自地图可用采矿邻格、农民投入时间、搬运路程、基地交付可达性和争夺损失；将 `W` 当作地图上全部单位会高估采集能力。若只要求‘上限内理论可采空’，去掉 2/3 下界即可。",
        "- `resourcePerSite` 的自洽域对 `harvestRate×tickLimit×W×η/N` 线性缩放；当前 GDD 未定 N、W、η，故不存在单独的绝对取值区间。",
    ]
    return "\n".join(lines)


def score_report() -> str:
    base_deltas = 1
    resource_deltas = 2
    leader_unit_cost = 64
    runner_unit_cost = 32
    ratio_trials = (1, 2, 4)
    lines = [
        "### 4) 超时领土分与 2/3 终局压力",
        "",
        "给定 2/3 tick 时仍可翻动的差额 `ΔB` 个基地、`ΔR` 个资源点，以及 `ΔU` 存活单位造价差，终局可能分差的量级比较为：",
        "",
        "```text",
        "territorySwing = ΔB×baseScore + ΔR×resourceScore",
        "unitSwing = floor(U_leader/unitCostDivisor) − floor(U_runnerup/unitCostDivisor)",
        "仍有反超可能 ⇔ 当前领先分差 ≤ 对手可达的剩余 swing（须由地图/策略估计）",
        "```",
        "",
        f"演示归一化情景（不是地图事实）：ΔB={base_deltas}, ΔR={resource_deltas}；假定 2/3 tick 时两方存活单位总造价分别为 {leader_unit_cost} 与 {runner_unit_cost}，令 `resourceScore=1`，按探索性的 `baseScore/resourceScore` 比 1、2、4 计算。把单位分差筛在领土分差的 0.5–2 倍，得到：",
        "",
        "| `baseScore/resourceScore` | territorySwing | 允许 unitSwing | 可行整数 `unitCostDivisor`（按 floor 精算） |",
        "|---:|---:|---:|---:|",
    ]
    for base_weight in ratio_trials:
        territory = base_deltas * base_weight + resource_deltas
        valid = [
            divisor for divisor in range(1, 257)
            if 0.5 * territory <= math.floor(leader_unit_cost / divisor) - math.floor(runner_unit_cost / divisor) <= 2 * territory
        ]
        allowed_low = math.ceil(0.5 * territory)
        allowed_high = math.floor(2 * territory)
        lines.append(
            f"| {base_weight} | {territory} | {allowed_low}–{allowed_high} | {ranges(valid)} |"
        )
    lines += [
        "",
        "- 这些权重只有相对比例有意义：把 `baseScore`、`resourceScore` 同乘常数会同比放大领土分；`unitCostDivisor` 也需按同一量纲配套调整。演示的单位分差按 `floor(64/divisor)−floor(32/divisor)` 精算。若无地图点位数、2/3 tick 的剩余可争夺点位、两名次典型存活造价及当时领先分差，‘终局压力’不能从 GDD 单独解出唯一数值区间。",
        "- 可移植的验收口径应是：在基准脚本/地图的 2/3 tick，列出可能 swing 上界，并与当时领先分差比较；若大多数对局领先分差已经超过剩余 swing，终局压力来得过早；若上限附近仍普遍有大 swing 且长期无法拉开名次，再调权重/资源/生产。",
        "- 这里的 `baseScore/resourceScore ∈ {1,2,4}`、0.5–2 倍单位分筛选带均为方便暴露比例的扫描点，不是规范或平衡结论。",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--section", choices=("all", "combat", "economy", "exhaustion", "score"), default="all")
    args = parser.parse_args()
    sections = {
        "combat": combat_report,
        "economy": economy_report,
        "exhaustion": exhaustion_report,
        "score": score_report,
    }
    selected = sections.items() if args.section == "all" else [(args.section, sections[args.section])]
    print("# Calibration workbench output\n")
    for _, render in selected:
        print(render())
        print()


if __name__ == "__main__":
    main()
