import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pairedTokens, tokenizeSource } from './source-symbol-lexer.mjs';

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function symbol(kind, name, startToken, closeToken) {
  return Object.freeze({
    kind,
    name,
    startLine: startToken.line,
    endLine: closeToken.line,
    lines: closeToken.line - startToken.line + 1,
  });
}

function functionBody(tokens, start, parentheses) {
  const parameterOpen = tokens.findIndex((token, index) => index > start && token.value === '(');
  if (parameterOpen < 0) return -1;
  const parameterClose = parentheses.get(parameterOpen);
  if (parameterClose === undefined) return -1;
  return tokens.findIndex(
    (token, index) => index > parameterClose && token.value === '{',
  );
}

function declarationName(tokens, index, fallback) {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor].value;
    if (value === '(' || value === '{') break;
    if (value !== '*' && /^[#A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) return value;
  }
  return `${fallback}@${tokens[index].line}`;
}

function arrowName(tokens, arrowIndex) {
  for (let index = arrowIndex - 1; index >= 0 && index >= arrowIndex - 20; index -= 1) {
    if (['=', ':'].includes(tokens[index].value)) {
      const candidate = tokens[index - 1]?.value;
      if (/^[#A-Za-z_$][A-Za-z0-9_$]*$/u.test(candidate ?? '')) return candidate;
    }
  }
  return `<arrow>@${tokens[arrowIndex].line}`;
}

function methodName(tokens, bodyIndex, parentheses) {
  const parameterClose = bodyIndex - 1;
  if (tokens[parameterClose]?.value !== ')') return null;
  const parameterOpen = parentheses.get(parameterClose);
  if (parameterOpen === undefined) return null;
  const candidate = tokens[parameterOpen - 1];
  if (!candidate || CONTROL_WORDS.has(candidate.value)) return null;
  if (!/^[#A-Za-z_$][A-Za-z0-9_$]*$/u.test(candidate.value)) return null;
  return { name: candidate.value, start: candidate };
}

function classRanges(tokens, braces, language) {
  const declarations = language === 'swift'
    ? new Set(['class', 'struct', 'actor', 'enum', 'extension'])
    : new Set(['class']);
  const ranges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!declarations.has(tokens[index].value)) continue;
    const body = tokens.findIndex((token, cursor) => cursor > index && token.value === '{');
    const close = braces.get(body);
    if (body < 0 || close === undefined) continue;
    ranges.push({
      body,
      close,
      metric: symbol(language === 'swift' ? 'type' : 'class', declarationName(tokens, index, 'type'), tokens[index], tokens[close]),
    });
  }
  return ranges;
}

function javascriptFunctions(tokens, braces, parentheses, classes) {
  const metrics = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === 'function') {
      const body = functionBody(tokens, index, parentheses);
      const close = braces.get(body);
      if (body >= 0 && close !== undefined) {
        metrics.push(symbol('function', declarationName(tokens, index, 'function'), tokens[index], tokens[close]));
      }
    }
    if (tokens[index].value === '=>' && tokens[index + 1]?.value === '{') {
      const close = braces.get(index + 1);
      if (close !== undefined) metrics.push(symbol('function', arrowName(tokens, index), tokens[index], tokens[close]));
    }
  }
  for (const range of classes) {
    for (let body = range.body + 1; body < range.close; body += 1) {
      if (tokens[body].value !== '{' || !braces.has(body)) continue;
      const method = methodName(tokens, body, parentheses);
      if (method && braces.get(body) <= range.close) {
        metrics.push(symbol('method', method.name, method.start, tokens[braces.get(body)]));
      }
    }
  }
  return metrics;
}

function swiftFunctions(tokens, braces, parentheses) {
  const metrics = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== 'func') continue;
    const body = functionBody(tokens, index, parentheses);
    const close = braces.get(body);
    if (body >= 0 && close !== undefined) {
      metrics.push(symbol('function', declarationName(tokens, index, 'func'), tokens[index], tokens[close]));
    }
  }
  return metrics;
}

export function measureSourceSymbols(source, { language = 'javascript' } = {}) {
  const tokens = tokenizeSource(source, { language });
  const braces = pairedTokens(tokens, '{', '}');
  const parentheses = pairedTokens(tokens, '(', ')');
  const classes = classRanges(tokens, braces, language);
  const functions = language === 'swift'
    ? swiftFunctions(tokens, braces, parentheses)
    : javascriptFunctions(tokens, braces, parentheses, classes);
  return Object.freeze([...classes.map(({ metric }) => metric), ...functions]);
}

function collectSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSources(path);
    return ['.js', '.mjs', '.swift'].includes(extname(entry.name)) ? [path] : [];
  });
}

export function collectProductionSources(root) {
  return [
    join(root, 'src'),
    join(root, 'scripts'),
    join(root, 'native/pdfkit-helper/Sources'),
    join(root, 'native/plugin-worker/Sources'),
  ].flatMap(collectSources);
}

export function collectTestSources(root) {
  return collectSources(join(root, 'tests'));
}

export function sourceSymbolMetrics(path) {
  const language = extname(path) === '.swift' ? 'swift' : 'javascript';
  return measureSourceSymbols(readFileSync(path, 'utf8'), { language });
}
