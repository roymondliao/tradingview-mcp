/** Pure Candidate Pine Input Schema extraction and identity helpers. */
import { sha256Hex } from './stable-json.js';

export const PINE_INPUT_SCHEMA_VERSION = 1;

const INPUT_TYPE_REGISTRY = Object.freeze({
  bool: Object.freeze({ runtime_type: 'bool' }),
  int: Object.freeze({ runtime_type: 'int' }),
  float: Object.freeze({ runtime_type: 'float' }),
  string: Object.freeze({ runtime_type: 'string' }),
  time: Object.freeze({ runtime_type: 'int' }),
  source: Object.freeze({ runtime_type: 'source' }),
  symbol: Object.freeze({ runtime_type: 'string' }),
  timeframe: Object.freeze({ runtime_type: 'string' }),
  session: Object.freeze({ runtime_type: 'string' }),
  color: Object.freeze({ runtime_type: 'color' }),
  price: Object.freeze({ runtime_type: 'float' }),
  text_area: Object.freeze({ runtime_type: 'string' }),
  enum: Object.freeze({ runtime_type: null }),
});

const CONSTRAINT_NAMES = Object.freeze({
  minval: 'min',
  maxval: 'max',
  step: 'step',
  options: 'options',
});

export function normalizePineSource(source) {
  return String(source ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function normalizedPineSourceSha256(source) {
  return sha256Hex(normalizePineSource(source));
}

/** Return only bounded compiler-confirmed Input variables. */
export function sanitizeCompilerInputVariables(compilerResult) {
  const groups = compilerResult?.variables2;
  if (!Array.isArray(groups)) return [];
  const results = [];
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group?.docs)) continue;
    for (const item of group.docs) {
      const variableName = typeof item?.name === 'string' ? item.name.trim() : '';
      const rawType = typeof item?.type === 'string' ? item.type.trim() : '';
      if (!variableName || !rawType.startsWith('input ')) continue;
      const inferredType = rawType.slice('input '.length).trim();
      if (!inferredType || seen.has(variableName)) continue;
      seen.add(variableName);
      results.push(Object.freeze({ variable_name: variableName, inferred_type: inferredType }));
    }
  }
  return Object.freeze(results);
}

function isIdentifierStart(char) {
  return char === '_' || /[A-Za-z]/.test(char || '');
}

function isIdentifierPart(char) {
  return char === '_' || /[A-Za-z0-9]/.test(char || '');
}

function decodeEscape(char) {
  if (char === 'n') return '\n';
  if (char === 'r') return '\r';
  if (char === 't') return '\t';
  return char;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = () => {
    const char = source[index++];
    if (char === '\n') { line += 1; column = 1; } else column += 1;
    return char;
  };

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { advance(); continue; }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') advance();
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      advance(); advance();
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) advance();
      if (index < source.length) { advance(); advance(); }
      continue;
    }

    const start = index;
    const startLine = line;
    const startColumn = column;
    if (char === '"' || char === "'") {
      const quote = advance();
      let value = '';
      let closed = false;
      while (index < source.length) {
        const current = advance();
        if (current === '\\' && index < source.length) {
          value += decodeEscape(advance());
        } else if (current === quote) {
          closed = true;
          break;
        } else {
          value += current;
        }
      }
      tokens.push({
        type: closed ? 'string' : 'unterminated_string', value,
        raw: source.slice(start, index), start, end: index, line: startLine, column: startColumn,
      });
      continue;
    }

    if (isIdentifierStart(char)) {
      advance();
      while (isIdentifierPart(source[index])) advance();
      tokens.push({
        type: 'identifier', value: source.slice(start, index),
        start, end: index, line: startLine, column: startColumn,
      });
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(source[index + 1] || ''))) {
      advance();
      while (/[0-9A-Fa-f_xX.eE+-]/.test(source[index] || '')) {
        const current = source[index];
        if ((current === '+' || current === '-') && !/[eE]/.test(source[index - 1] || '')) break;
        advance();
      }
      tokens.push({
        type: 'number', value: source.slice(start, index),
        start, end: index, line: startLine, column: startColumn,
      });
      continue;
    }

    advance();
    tokens.push({
      type: 'punctuation', value: char,
      start, end: index, line: startLine, column: startColumn,
    });
  }
  return tokens;
}

function canonicalTokens(tokens) {
  return tokens.map((token) => token.type === 'string' ? JSON.stringify(token.value) : token.value).join(' ');
}

function findClosingToken(tokens, openIndex) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let index = openIndex; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if (stack.length && value === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return index;
    }
  }
  return -1;
}

