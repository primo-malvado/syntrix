import { parseEbnf } from './Ebnf.js';
import { determinize } from './StateMachineDependency/Determinizer.js';
import { grammarMixer } from './GrammarMixer.js';

const lexerTableCache = new Map();
const lexerActionIds = new WeakMap();
let nextLexerActionId = 0;
const lexerTableCacheLimit = 128;

function lexerActionId (action) {
    let id = lexerActionIds.get(action);
    if (id === undefined) {
        id = ++nextLexerActionId;
        lexerActionIds.set(action, id);
    }
    return id;
}

function cacheLexerTable (key, table) {
    if (lexerTableCache.size >= lexerTableCacheLimit) {
        lexerTableCache.delete(lexerTableCache.keys().next().value);
    }
    lexerTableCache.set(key, table);
    return table;
}

export function createEbnfLexer (source, { tokens, actions = {}, unicode = false }) {
    const cacheKey = JSON.stringify([source, tokens, unicode,
        Object.keys(actions).sort().map(name => [name, lexerActionId(actions[name])])]);
    const cached = lexerTableCache.get(cacheKey);
    if (cached) return cached;
    const rules = parseEbnf(source);
    if (!Array.isArray(tokens) || !tokens.length || tokens.some(name => typeof name !== 'string' ||
        name in Object.prototype || name === 'eof') || new Set(tokens).size !== tokens.length) {
        throw new TypeError('tokens must be a non-empty list of distinct lexical rule names');
    }
    for (const name of Object.keys(actions)) {
        if (!tokens.includes(name) || typeof actions[name] !== 'function') {
            throw new TypeError(`Invalid lexical action for ${name}`);
        }
    }

    function validate (node, visiting) {
        if (node.type === 'name') {
            if (!rules.has(node.value)) throw new SyntaxError(`Unknown lexical rule ${node.value}`);
            if (visiting.has(node.value)) throw new SyntaxError(`Recursive lexical rule ${node.value}`);
            validate(rules.get(node.value), new Set([...visiting, node.value]));
        }
        if (node.type === 'literal' && node.value.includes('ε')) {
            throw new SyntaxError('The epsilon character is reserved in lexical rules');
        }
        if (node.type === 'range' && node.from <= 'ε' && node.to >= 'ε') {
            throw new SyntaxError('Lexical ranges cannot contain the reserved epsilon character');
        }
        if (node.items) node.items.forEach(item => validate(item, visiting));
        if (node.choices) node.choices.forEach(choice => validate(choice, visiting));
        if (node.expression) validate(node.expression, visiting);
    }
    for (const [name, expression] of rules) validate(expression, new Set([name]));

    function machine (name) {
        let nextId = 0;
        const table = [];
        const state = () => String(nextId++);
        const start = state();
        const end = state();
        const edge = (from, to, first, last = first) => table.push({ from, to, _ft_: first, _tt_: last });

        function build (node, from, to) {
            switch (node.type) {
            case 'name': {
                build(rules.get(node.value), from, to);
                break;
            }
            case 'literal':
                if (!node.value.length) {
                    edge(from, to, 'ε');
                } else {
                    let current = from;
                    const characters = unicode ? [...node.value] : node.value.split('');
                    for (let i = 0; i < characters.length; i++) {
                        const next = i === characters.length - 1 ? to : state();
                        edge(current, next, characters[i]);
                        current = next;
                    }
                }
                break;
            case 'range':
                edge(from, to, node.from, node.to);
                break;
            case 'sequence': {
                let current = from;
                node.items.forEach((item, index) => {
                    const next = index === node.items.length - 1 ? to : state();
                    build(item, current, next);
                    current = next;
                });
                break;
            }
            case 'alternatives':
                node.choices.forEach(choice => build(choice, from, to));
                break;
            case 'group':
                build(node.expression, from, to);
                break;
            case 'optional':
                edge(from, to, 'ε');
                build(node.expression, from, to);
                break;
            case 'repeat': {
                const loopStart = state();
                const loopEnd = state();
                edge(from, to, 'ε');
                edge(from, loopStart, 'ε');
                build(node.expression, loopStart, loopEnd);
                edge(loopEnd, loopStart, 'ε');
                edge(loopEnd, to, 'ε');
                break;
            }
            default:
                throw new Error(`Unknown EBNF expression ${node.type}`);
            }
        }

        if (!rules.has(name)) throw new SyntaxError(`Unknown lexical token ${name}`);
        build(rules.get(name), start, end);
        const reached = new Set([start]);
        const pending = [start];
        while (pending.length) {
            const current = pending.pop();
            for (const jump of table) {
                if (jump.from === current && jump._ft_ === 'ε' && jump._tt_ === 'ε' && !reached.has(jump.to)) {
                    reached.add(jump.to);
                    pending.push(jump.to);
                }
            }
        }
        if (reached.has(end)) throw new SyntaxError(`Lexical token ${name} can match empty input`);
        return { start: [start], end: [end], table };
    }

    const list = tokens.map(name => ({
        tokenType: name,
        sm: machine(name),
        parseFunction: actions[name] || (lexer => ({ tokenType: name, content: lexer.yytext }))
    }));
    return cacheLexerTable(cacheKey, { INITIAL: { ...determinize(grammarMixer(list)), unicode } });
}
