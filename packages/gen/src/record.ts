/**
 * 一个内部小工具:`unknown` → 「键值对映射」的收窄判据。
 *
 * `config.ts`(解析 `models.yaml` 的 YAML)与 `http/endpoints.ts`(解析端点返回的 JSON)
 * 都在拿外部输入时用同一个判据收窄成 `Record`——两处各写一份逐字相同的实现,改了其中一处
 * 就与另一处漂移。抽到这里,是「每个事实只有一个家」在包内的最小落地。
 *
 * 它只是内部工具,不进包的公开面(`index.ts`),也不属于任何域模块。
 */

/** `typeof value === "object" && value !== null && !Array.isArray(value)` 的命名判据。 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
