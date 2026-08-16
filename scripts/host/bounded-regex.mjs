const META = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
const ESCAPABLE = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '-']);
const MAX_REPEAT = 200;
const MAX_STATES = 1_024;

function invalid() { throw new TypeError('Pattern uses unsupported or unbounded regular-expression syntax.'); }
function ascii(value) { return value >= ' ' && value <= '~'; }
function lower(value, ignoreCase) { return ignoreCase ? value.toLowerCase() : value; }

class Parser {
  #source;
  #index = 0;

  constructor(source, maximum, allowEmpty) {
    if (typeof source !== 'string' || (!allowEmpty && source.length < 1) || source.length > maximum) invalid();
    this.#source = source;
  }

  parse() {
    const expression = this.#alternation();
    if (this.#index !== this.#source.length) invalid();
    return expression;
  }

  #peek() { return this.#source[this.#index]; }
  #take() { return this.#source[this.#index++]; }

  #alternation() {
    const branches = [this.#sequence()];
    while (this.#peek() === '|') { this.#take(); branches.push(this.#sequence()); }
    return branches.length === 1 ? branches[0] : { type: 'alternation', branches };
  }

  #sequence() {
    const terms = [];
    while (this.#index < this.#source.length && ![')', '|'].includes(this.#peek())) terms.push(this.#term());
    return { type: 'sequence', terms };
  }

  #term() {
    let atom = this.#atom();
    const quantifier = this.#quantifier();
    if (quantifier) {
      if (atom.type === 'anchor' || this.#containsQuantifier(atom)) invalid();
      atom = { type: 'quantified', atom, ...quantifier };
    }
    return atom;
  }

  #atom() {
    const character = this.#take();
    if (!ascii(character)) invalid();
    if (character === '(') {
      const expression = this.#alternation();
      if (this.#take() !== ')') invalid();
      return expression;
    }
    if (character === '[') return this.#characterClass();
    if (character === '\\') return this.#escape();
    if (character === '.') return { type: 'any' };
    if (character === '^' || character === '$') return { type: 'anchor', position: character };
    if (META.has(character)) invalid();
    return { type: 'literal', value: character };
  }

  #escape() {
    const character = this.#take();
    if (!character || !ascii(character)) invalid();
    if (['d', 'D', 's', 'S', 'w', 'W'].includes(character)) return { type: 'category', value: character };
    if (!ESCAPABLE.has(character)) invalid();
    return { type: 'literal', value: character };
  }

  #classAtom() {
    const character = this.#take();
    if (!character || !ascii(character)) invalid();
    if (character === '\\') return this.#escape();
    if (character === '[' || character === ']') invalid();
    return { type: 'literal', value: character };
  }

