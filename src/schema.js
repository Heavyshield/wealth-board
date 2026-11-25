// Minimal JSON Schema validator (subset of draft 2020-12 used by /schema/*.json).
// Supported: type, const, enum, required, properties, additionalProperties (bool|schema),
// items, minimum, maximum, exclusiveMinimum, minLength, pattern, format, $ref (local "#/$defs/...").
// Errors are returned in French with a readable path, e.g. "holdings[3].quantity".

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const FORMATS = {
  'date': (v) => DATE.test(v) && !isNaN(Date.parse(v)),
  'date-time': (v) => DATE_TIME.test(v) && !isNaN(Date.parse(v)),
  'date-or-date-time': (v) => FORMATS.date(v) || FORMATS['date-time'](v),
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected, v) {
  const t = typeOf(v);
  if (expected === 'number') return t === 'number' || t === 'integer';
  return t === expected;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`$ref non supporté : ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], root);
}

function joinPath(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/** Validate `data` against `schema`. Returns an array of { path, message } (empty = valid). */
export function validate(schema, data) {
  const errors = [];
  walk(schema, data, '', schema, errors);
  return errors;
}

function walk(s, v, path, root, errors) {
  if (s.$ref) s = resolveRef(root, s.$ref);
  const at = path || '(racine)';
  const fail = (message) => errors.push({ path: at, message });

  if ('const' in s && v !== s.const) return fail(`doit valoir ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) return fail(`valeur ${JSON.stringify(v)} non autorisée (attendu : ${s.enum.join(', ')})`);
  if (s.type && !typeMatches(s.type, v)) return fail(`type attendu ${s.type}, reçu ${typeOf(v)}`);

  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) fail(`doit être ≥ ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) fail(`doit être ≤ ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) fail(`doit être > ${s.exclusiveMinimum}`);
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) fail('ne doit pas être vide');
    if (s.pattern && !new RegExp(s.pattern).test(v)) fail(`format invalide « ${v} »`);
    if (s.format && FORMATS[s.format] && !FORMATS[s.format](v)) fail(`date invalide « ${v} » (format ${s.format})`);
  }
  if (Array.isArray(v) && s.items) {
    v.forEach((item, i) => walk(s.items, item, joinPath(path, i), root, errors));
  }
  if (typeOf(v) === 'object') {
    for (const key of s.required || []) {
      if (!(key in v)) errors.push({ path: at, message: `champ obligatoire manquant « ${key} »` });
    }
    const props = s.properties || {};
    for (const [key, val] of Object.entries(v)) {
      if (props[key]) walk(props[key], val, joinPath(path, key), root, errors);
      else if (s.additionalProperties === false) errors.push({ path: joinPath(path, key), message: 'champ inconnu (faute de frappe ?)' });
      else if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, val, joinPath(path, key), root, errors);
    }
  }
}
