import { parseEbnf } from './Ebnf.js';
import { createParser } from './GenerateLalrParser.js';

const parserTableCache = new Map();
const parserActionIds = new WeakMap();
const parserContextIds = new WeakMap();
let nextParserActionId = 0;
let nextParserContextId = 0;
const parserTableCacheLimit = 128;

function compileAction (source, context) {
    const references = [...source.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    const count = Math.max(0, ...references);
    const parameters = Array.from({ length: count }, (_, index) => `$${index + 1}`);
    const bindings = Object.keys(context)
        .filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
        .map(name => `const ${name} = context[${JSON.stringify(name)}];`)
        .join('\n');
    const body = `
        ${bindings}
        let $$;
        ${source}
        return $$;
    `;
    const implementation = new Function(...parameters, 'yytext', 'context', body);
    return args => implementation(
        ...args.slice(0, count).map(arg => arg?.rules ?? arg?.content),
        args.filter(arg => arg && Object.hasOwn(arg, 'content')).at(-1)?.content,
        context
    );
}

function parserContextId (context) {
    let id = parserContextIds.get(context);
    if (id === undefined) {
        id = ++nextParserContextId;
        parserContextIds.set(context, id);
    }
    return id;
}

function parserActionId (action) {
    let id = parserActionIds.get(action);
    if (id === undefined) {
        id = ++nextParserActionId;
        parserActionIds.set(action, id);
    }
    return id;
}

export const ebnfActions = {
    root: args => args[0].rules,
    emptyRepeat: () => [],
    emptyOptional: () => null,
    repeat: args => [...args[0].rules, args.slice(1)],
    sequence: args => args
};

export function compileEbnfGrammar (source, {
    start,
    tokens = [],
    actions = {},
    precedence = [],
    precedenceOverrides = {},
    ignoreTokens = [],
    actionContext = {},
    algorithm = 'lalr1'
} = {}) {
    if (!actionContext || typeof actionContext !== 'object') {
        throw new TypeError('actionContext must be an object');
    }
    const rules = parseEbnf(source);
    if (!rules.has(start)) throw new SyntaxError(`Unknown start rule ${start}`);
    if (!Array.isArray(tokens) || tokens.some(name => typeof name !== 'string') ||
        new Set(tokens).size !== tokens.length) {
        throw new TypeError('tokens must be a list of distinct token names');
    }
    const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype', 'eof']);
    for (const name of [...rules.keys(), ...tokens]) {
        if (reserved.has(name)) throw new SyntaxError(`Reserved symbol ${name}`);
    }
    for (const name of tokens) {
        if (rules.has(name)) throw new SyntaxError(`Token conflicts with grammar rule ${name}`);
    }
    for (const name of Object.keys(actions)) {
        if (!rules.has(name) || !Array.isArray(actions[name]) ||
            actions[name].length !== rules.get(name).choices.length ||
            Array.from(actions[name]).some(action => typeof action !== 'function')) {
            throw new TypeError(`Expected one action per alternative for ${name}`);
        }
    }
    if (!Array.isArray(precedence) || !Array.isArray(ignoreTokens)) {
        throw new TypeError('precedence and ignoreTokens must be arrays');
    }
    const precedenceTokens = new Set();
    const precedenceLocations = new Map();
    for (const level of precedence) {
        if (!level || !['left', 'right', 'nonassoc'].includes(level.type) ||
            !Array.isArray(level.tokens) ||
            level.tokens.some(token => typeof token !== 'string')) {
            throw new TypeError('Precedence levels must contain valid associativity and token lists');
        }
        level.tokens.forEach(token => {
            if (precedenceTokens.has(token)) {
                throw new SyntaxError(`Token ${token} appears in multiple precedence levels`);
            }
            precedenceTokens.add(token);
            precedenceLocations.set(token, level.type);
        });
    }
    if (ignoreTokens.some(token => typeof token !== 'string')) {
        throw new TypeError('ignoreTokens must contain only token names');
    }
    for (const [name, overrides] of Object.entries(precedenceOverrides)) {
        if (!rules.has(name) || !overrides || typeof overrides !== 'object') {
            throw new TypeError(`Invalid precedence overrides for ${name}`);
        }
        for (const [index, token] of Object.entries(overrides)) {
            if (!/^(0|[1-9]\d*)$/.test(index) || Number(index) >= rules.get(name).choices.length ||
                !precedenceTokens.has(token)) {
                throw new TypeError(`Invalid precedence override for ${name} alternative ${index}`);
            }
        }
    }

    const nullable = new Set();
    function isNullable (node) {
        switch (node.type) {
        case 'literal': return node.value === '';
        case 'name': return nullable.has(node.value);
        case 'sequence': return node.items.every(isNullable);
        case 'alternatives': return node.choices.some(isNullable);
        case 'group': return isNullable(node.expression);
        case 'optional':
        case 'repeat': return true;
        case 'range': return false;
        default: throw new Error(`Unknown EBNF expression ${node.type}`);
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, expression] of rules) {
            if (!nullable.has(name) && isNullable(expression)) {
                nullable.add(name);
                changed = true;
            }
        }
    }

    const states = {};
    const used = new Set([...rules.keys(), ...tokens, ...reserved]);
    function reserveLiterals (node) {
        if (node.type === 'literal' && node.value) used.add(node.value);
        if (node.items) node.items.forEach(reserveLiterals);
        if (node.choices) node.choices.forEach(reserveLiterals);
        if (node.expression) reserveLiterals(node.expression);
    }
    for (const expression of rules.values()) reserveLiterals(expression);
    let nextId = 0;
    function helperName () {
        let name;
        do {
            name = `__ebnf_${nextId++}`;
        } while (used.has(name));
        used.add(name);
        return name;
    }
    const root = helperName();
    states[root] = { rules: [{ rule: [start], action: ebnfActions.root }] };
    for (const name of rules.keys()) states[name] = { rules: [] };

    function sequence (node) {
        return node.items.flatMap(item => lower(item));
    }
    function lower (node) {
        switch (node.type) {
        case 'name':
            if (!rules.has(node.value) && !tokens.includes(node.value)) {
                throw new SyntaxError(`Unknown grammar symbol ${node.value}`);
            }
            return [node.value];
        case 'literal':
            if (reserved.has(node.value) || rules.has(node.value)) {
                throw new SyntaxError(`Literal conflicts with a grammar symbol: ${node.value}`);
            }
            return node.value === '' ? [] : [node.value];
        case 'range':
            throw new SyntaxError('Character ranges are only supported in lexical rules');
        case 'group':
        case 'optional':
        case 'repeat': {
            if (node.type === 'repeat' && isNullable(node.expression)) {
                throw new SyntaxError('A repeated expression cannot match empty input');
            }
            const name = helperName();
            const productions = [];
            if (node.type !== 'group') {
                productions.push({
                    rule: [],
                    action: node.type === 'repeat' ? ebnfActions.emptyRepeat : ebnfActions.emptyOptional
                });
            }
            for (const choice of node.expression.choices) {
                const body = sequence(choice);
                if (node.type === 'repeat') {
                    productions.push({
                        rule: [name, ...body],
                        action: ebnfActions.repeat
                    });
                } else {
                    productions.push({ rule: body, action: ebnfActions.sequence });
                }
            }
            states[name] = { rules: productions };
            return [name];
        }
        default:
            throw new Error(`Unknown EBNF expression ${node.type}`);
        }
    }

    for (const [name, expression] of rules) {
        expression.choices.forEach((choice, index) => {
            const embeddedAction = rules.actions?.get(name)?.get(index);
            const action = actions[name]?.[index] ||
                (embeddedAction ? compileAction(embeddedAction, actionContext) : ebnfActions.sequence);
            const production = { rule: sequence(choice), action };
            if (precedenceOverrides[name]?.[index] !== undefined) {
                production.prec = precedenceOverrides[name][index];
            }
            states[name].rules.push(production);
        });
    }

    const reachable = new Set([root]);
    const pending = [root];
    while (pending.length) {
        const current = pending.pop();
        for (const production of states[current].rules) {
            for (const symbol of production.rule) {
                if (states[symbol] && !reachable.has(symbol)) {
                    reachable.add(symbol);
                    pending.push(symbol);
                }
            }
        }
    }
    const unreachable = [...rules.keys()].filter(name => !reachable.has(name));
    const usedTerminals = new Set();
    for (const [name, definition] of Object.entries(states)) {
        if (!reachable.has(name)) continue;
        for (const production of definition.rules) {
            production.rule.forEach(symbol => {
                if (!states[symbol]) usedTerminals.add(symbol);
            });
        }
    }
    const diagnostics = unreachable.map(name => ({
        severity: 'warning',
        code: 'UNREACHABLE_RULE',
        message: `Grammar rule ${name} is unreachable`,
        rule: name
    }));
    for (const token of tokens) {
        if (!usedTerminals.has(token)) {
            diagnostics.push({
                severity: 'warning',
                code: 'UNUSED_TOKEN',
                message: `Token ${token} is declared but never used`,
                token
            });
        }
    }
    for (const token of precedenceTokens) {
        if (!usedTerminals.has(token)) {
            diagnostics.push({
                severity: 'warning',
                code: 'UNUSED_PRECEDENCE',
                message: `Precedence for ${token} has no effect because the token is unused`,
                token,
                associativity: precedenceLocations.get(token)
            });
        }
    }
    return {
        start: root,
        states,
        precedence,
        ignoreTokens,
        diagnostics,
        algorithm
    };
}

export function createEbnfParser (source, options) {
    const {
        start,
        tokens = [],
        actions = {},
        precedence = [],
        precedenceOverrides = {},
        ignoreTokens = [],
        actionContext = {},
        algorithm = 'lalr1'
    } = options || {};
    const cacheKey = JSON.stringify([
        source,
        start,
        tokens,
        Object.keys(actions).sort().map(name => [
            name,
            actions[name].map(parserActionId)
        ]),
        precedence,
        precedenceOverrides,
        ignoreTokens,
        parserContextId(actionContext),
        algorithm
    ]);
    const cached = parserTableCache.get(cacheKey);
    if (cached) return cached;
    if (parserTableCache.size >= parserTableCacheLimit) {
        parserTableCache.delete(parserTableCache.keys().next().value);
    }
    const table = createParser(compileEbnfGrammar(source, options));
    parserTableCache.set(cacheKey, table);
    return table;
}
