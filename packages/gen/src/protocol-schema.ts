/**
 * 试跑协议所用 JSON Schema 子集适配器。形状、键名和范围只取共享 Schema；
 * 遇到未来未支持的关键字直接失败，不能静默放宽。该模块不定义任何业务字段。
 */
type ProtocolSchema = {
  readonly $schema?: string;
  readonly title?: string;
  readonly type?: "object" | "integer" | "number" | "string" | "boolean" | "array" | "null";
  readonly const?: unknown;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly anyOf?: readonly ProtocolSchema[];
  readonly items?: ProtocolSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly properties?: Readonly<Record<string, ProtocolSchema>>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly if?: ProtocolSchema;
  readonly then?: ProtocolSchema;
  readonly else?: ProtocolSchema;
};

const supportedKeywords = new Set([
  "$schema",
  "title",
  "type",
  "const",
  "enum",
  "anyOf",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "required",
  "additionalProperties",
  "properties",
  "minimum",
  "maximum",
  "pattern",
  "if",
  "then",
  "else",
]);

/** 只编译本协议已有的关键字；调用者仍负责跨行、计数关系和当前候选身份。 */
export const compileProtocolSchema = (schema: ProtocolSchema): ((value: unknown) => boolean) => {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("试跑 Schema 关键字取值未支持");
  for (const key of Object.keys(schema)) {
    if (!supportedKeywords.has(key)) throw new Error(`试跑 Schema 关键字未支持：${key}`);
  }
  if (
    (schema.type !== undefined &&
      !["object", "integer", "number", "string", "boolean", "array", "null"].includes(
        schema.type,
      )) ||
    (schema.enum !== undefined &&
      (!Array.isArray(schema.enum) ||
        schema.enum.length === 0 ||
        !schema.enum.every(
          (value) =>
            value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)),
        ))) ||
    (schema.anyOf !== undefined && (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0)) ||
    [schema.minItems, schema.maxItems, schema.minLength, schema.maxLength].some(
      (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every((key) => typeof key === "string"))) ||
    (schema.properties !== undefined &&
      (schema.properties === null ||
        typeof schema.properties !== "object" ||
        Array.isArray(schema.properties))) ||
    (schema.pattern !== undefined && typeof schema.pattern !== "string") ||
    (schema.minimum !== undefined && !Number.isFinite(schema.minimum)) ||
    (schema.maximum !== undefined && !Number.isFinite(schema.maximum))
  ) {
    throw new Error("试跑 Schema 关键字取值未支持");
  }
  const properties = Object.entries(schema.properties ?? {}).map(
    ([key, child]) => [key, compileProtocolSchema(child)] as const,
  );
  const propertyKeys = new Set(properties.map(([key]) => key));
  const pattern = schema.pattern === undefined ? undefined : new RegExp(schema.pattern);
  const itemMatches = schema.items === undefined ? undefined : compileProtocolSchema(schema.items);
  const alternatives = schema.anyOf?.map((child) => compileProtocolSchema(child));
  const condition = schema.if === undefined ? undefined : compileProtocolSchema(schema.if);
  const onTrue = schema.then === undefined ? undefined : compileProtocolSchema(schema.then);
  const onFalse = schema.else === undefined ? undefined : compileProtocolSchema(schema.else);
  return (value) => {
    if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
    if (schema.enum !== undefined && !schema.enum.some((entry) => entry === value)) return false;
    if (alternatives !== undefined && !alternatives.some((matches) => matches(value))) return false;
    if (schema.type === "null" && value !== null) return false;
    if (schema.type === "array" && !Array.isArray(value)) return false;
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) return false;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
      if (itemMatches !== undefined && !value.every((entry) => itemMatches(entry))) return false;
    }
    if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
      return false;
    if (schema.type === "integer" && (typeof value !== "number" || !Number.isInteger(value)))
      return false;
    if (schema.type === "string" && typeof value !== "string") return false;
    if (schema.type === "boolean" && typeof value !== "boolean") return false;
    const object =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    if (schema.type === "object" && object === undefined) return false;
    if (object !== undefined) {
      if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false;
      if (
        schema.additionalProperties === false &&
        Object.keys(object).some((key) => !propertyKeys.has(key))
      )
        return false;
      for (const [key, matches] of properties) {
        if (Object.hasOwn(object, key) && !matches(object[key])) return false;
      }
    }
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum))
    )
      return false;
    if (typeof value === "string") {
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength) return false;
      if (schema.maxLength !== undefined && length > schema.maxLength) return false;
      if (pattern !== undefined && !pattern.test(value)) return false;
    }
    if (condition !== undefined) {
      const matchesBranch = condition(value) ? onTrue : onFalse;
      if (matchesBranch !== undefined && !matchesBranch(value)) return false;
    }
    return true;
  };
};
