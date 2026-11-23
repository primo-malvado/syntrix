import assert from 'node:assert/strict';
import { test } from 'node:test';
import Lexer from '../src/client/classes/Lexer.js';
import { createEbnfLexer } from '../src/client/classes/EbnfLexer.js';

function createLexer () {
    const token = tokenType => lexer => ({ tokenType, content: lexer.yytext });
    return new Lexer({
        INITIAL: {
            table: [
                { from: '0', to: '1', _ft_: 'a', _tt_: 'a' },
                { from: '1', to: '2', _ft_: 'b', _tt_: 'b' },
                { from: '2', to: '3', _ft_: 'c', _tt_: 'c' },
                { from: '0', to: '4', _ft_: 'b', _tt_: 'b' },
                { from: '0', to: '5', _ft_: 'x', _tt_: 'x' }
            ],
            endMap: {
                '1': { parseFunction: token('A') },
                '3': { parseFunction: token('ABC') },
                '4': { parseFunction: token('B') },
                '5': { parseFunction: token('X') }
            }
        }
    });
}

test('rolls back to the last accepted token after an incomplete longer match', () => {
    for (const input of ['ab', 'abx']) {
        const lexer = createLexer();
        lexer.setInput(input);

        assert.deepEqual(lexer.popToken(), { tokenType: 'A', content: 'a', startPosition: 0, toPos: 1 });
        assert.deepEqual(lexer.popToken(), { tokenType: 'B', content: 'b', startPosition: 1, toPos: 2 });
        if (input === 'abx') {
            assert.deepEqual(lexer.popToken(), { tokenType: 'X', content: 'x', startPosition: 2, toPos: 3 });
        }
        assert.equal(lexer.popToken().tokenType, 'eof');
    }
});

test('keeps the longest complete match', () => {
    const lexer = createLexer();
    lexer.setInput('abc');
    assert.deepEqual(lexer.popToken(), { tokenType: 'ABC', content: 'abc', startPosition: 0, toPos: 3 });
    assert.equal(lexer.popToken().tokenType, 'eof');
});

test('preserves transition order when ranges overlap', () => {
    const lexer = new Lexer({
        INITIAL: {
            table: [
                { from: '0', to: '1', _ft_: 'a', _tt_: 'z' },
                { from: '0', to: '2', _ft_: 'a', _tt_: 'a' }
            ],
            endMap: { '1': { tokenType: 'FIRST' }, '2': { tokenType: 'SECOND' } }
        }
    });
    lexer.setInput('a');
    assert.equal(lexer.nextToken().tokenType, 'FIRST');
});

test('respects custom transition iterables and array iterators', () => {
    const lexer = createLexer();
    const original = lexer.transitionsFor;
    lexer.transitionsFor = function (state, from) {
        return new Set(original.call(this, state, from));
    };
    lexer.setInput('abc');
    assert.equal(lexer.nextToken().tokenType, 'ABC');

    lexer.transitionsFor = function (state, from) {
        const transitions = [...original.call(this, state, from)];
        transitions[Symbol.iterator] = function * () {
            yield * transitions.slice().reverse();
        };
        return transitions;
    };
    lexer.grammar.INITIAL.table.unshift({ from: '0', to: '5', _ft_: 'a', _tt_: 'a' });
    lexer.transitionIndex.clear();
    lexer.setInput('a');
    assert.equal(lexer.nextToken().tokenType, 'A');
});

test('keeps transition caches separate for arbitrary state and machine names', () => {
    const first = { from: 'Y\0Z', to: '1', _ft_: 'a', _tt_: 'a' };
    const second = { from: 'Z', to: '2', _ft_: 'b', _tt_: 'b' };
    const lexer = new Lexer({
        INITIAL: { table: [], endMap: {} },
        X: { table: [first], endMap: {} },
        'X\0Y': { table: [second], endMap: {} }
    });
    assert.deepEqual(lexer.transitionsFor('X', 'Y\0Z'), [first]);
    assert.deepEqual(lexer.transitionsFor('X\0Y', 'Z'), [second]);
    assert.throws(() => lexer.transitionsFor('MISSING', '0'), /unknown state/);
});

