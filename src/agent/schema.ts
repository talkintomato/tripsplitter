/** Provider-only encoding. The original Zod schemas still validate every tool invocation. */
type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);
function nullable(schema: Schema): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) ||
    (Array.isArray(schema.anyOf) && schema.anyOf.some(s => object(s) && nullable(s)));
}
export function strictParameters(schema: Schema): Schema {
  const out: Schema = {};
  // Keep a deliberately small supported subset. All domain constraints remain in Zod.
  for (const key of ['type', 'enum', 'description']) if (schema[key] !== undefined) out[key] = schema[key];
  if (Array.isArray(schema.anyOf)) out.anyOf = schema.anyOf.map(s => strictParameters(s as Schema));
  if (object(schema.items)) out.items = strictParameters(schema.items);
  if (object(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    out.type = 'object';
    out.additionalProperties = false;
    out.required = Object.keys(schema.properties);
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
      const source = value as Schema;
      let converted = strictParameters(source);
      if (!required.includes(key)) {
        // Optional + nullable needs three states: omitted, explicit null, and value.
        // A wrapper preserves clear-rate/clear-merchant edits without changing tool semantics.
        if (nullable(source)) converted = { type: 'object', properties: { value: converted }, required: ['value'], additionalProperties: false };
        converted = { anyOf: [converted, { type: 'null' }], description: nullable(source)
          ? 'null means leave unspecified; otherwise use {"value": ...}, including {"value": null} to explicitly clear.'
          : 'null means leave unspecified.' };
      }
      return [key, converted];
    }));
  }
  return out;
}
export function decodeArguments(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value) && object(schema.items)) return value.map(v => decodeArguments(v, schema.items as Schema));
  if (!object(value) || !object(schema.properties)) return value;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const result: Schema = {};
  for (const [key, original] of Object.entries(value)) {
    const child = schema.properties[key];
    if (!object(child)) { result[key] = original; continue; } // Zod rejects unknown fields.
    let v = original;
    if (!required.includes(key)) {
      if (v === null) continue;
      if (nullable(child)) {
        if (!object(v) || Object.keys(v).length !== 1 || !('value' in v)) throw new SyntaxError('Invalid optional value.');
        v = v.value;
      }
    }
    result[key] = decodeArguments(v, child);
  }
  return result;
}
