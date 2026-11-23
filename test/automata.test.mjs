import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let cacheDir;
let regexToNfa;
let regexToDfa;
let determinize;

before(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'parser-vite-test-'));
    server = await createServer({
        configFile: false,
        publicDir: false,
        cacheDir,
        server: { middlewareMode: true, hmr: false, ws: false },
        appType: 'custom'
    });
    ({ default: regexToNfa } = await server.ssrLoadModule('/src/client/classes/RegexToNfa.js'));
    ({ default: regexToDfa } = await server.ssrLoadModule('/src/client/classes/RegexToDfa.js'));
    ({ determinize } = await server.ssrLoadModule('/src/client/classes/StateMachineDependency/Determinizer.js'));
});

after(async () => {
    if (server) {
        await server.close();
    }
    if (cacheDir) {
        await rm(cacheDir, { recursive: true, force: true });
    }
});

function epsilonClosure (machine, states) {
    const reached = new Set(states);
    const pending = [...states];
    while (pending.length) {
        const state = pending.pop();
        for (const edge of machine.table) {
            if (edge.from === state && edge._ft_ === 'ε' && edge._tt_ === 'ε' && !reached.has(edge.to)) {
                reached.add(edge.to);
                pending.push(edge.to);
            }
        }
    }
    return reached;
}

function accepts (machine, text) {
    let states = epsilonClosure(machine, machine.start);
    for (const character of text) {
        const next = new Set();
        for (const edge of machine.table) {
            if (states.has(edge.from) && edge._ft_ !== 'ε' &&
                edge._ft_ <= character && character <= edge._tt_) {
                next.add(edge.to);
            }
        }
        states = epsilonClosure(machine, next);
    }
    return machine.end.some(state => states.has(state));
}

function samples (alphabet, maxLength) {
    let current = [''];
    const result = [...current];
    for (let length = 1; length <= maxLength; length++) {
        current = current.flatMap(prefix => alphabet.map(character => prefix + character));
        result.push(...current);
    }
    return result;
}

test('determinizes epsilon cycles and overlapping character ranges', () => {
    const nfa = {
        start: ['0'],
        end: ['3', '4'],
        table: [
            { from: '0', to: '1', _ft_: 'ε', _tt_: 'ε' },
            { from: '1', to: '0', _ft_: 'ε', _tt_: 'ε' },
            { from: '0', to: '2', _ft_: 'a', _tt_: 'c' },
            { from: '1', to: '3', _ft_: 'b', _tt_: 'd' },
            { from: '2', to: '4', _ft_: 'x', _tt_: 'x' }
        ]
    };
    const dfa = determinize(nfa);

    for (const input of samples(['a', 'b', 'c', 'd', 'x'], 2)) {
        assert.equal(accepts(dfa, input), accepts(nfa, input), JSON.stringify(input));
    }
    assert.equal(accepts(dfa, 'b'), true);
    assert.equal(accepts(dfa, 'ax'), true);
    assert.equal(accepts(dfa, 'a'), false);
    for (const state of new Set(dfa.table.map(edge => edge.from))) {
        for (const character of ['a', 'b', 'c', 'd', 'x']) {
            assert.ok(dfa.table.filter(edge => edge.from === state &&
                edge._ft_ <= character && character <= edge._tt_).length <= 1);
        }
    }
});

test('keeps the highest-priority lexer action for overlapping matches', () => {
    const first = () => ({ tokenType: 'FIRST' });
    const second = () => ({ tokenType: 'SECOND' });
    const dfa = determinize({
        start: ['0'],
        end: ['1', '2'],
        endMap: {
            '1': { priority: 1, parseFunction: second },
            '2': { priority: 0, parseFunction: first }
        },
        table: [
            { from: '0', to: '1', _ft_: 'a', _tt_: 'c' },
            { from: '0', to: '2', _ft_: 'b', _tt_: 'd' }
        ]
    });
    const stateFor = character => dfa.table.find(edge => edge.from === dfa.start[0] &&
        edge._ft_ <= character && character <= edge._tt_).to;

    assert.equal(dfa.endMap[stateFor('a')].parseFunction, second);
    assert.equal(dfa.endMap[stateFor('b')].parseFunction, first);
    assert.equal(dfa.endMap[stateFor('d')].parseFunction, first);
});

test('regex conversion preserves accepted and rejected strings', () => {
    const cases = [
        { regex: 'a(b|c)*', alphabet: ['a', 'b', 'c', 'x'] },
        { regex: '[a-c]+d?', alphabet: ['a', 'b', 'c', 'd', 'x'] },
        { regex: '(a|b)*', alphabet: ['a', 'b', 'x'] }
    ];

    for (const { regex, alphabet } of cases) {
        const nfa = regexToNfa(regex);
        const dfa = regexToDfa(regex);
        const reference = new RegExp(`^(?:${regex})$`);

        for (const input of samples(alphabet, 3)) {
            const expected = reference.test(input);
            for (const [label, machine] of [['NFA', nfa], ['DFA', dfa]]) {
                assert.equal(accepts(machine, input), expected, `${label} ${regex}: ${JSON.stringify(input)}`);
            }
        }
    }
});