test('rolls back even when the accepted token has no callback', () => {
    const lexer = createLexer();
    lexer.grammar.INITIAL.endMap['1'] = { tokenType: 'A' };
    lexer.setInput('ab');

    const token = lexer.popToken();
    assert.equal(token.tokenType, 'A');
    assert.equal(token.content, 'a');
    assert.equal(lexer.popToken().content, 'b');
});

test('rejects an incomplete token at end of input instead of returning eof', () => {
    const lexer = new Lexer({
        INITIAL: {
            table: [{ from: '0', to: '1', _ft_: 'a', _tt_: 'a' }],
            endMap: {}
        }
    });
    lexer.setInput('a');
    assert.throws(() => lexer.popToken(), /lexer/i);
});

test('reports unexpected input at the beginning of a newline', () => {
    const lexer = new Lexer({ INITIAL: { table: [], endMap: {} } });
    lexer.setInput('\n');
    assert.throws(() => lexer.nextToken(), error =>
        error instanceof SyntaxError && error.position === 0 &&
        error.line === 1 && error.column === 1 && /1:1\n\n\^/.test(error.message));
});

test('supports nested lexer states and restores INITIAL after reset', () => {
    const lexer = new Lexer({
        INITIAL: {
            table: [{ from: '0', to: '1', _ft_: '<', _tt_: '<' }],
            endMap: {
                '1': {
                    parseFunction: current => {
                        current.pushState('TAG');
                        return { tokenType: 'OPEN', content: current.yytext };
                    }
                }
            }
        },
        TAG: {
            table: [{ from: '0', to: '1', _ft_: 'a', _tt_: 'z' }],
            endMap: { '1': { tokenType: 'NAME' } }
        }
    });

    lexer.setInput('<a');
    assert.equal(lexer.popToken().tokenType, 'OPEN');
    assert.equal(lexer.currentState(), 'TAG');
    assert.equal(lexer.popToken().tokenType, 'NAME');
    assert.equal(lexer.popState(), 'TAG');
    assert.equal(lexer.currentState(), 'INITIAL');

    lexer.setInput('<');
    assert.equal(lexer.currentState(), 'INITIAL');
});

test('rejects unknown lexer states explicitly', () => {
    const lexer = new Lexer({ INITIAL: { table: [], endMap: {} } });
    assert.throws(() => lexer.pushState('MISSING'), /unknown state/i);
    assert.throws(() => lexer.popState(), /cannot pop/i);
});

test('matches Unicode code points while preserving UTF-16 positions', () => {
    const lexerTable = createEbnfLexer('EMOJI = "😀";', {
        tokens: ['EMOJI'],
        unicode: true
    });
    const lexer = new Lexer(lexerTable);
    lexer.setInput('😀');

    assert.deepEqual(lexer.popToken(), {
        tokenType: 'EMOJI',
        content: '😀',
        startPosition: 0,
        toPos: 2
    });
    assert.equal(lexer.popToken().tokenType, 'eof');
});

test('supports incremental input without emitting an undecidable token', () => {
    const lexer = new Lexer({
        INITIAL: {
            table: [
                { from: '0', to: '1', _ft_: 'a', _tt_: 'a' },
                { from: '1', to: '2', _ft_: 'b', _tt_: 'b' },
                { from: '0', to: '3', _ft_: ' ', _tt_: ' ' }
            ],
            endMap: {
                '2': { tokenType: 'AB' },
                '3': { tokenType: 'SPACE' }
            }
        }
    });

    lexer.setInput('', { final: false });
    lexer.appendInput('a');
    assert.equal(lexer.nextToken(), null);
    lexer.appendInput('b ');
    assert.deepEqual(lexer.nextToken(), {
        tokenType: 'AB',
        content: 'ab',
        parseFunction: undefined,
        startPosition: 0,
        pos: 2
    });
    assert.equal(lexer.nextToken(), null);
    lexer.finishInput();
    assert.deepEqual(lexer.nextToken(), {
        tokenType: 'SPACE',
        content: ' ',
        parseFunction: undefined,
        startPosition: 2,
        pos: 3
    });
    assert.equal(lexer.nextToken().tokenType, 'eof');
});

