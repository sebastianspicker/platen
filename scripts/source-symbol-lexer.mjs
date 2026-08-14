const REGEX_PREFIXES = new Set([
  '(', '[', '{', ',', ':', ';', '=', '==', '===', '!=', '!==', '!', '?', '=>',
  '+', '-', '*', '%', '&', '|', '^', '~', '<', '>', '<=', '>=', '&&', '||', '??',
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of',
]);

function identifierStart(character) {
  return /[A-Za-z_$]/u.test(character);
}

function identifierPart(character) {
  return /[A-Za-z0-9_$]/u.test(character);
}

function consumeQuoted(source, start, quote) {
  let index = start + quote.length;
  let lines = 0;
  while (index < source.length) {
    if (source[index] === '\n') lines += 1;
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source.startsWith(quote, index)) return { index: index + quote.length, lines };
    index += 1;
  }
  return { index, lines };
}

function consumeBlockComment(source, start) {
  let index = start + 2;
  let depth = 1;
  let lines = 0;
  while (index < source.length && depth > 0) {
    if (source[index] === '\n') lines += 1;
    if (source.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (source.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return { index, lines };
}

function consumeRegex(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  let lines = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '\n') {
      lines += 1;
      break;
    }
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    else if (character === ']') inCharacterClass = false;
    else if (character === '/' && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1;
      break;
    }
    index += 1;
  }
  return { index, lines };
}

function regexCanStart(previous) {
  return !previous || REGEX_PREFIXES.has(previous.value);
}

function operatorAt(source, index) {
  return ['===', '!==', '>>>', '...', '=>', '==', '!=', '<=', '>=', '&&', '||',
    '??', '?.', '++', '--', '**', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']
    .find((operator) => source.startsWith(operator, index));
}

export function tokenizeSource(source, { language = 'javascript' } = {}) {
  const tokens = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      if (character === '\n') line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const consumed = consumeBlockComment(source, index);
      index = consumed.index;
      line += consumed.lines;
      continue;
    }
    const tripleQuote = language === 'swift' && source.startsWith('"""', index);
    if (tripleQuote || character === '"' || (language === 'javascript' && character === "'")) {
      const quote = tripleQuote ? '"""' : character;
      const consumed = consumeQuoted(source, index, quote);
      index = consumed.index;
      line += consumed.lines;
      continue;
    }
    if (language === 'javascript' && character === '`') {
      const consumed = consumeQuoted(source, index, '`');
      index = consumed.index;
      line += consumed.lines;
      continue;
    }
    const previous = tokens.at(-1);
    if (language === 'javascript' && character === '/' && regexCanStart(previous)) {
      const consumed = consumeRegex(source, index);
      index = consumed.index;
      line += consumed.lines;
      continue;
    }
    const start = index;
    if (identifierStart(character) || (character === '#' && identifierStart(source[index + 1] ?? ''))) {
      index += 1;
      while (identifierPart(source[index] ?? '')) index += 1;
    } else if (/[0-9]/u.test(character)) {
      index += 1;
      while (/[A-Za-z0-9_.]/u.test(source[index] ?? '')) index += 1;
    } else {
      const operator = operatorAt(source, index);
      index += operator?.length ?? 1;
    }
    tokens.push({ value: source.slice(start, index), line });
  }
  return tokens;
}

export function pairedTokens(tokens, openValue, closeValue) {
  const pairs = new Map();
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === openValue) stack.push(index);
    else if (tokens[index].value === closeValue && stack.length) {
      const open = stack.pop();
      pairs.set(open, index);
      pairs.set(index, open);
    }
  }
  return pairs;
}