function splitTopLevel(tokens, delimiter = ',') {
  const parts = [];
  let start = 0;
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if (stack.length && value === stack[stack.length - 1]) stack.pop();
    else if (!stack.length && value === delimiter) {
      parts.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts.filter((part) => part.length > 0);
}

function namedArgument(part) {
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  for (let index = 0; index < part.length; index++) {
    const value = part[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if (stack.length && value === stack[stack.length - 1]) stack.pop();
    else if (!stack.length && value === '=') {
      if (index === 1 && part[0].type === 'identifier') {
        return { name: part[0].value, value: part.slice(index + 1) };
      }
      return null;
    }
  }
  return null;
}

function expressionSource(tokens, source) {
  if (!tokens.length) return '';
  return source.slice(tokens[0].start, tokens[tokens.length - 1].end).trim();
}

function parseNumber(raw) {
  const normalized = raw.replaceAll('_', '');
  if (/^0[xX][0-9A-Fa-f]+$/.test(normalized)) return Number.parseInt(normalized.slice(2), 16);
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseStaticLiteral(tokens, source) {
  if (!tokens.length) return { resolved: false, expression: '' };
  if (tokens.length === 1) {
    const [token] = tokens;
    if (token.type === 'string') return { resolved: true, value: token.value };
    if (token.type === 'number') {
      const value = parseNumber(token.value);
      if (value !== null) return { resolved: true, value };
    }
    if (token.type === 'identifier' && ['true', 'false'].includes(token.value)) {
      return { resolved: true, value: token.value === 'true' };
    }
  }
  if (
    tokens.length === 2
    && ['+', '-'].includes(tokens[0].value)
    && tokens[1].type === 'number'
  ) {
    const value = parseNumber(tokens[1].value);
    if (value !== null) return { resolved: true, value: tokens[0].value === '-' ? -value : value };
  }
  if (tokens[0].value === '[' && tokens[tokens.length - 1].value === ']') {
    const parts = splitTopLevel(tokens.slice(1, -1));
    const values = [];
    for (const part of parts) {
      const parsed = parseStaticLiteral(part, source);
      if (!parsed.resolved) return { resolved: false, expression: expressionSource(tokens, source) };
      values.push(parsed.value);
    }
    return { resolved: true, value: values };
  }
  return { resolved: false, expression: expressionSource(tokens, source) };
}

function schemaError(code, message, { compilerInput, token } = {}) {
  return Object.freeze({
    code,
    message,
    ...(compilerInput?.variable_name && { variable_name: compilerInput.variable_name }),
    ...(token && { line: token.line, column: token.column }),
  });
}

function locateDeclaration(tokens, compilerInput) {
  for (let index = 0; index < tokens.length; index++) {
    const variable = tokens[index];
    if (variable.type !== 'identifier' || variable.value !== compilerInput.variable_name) continue;
    if (tokens[index + 1]?.value !== '=' || tokens[index + 2]?.value !== 'input') continue;
    if (tokens[index + 3]?.value === '(') {
      return { variable, legacy: true, openIndex: index + 3, startIndex: index };
    }
    if (
      tokens[index + 3]?.value === '.'
      && tokens[index + 4]?.type === 'identifier'
      && tokens[index + 5]?.value === '('
    ) {
      return {
        variable, legacy: false, inputType: tokens[index + 4].value,
        openIndex: index + 5, startIndex: index,
      };
    }
  }
  return null;
}

function normalizeDeclaration({ declaration, compilerInput, tokens, source, declarationIndex }) {
  const closeIndex = findClosingToken(tokens, declaration.openIndex);
  if (closeIndex < 0) {
    return { error: schemaError(
      'PINE_INPUT_DECLARATION_UNRESOLVED',
      `Input declaration has no closing parenthesis: ${compilerInput.variable_name}`,
      { compilerInput, token: declaration.variable },
    ) };
  }
  if (declaration.legacy) {
    return { error: schemaError(
      'PINE_INPUT_TYPE_UNSUPPORTED',
      `Legacy input() is unsupported for automation: ${compilerInput.variable_name}`,
      { compilerInput, token: declaration.variable },
    ) };
  }
  const typeInfo = INPUT_TYPE_REGISTRY[declaration.inputType];
  if (!typeInfo) {
    return { error: schemaError(
      'PINE_INPUT_TYPE_UNSUPPORTED',
      `Unsupported Pine input type ${declaration.inputType}: ${compilerInput.variable_name}`,
      { compilerInput, token: declaration.variable },
    ) };
  }

  const argumentsList = splitTopLevel(tokens.slice(declaration.openIndex + 1, closeIndex));
  const positional = [];
  const named = new Map();
  for (const part of argumentsList) {
    const current = namedArgument(part);
    if (current) named.set(current.name, current.value);
    else positional.push(part);
  }
  const titleTokens = named.get('title') || positional[1] || [];
  const title = parseStaticLiteral(titleTokens, source);
  if (!title.resolved || typeof title.value !== 'string' || !title.value.trim()) {
    return { error: schemaError(
      titleTokens.length ? 'PINE_INPUT_NAME_UNRESOLVED' : 'PINE_INPUT_STATIC_TITLE_REQUIRED',
      `Input title must be a non-empty static string: ${compilerInput.variable_name}`,
      { compilerInput, token: declaration.variable },
    ) };
  }

  const expectedType = typeInfo.runtime_type;
  if (expectedType && compilerInput.inferred_type !== expectedType) {
    return { error: schemaError(
      'PINE_INPUT_TYPE_MISMATCH',
      `Compiler type ${compilerInput.inferred_type} does not match input.${declaration.inputType}: ${compilerInput.variable_name}`,
      { compilerInput, token: declaration.variable },
    ) };
  }

  const defaultTokens = named.get('defval') || positional[0] || [];
  const defaultValue = parseStaticLiteral(defaultTokens, source);
  const groupTokens = named.get('group') || [];
  const groupValue = groupTokens.length ? parseStaticLiteral(groupTokens, source) : null;
  const constraints = {};
  for (const [argumentName, publicName] of Object.entries(CONSTRAINT_NAMES)) {
    const valueTokens = named.get(argumentName);
    if (!valueTokens) continue;
    const parsed = parseStaticLiteral(valueTokens, source);
    if (!parsed.resolved) {
      return { error: schemaError(
        'PINE_INPUT_CONSTRAINT_UNRESOLVED',
        `Input ${argumentName} must be statically resolvable: ${compilerInput.variable_name}`,
        { compilerInput, token: declaration.variable },
      ) };
    }
    constraints[publicName] = parsed.value;
  }

  const declarationTokens = tokens.slice(declaration.startIndex, closeIndex + 1);
  const item = {
    declaration_index: declarationIndex,
    variable_name: compilerInput.variable_name,
    name: title.value.trim(),
    pine_input_type: declaration.inputType,
    runtime_value_type: compilerInput.inferred_type,
    ...(defaultValue.resolved
      ? { default_value: defaultValue.value }
      : { default_expression: defaultValue.expression }),
    ...(groupValue?.resolved
      ? { group: groupValue.value }
      : groupValue ? { group_expression: groupValue.expression } : {}),
    constraints,
    location: { line: declaration.variable.line, column: declaration.variable.column },
    declaration_sha256: sha256Hex(canonicalTokens(declarationTokens)),
  };
  return { item: Object.freeze(item), closeIndex };
}

function schemaFingerprintItems(inputs) {
  return inputs.map(({ location: _location, declaration_index: _index, ...item }) => item);
}

/** Build one candidate schema without executing Pine expressions. */
export function extractCandidateInputSchema({ source, compiler_inputs } = {}) {
  const normalizedSource = normalizePineSource(source);
  const compilerInputs = Array.isArray(compiler_inputs) ? compiler_inputs : [];
  const tokens = tokenize(normalizedSource);
  const inputs = [];
  const errors = [];

  for (let index = 0; index < compilerInputs.length; index++) {
    const compilerInput = compilerInputs[index];
    const declaration = locateDeclaration(tokens, compilerInput);
    if (!declaration) {
      errors.push(schemaError(
        'PINE_INPUT_DECLARATION_NOT_FOUND',
        `Compiler Input declaration not found: ${compilerInput.variable_name}`,
        { compilerInput },
      ));
      continue;
    }
    const normalized = normalizeDeclaration({
      declaration, compilerInput, tokens, source: normalizedSource, declarationIndex: index,
    });
    if (normalized.error) errors.push(normalized.error);
    else inputs.push(normalized.item);
  }

  const names = new Map();
  for (const item of inputs) {
    const matches = names.get(item.name) || [];
    matches.push(item);
    names.set(item.name, matches);
  }
  for (const [name, matches] of names) {
    if (matches.length < 2) continue;
    errors.push(Object.freeze({
      code: 'PINE_INPUT_NAME_AMBIGUOUS',
      message: `Input title is not unique: ${name}`,
      input_name: name,
      variables: matches.map((item) => item.variable_name),
    }));
  }

  const available = errors.length === 0 && inputs.length === compilerInputs.length;
  const fingerprint = available ? sha256Hex(schemaFingerprintItems(inputs)) : null;
  return Object.freeze({
    available,
    schema_version: PINE_INPUT_SCHEMA_VERSION,
    source_sha256: normalizedPineSourceSha256(normalizedSource),
    compiler_input_count: compilerInputs.length,
    input_count: inputs.length,
    inputs: Object.freeze(inputs),
    input_schema_fingerprint: fingerprint,
    errors: Object.freeze(errors),
  });
}