test('resumes long partial tokens without rescanning earlier chunks', () => {
    const table = createEbnfLexer('A = "a", { "a" };', { tokens: ['A'] });
    const lexer = new Lexer(table);
    const transitionsFor = lexer.transitionsFor.bind(lexer);
    let checks = 0;
    lexer.transitionsFor = (...args) => {
        checks++;
        return transitionsFor(...args);
    };
    lexer.setInput('', { final: false });
    for (let index = 0; index < 128; index++) {
        lexer.appendInput('a');
        assert.equal(lexer.nextToken(), null);
    }
    lexer.finishInput();
    assert.equal(lexer.nextToken().content, 'a'.repeat(128));
    assert.equal(lexer.nextToken().tokenType, 'eof');
    assert.ok(checks <= 256, `rescanned too many transitions: ${checks}`);
});

test('resumes a token across a split Unicode surrogate pair', () => {
    const table = createEbnfLexer('WORD = "a", "😀", "b";', {
        tokens: ['WORD'], unicode: true
    });
    const lexer = new Lexer(table);
    lexer.setInput('', { final: false });
    for (const chunk of ['a\uD83D', '\uDE00', 'b']) {
        lexer.appendInput(chunk);
        assert.equal(lexer.nextToken(), null);
    }
    lexer.finishInput();
    assert.deepEqual(lexer.nextToken(), {
        tokenType: 'WORD', content: 'a😀b', startPosition: 0, toPos: 4
    });
    assert.equal(lexer.nextToken().tokenType, 'eof');
});

test('preserves the last accepted token across an incomplete Unicode character', () => {
    const table = createEbnfLexer('A = "a"; AE = "a😀";', {
        tokens: ['A', 'AE'], unicode: true
    });
    const lexer = new Lexer(table);
    lexer.setInput('', { final: false });
    lexer.appendInput('a\uD83D');
    assert.equal(lexer.nextToken(), null);
    lexer.appendInput('x');
    assert.equal(lexer.nextToken().tokenType, 'A');
    assert.throws(() => lexer.nextToken(), error =>
        error instanceof SyntaxError && error.position === 1);
});

test('streaming matches complete lexing across chunk boundaries, states and discarded lines', () => {
    const word = '("a".."z" | "😀"), { "a".."z" | "😀" | "0".."9" }';
    const common = `WORD = ${word}; SPACE = " " | "\\n" | "\\t";`;
    const initial = createEbnfLexer(`${common} OPEN = "<";`, {
        tokens: ['WORD', 'SPACE', 'OPEN'],
        unicode: true,
        actions: {
            OPEN: lexer => {
                lexer.pushState('TAG');
                return { tokenType: 'OPEN', content: lexer.yytext };
            }
        }
    });
    const tag = createEbnfLexer(`${common} CLOSE = ">";`, {
        tokens: ['WORD', 'SPACE', 'CLOSE'],
        unicode: true,
        actions: {
            CLOSE: lexer => {
                lexer.popState();
                return { tokenType: 'CLOSE', content: lexer.yytext };
            }
        }
    });
    const grammar = { INITIAL: initial.INITIAL, TAG: tag.INITIAL };
    const scan = (input, chunks, discardConsumedInput) => {
        const lexer = new Lexer(grammar, { discardConsumedInput });
        const tokens = [];
        const consume = () => {
            let token;
            while ((token = lexer.nextToken()) !== null && token.tokenType !== 'eof') {
                tokens.push({
                    tokenType: token.tokenType,
                    content: token.content,
                    startPosition: token.startPosition,
                    endPosition: token.toPos ?? token.pos,
                    state: lexer.currentState()
                });
            }
        };
        try {
            lexer.setInput(chunks ? '' : input, { final: !chunks });
            if (chunks) {
                for (const chunk of chunks) {
                    lexer.appendInput(chunk);
                    consume();
                }
                lexer.finishInput();
            }
            consume();
            return { tokens, state: lexer.currentState() };
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            return {
                tokens,
                state: lexer.currentState(),
                error: { position: error.position, line: error.line, column: error.column }
            };
        }
    };
    const inputs = [
        '',
        `alpha😀12 <tag1> \n${'x'.repeat(150)}<😀x>\nend`,
        'alpha\n<😀x> ! trailing',
        'alpha\n<😀x! trailing',
        '\n<😀',
        '\uD83D'
    ];
    for (const input of inputs) {
        const expected = scan(input, null, false);
        const partitions = [1, 2, 3, 7, 64].map(size =>
            Array.from({ length: Math.ceil(input.length / size) }, (_, index) =>
                input.slice(index * size, (index + 1) * size)));
        for (let split = 1; split < input.length; split++) {
            partitions.push([input.slice(0, split), input.slice(split)]);
        }
        let seed = 0x12345678;
        for (let sample = 0; sample < 10; sample++) {
            const chunks = [];
            for (let offset = 0; offset < input.length;) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                const size = 1 + seed % 17;
                chunks.push(input.slice(offset, offset + size));
                offset += size;
            }
            partitions.push(chunks);
        }
        for (const chunks of partitions) {
            for (const discard of [false, true]) {
                assert.deepEqual(scan(input, chunks, discard), expected,
                    `input ${JSON.stringify(input)}, chunks ${chunks.map(chunk => chunk.length)}, discard ${discard}`);
            }
        }
    }
});

