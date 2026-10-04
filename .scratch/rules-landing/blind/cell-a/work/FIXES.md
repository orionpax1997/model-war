# FIXES

## v1 (work/script.v1.ts) — baseline, no fixes yet
- Authored from input/rules.md, input/api.md, input/PROMPT.base.md, input/STRATEGY.txt only.
- Strategy A (爆兵压制): small worker floor (2), rest melee; attack/advance; press nearest non-owned site.
- Static self-checks: no import/export/require/eval; no Date/Math.random/performance/queueMicrotask;
  no `__` globals; no `typeof`; loop() at top level; seat only via getMyIndex(); `producing` read
  before every spawnUnit; exactly one unit-level intent per unit per tick; integer-only arithmetic.