  #characterClass() {
    let negated = false;
    if (this.#peek() === '^') { this.#take(); negated = true; }
    const members = [];
    while (this.#peek() !== ']') {
      if (this.#index >= this.#source.length) invalid();
      const first = this.#classAtom();
      if (this.#peek() === '-' && this.#source[this.#index + 1] !== ']') {
        this.#take();
        const last = this.#classAtom();
        if (first.type !== 'literal' || last.type !== 'literal' || first.value > last.value) invalid();
        members.push({ type: 'range', from: first.value, to: last.value });
      } else members.push(first);
    }
    this.#take();
    if (!members.length) invalid();
    return { type: 'class', negated, members };
  }

  #quantifier() {
    const character = this.#peek();
    if (character === '*') { this.#take(); return { minimum: 0, maximum: null }; }
    if (character === '+') { this.#take(); return { minimum: 1, maximum: null }; }
    if (character === '?') { this.#take(); return { minimum: 0, maximum: 1 }; }
    if (character !== '{') return null;
    this.#take();
    const minimum = this.#count();
    let maximum = minimum;
    if (this.#peek() === ',') {
      this.#take();
      maximum = this.#peek() === '}' ? null : this.#count();
    }
    if (this.#take() !== '}' || minimum > MAX_REPEAT || (maximum !== null && (maximum < minimum || maximum > MAX_REPEAT))) invalid();
    return { minimum, maximum };
  }

  #count() {
    const start = this.#index;
    while (/[0-9]/.test(this.#peek() ?? '')) this.#take();
    if (start === this.#index) invalid();
    return Number(this.#source.slice(start, this.#index));
  }

  #containsQuantifier(node) {
    if (node.type === 'quantified') return true;
    if (node.type === 'sequence') return node.terms.some((term) => this.#containsQuantifier(term));
    return node.type === 'alternation' && node.branches.some((branch) => this.#containsQuantifier(branch));
  }
}

function matcherForCategory(category, value) {
  const code = value.charCodeAt(0);
  const digit = code >= 48 && code <= 57;
  const word = digit || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || value === '_';
  const space = value === ' ' || value === '\t' || value === '\n' || value === '\r' || value === '\f' || value === '\v';
  return category === 'd' ? digit : category === 'D' ? !digit : category === 's' ? space : category === 'S' ? !space : category === 'w' ? word : !word;
}

function classMatches(node, value, ignoreCase) {
  const candidate = lower(value, ignoreCase);
  const matches = node.members.some((member) => {
    if (member.type === 'category') return matcherForCategory(member.value, candidate);
    if (member.type === 'range') return candidate >= lower(member.from, ignoreCase) && candidate <= lower(member.to, ignoreCase);
    return candidate === lower(member.value, ignoreCase);
  });
  return node.negated ? !matches : matches;
}

function buildMachine(tree, ignoreCase) {
  const states = [];
  const state = () => {
    if (states.length >= MAX_STATES) invalid();
    const current = { edges: [] }; states.push(current); return states.length - 1;
  };
  const edge = (from, to, type, value = undefined) => states[from].edges.push({ to, type, value });
  const join = (left, right) => { edge(left.end, right.start, 'epsilon'); return { start: left.start, end: right.end }; };
  const compile = (node) => {
    if (node.type === 'sequence') {
      const empty = { start: state(), end: state() };
      edge(empty.start, empty.end, 'epsilon');
      return node.terms.reduce((fragment, term) => join(fragment, compile(term)), empty);
    }
    if (node.type === 'alternation') {
      const fragment = { start: state(), end: state() };
      for (const branch of node.branches) { const child = compile(branch); edge(fragment.start, child.start, 'epsilon'); edge(child.end, fragment.end, 'epsilon'); }
      return fragment;
    }
    if (node.type === 'quantified') {
      let fragment = { start: state(), end: state() };
      edge(fragment.start, fragment.end, 'epsilon');
      for (let count = 0; count < node.minimum; count += 1) fragment = join(fragment, compile(node.atom));
      if (node.maximum === null) {
        const child = compile(node.atom); const end = state(); edge(fragment.end, end, 'epsilon'); edge(fragment.end, child.start, 'epsilon'); edge(child.end, fragment.end, 'epsilon'); return { start: fragment.start, end };
      }
      for (let count = node.minimum; count < node.maximum; count += 1) {
        const child = compile(node.atom); const end = state(); edge(fragment.end, end, 'epsilon'); edge(fragment.end, child.start, 'epsilon'); edge(child.end, end, 'epsilon'); fragment = { start: fragment.start, end };
      }
      return fragment;
    }
    const fragment = { start: state(), end: state() };
    if (node.type === 'literal') edge(fragment.start, fragment.end, 'literal', lower(node.value, ignoreCase));
    else if (node.type === 'category') edge(fragment.start, fragment.end, 'category', node.value);
    else if (node.type === 'class') edge(fragment.start, fragment.end, 'class', node);
    else if (node.type === 'any') edge(fragment.start, fragment.end, 'any');
    else edge(fragment.start, fragment.end, node.position === '^' ? 'start' : 'end');
    return fragment;
  };
  const root = compile(tree);
  return { states, start: root.start, end: root.end, ignoreCase };
}

function findMachine(machine, input, from = 0) {
  if (!Number.isSafeInteger(from) || from < 0 || from > input.length) return null;
  const close = (initial, position) => {
    const closed = new Map(initial); const queue = [...closed.keys()];
    while (queue.length) {
      const current = queue.pop();
      for (const edge of machine.states[current].edges) {
        if (edge.type !== 'epsilon' && (edge.type !== 'start' || position !== 0) && (edge.type !== 'end' || position !== input.length)) continue;
        const origin = closed.get(current);
        if (!closed.has(edge.to) || origin < closed.get(edge.to)) { closed.set(edge.to, origin); queue.push(edge.to); }
      }
    }
    return closed;
  };
  let current = new Map(); let candidate = null;
  for (let index = from; index <= input.length; index += 1) {
    if (candidate && ![...current.values()].includes(candidate.start)) return candidate;
    current.set(machine.start, index); current = close(current, index);
    const acceptedStart = current.get(machine.end);
    if (acceptedStart !== undefined && acceptedStart < index && (!candidate || acceptedStart <= candidate.start)) {
      candidate = { start: acceptedStart, end: index };
    }
    if (index === input.length) break;
    const next = new Map(); const value = lower(input[index], machine.ignoreCase);
    for (const [currentState, origin] of current) {
      for (const edge of machine.states[currentState].edges) {
        const matches = (edge.type === 'literal' && value === edge.value)
          || (edge.type === 'category' && matcherForCategory(edge.value, value))
          || (edge.type === 'class' && classMatches(edge.value, value, machine.ignoreCase))
          || edge.type === 'any';
        if (matches && (!next.has(edge.to) || origin < next.get(edge.to))) next.set(edge.to, origin);
      }
    }
    current = close(next, index + 1);
  }
  return candidate;
}

function matchesEmpty(machine) {
  const closed = new Set([machine.start]); const queue = [machine.start];
  while (queue.length) {
    const current = queue.pop();
    for (const edge of machine.states[current].edges) {
      if (edge.type !== 'epsilon' && edge.type !== 'start' && edge.type !== 'end') continue;
      if (!closed.has(edge.to)) { closed.add(edge.to); queue.push(edge.to); }
    }
  }
  return closed.has(machine.end);
}

/** Compiles the bounded regex subset to a Thompson NFA, never to the backtracking RegExp engine. */
export function compileBoundedRegex(source, { maximum = 128, ignoreCase = false, allowEmpty = false } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200 || typeof ignoreCase !== 'boolean' || typeof allowEmpty !== 'boolean') invalid();
  const machine = buildMachine(new Parser(source, maximum, allowEmpty).parse(), ignoreCase);
  const empty = matchesEmpty(machine);
  return Object.freeze({
    source,
    find: (value, from = 0) => typeof value === 'string' ? findMachine(machine, value, from) : null,
    test: (value) => typeof value === 'string' && (empty || findMachine(machine, value) !== null),
  });
}