test('preserves rollback and invalidates partial tokens when lexer state changes', () => {
    const lexer = createLexer();
    lexer.setInput('', { final: false });
    lexer.appendInput('a');
    assert.equal(lexer.nextToken(), null);
    lexer.appendInput('b');
    assert.equal(lexer.nextToken(), null);
    lexer.appendInput('x');
    assert.equal(lexer.nextToken().tokenType, 'A');
    assert.equal(lexer.nextToken().tokenType, 'B');
    lexer.finishInput();
    assert.equal(lexer.nextToken().tokenType, 'X');

    lexer.setInput('', { final: false });
    lexer.appendInput('ab');
    assert.equal(lexer.nextToken(), null);
    lexer.finishInput();
    assert.equal(lexer.nextToken().tokenType, 'A');
    assert.equal(lexer.nextToken().tokenType, 'B');

    const stateful = new Lexer({
        INITIAL: {
            table: [{ from: '0', to: '1', _ft_: 'a', _tt_: 'a' }],
            endMap: { '1': { tokenType: 'INITIAL_A' } }
        },
        OTHER: {
            table: [{ from: '0', to: '1', _ft_: 'a', _tt_: 'a' }],
            endMap: { '1': { tokenType: 'OTHER_A' } }
        }
    });
    stateful.setInput('', { final: false });
    stateful.appendInput('a');
    assert.equal(stateful.nextToken(), null);
    stateful.pushState('OTHER');
    stateful.finishInput();
    assert.equal(stateful.nextToken().tokenType, 'OTHER_A');
});

test('can discard consumed lines while preserving absolute token and error positions', () => {
    const table = createEbnfLexer('A = "a"; NL = "\\n";', { tokens: ['A', 'NL'] });
    const lexer = new Lexer(table, { discardConsumedInput: true });
    lexer.setInput('', { final: false });
    let tokens = 0;
    for (let index = 0; index < 1000; index++) {
        lexer.appendInput('a\n');
        let token;
        while ((token = lexer.nextToken()) !== null) {
            assert.equal(token.startPosition, tokens++);
        }
        assert.ok(lexer.input.length <= 4);
    }
    lexer.appendInput('!');
    assert.equal(lexer.nextToken().tokenType, 'NL');
    assert.throws(() => lexer.nextToken(), error =>
        error instanceof SyntaxError && error.position === 2000 &&
        error.line === 1001 && error.column === 1 && /1001:1/.test(error.message));

    lexer.setInput('a');
    assert.equal(lexer.inputOffset, 0);
    assert.equal(lexer.popToken().startPosition, 0);
});
