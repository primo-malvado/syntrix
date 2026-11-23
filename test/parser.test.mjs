import assert from 'node:assert/strict';
import { test } from 'node:test';
import Lexer from '../src/client/classes/Lexer.js';
import Parser from '../src/client/classes/Parser.js';
import { createParser, ParserConflictError } from '../src/client/classes/GenerateLalrParser.js';
import { createEbnfLexer } from '../src/client/classes/EbnfLexer.js';
import { createEbnfParser } from '../src/client/classes/EbnfParser.js';
import expandTable from '../src/client/misc/expandTable.js';
import { config as regexConfig } from '../src/client/classes/regexConfig.js';

function expressionFixture () {
    const lexerRules = createEbnfLexer(`
        NUMBER = "0".."9", { "0".."9" };
        PLUS = "+";
        STAR = "*";
        LP = "(";
        RP = ")";
        SPACE = " ", { " " };
    `, { tokens: ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP', 'SPACE'] });
    const parserRules = createEbnfParser(`
        entry = expr;
        expr = expr, PLUS, expr | expr, STAR, expr | LP, expr, RP | NUMBER;
    `, {
        start: 'entry',
        tokens: ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP', 'SPACE'],
        ignoreTokens: ['SPACE'],
        precedence: [
            { type: 'left', tokens: ['PLUS'] },
            { type: 'left', tokens: ['STAR'] }
        ],
        actions: {
            entry: [args => args[0].rules],
            expr: [
                args => args[0].rules + args[2].rules,
                args => args[0].rules * args[2].rules,
                args => args[1].rules,
                args => Number(args[0].content)
            ]
        }
    });
    return { lexerRules, parserRules };
}

test('generates and parses expressions with precedence and reusable parser state', () => {
    const { lexerRules, parserRules } = expressionFixture();
    const parser = new Parser(new Lexer(lexerRules), parserRules);
    assert.equal(parser.parse('3 + 2 * 4'), 11);
    assert.equal(parser.parse(' ( 7 ) '), 7);
});

test('parses an empty production', () => {
    const lexerRules = createEbnfLexer('LP = "("; RP = ")";', { tokens: ['LP', 'RP'] });
    const parserRules = createEbnfParser('entry = LP, RP;', {
        start: 'entry',
        tokens: ['LP', 'RP'],
        actions: { entry: [() => []] }
    });
    const parser = new Parser(new Lexer(lexerRules), parserRules);
    assert.deepEqual(parser.parse('()'), []);
});

test('provides a uniform value on lexical and reduced tokens', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const lexer = new Lexer(lexerTable);
    lexer.setInput('a');
    const token = lexer.nextToken();
    assert.equal(token.value, token.content);

    let reduction;
    const parser = new Parser(new Lexer(lexerTable), createEbnfParser('entry = A;', {
        start: 'entry',
        tokens: ['A'],
        actions: {
            entry: [args => (reduction = { input: args[0].value })]
        }
    }));
    assert.deepEqual(parser.parse('a'), { input: 'a' });
    assert.deepEqual(reduction, { input: 'a' });
    assert.equal(parser.stack[0].value, parser.stack[0].rules);
});

test('preserves child order and the remaining stack during a multi-symbol reduction', () => {
    const tokens = ['P', 'A', 'B', 'C', 'D', 'E', 'END'];
    const lexerTable = createEbnfLexer(`
        P = "p"; A = "a"; B = "b"; C = "c"; D = "d"; E = "e"; END = "!";
    `, { tokens });
    let parser;
    const config = createEbnfParser('entry = P, group, END; group = A, B, C, D, E;', {
        start: 'entry',
        tokens,
        actions: {
            entry: [args => args[1].rules],
            group: [args => {
                assert.deepEqual(parser.stack.map(token => token.tokenType), ['P']);
                return args.map(token => token.content).join('');
            }]
        }
    });
    parser = new Parser(new Lexer(lexerTable), config);
    assert.equal(parser.parse('pabcde!'), 'abcde');
});

test('preserves parser state across nested and nullable incremental reductions', () => {
    const tokens = ['LP', 'RP', 'A', 'BAD'];
    const lexerTable = createEbnfLexer('LP = "("; RP = ")"; A = "a"; BAD = "!";', { tokens });
    const grammar = 'entry = LP, entry, RP | A | "";';
    const options = {
        start: 'entry',
        tokens,
        actions: {
            entry: [args => args[1].rules + 1, () => 0, () => 0]
        }
    };
    for (const algorithm of ['slr1', 'lalr1', 'lr1']) {
        const parser = new Parser(new Lexer(lexerTable), createEbnfParser(grammar, {
            ...options, algorithm
        }));
        const input = `${'('.repeat(500)}a${')'.repeat(500)}`;
        assert.equal(parser.parse(input), 500);
        assert.equal(parser.parse(''), 0);
        parser.start();
        parser.push('((a');
        parser.push('))');
        assert.equal(parser.actualState(), parser._actualState);
        assert.equal(parser.finish(), 2);
        assert.equal(parser.parse('()'), 1);
        assert.throws(() => parser.parse('(a'), SyntaxError);
        assert.equal(parser.parse('a'), 0);

        const recovery = new Parser(new Lexer(lexerTable), {
            ...createEbnfParser(grammar, { ...options, algorithm }),
            recoverErrors: true
        });
        assert.equal(recovery.parse('((a!))'), 2);
        assert.equal(recovery.errors.length, 1);
        assert.equal(recovery.errors[0].token.tokenType, 'BAD');
        assert.equal(recovery.parse('a'), 0);
        assert.equal(recovery.errors.length, 0);
    }
});

test('reports invalid deterministic reductions and goto transitions', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const parser = new Parser(new Lexer(lexerTable), {
        table: { 0: { A: [0, 1] }, 1: { eof: [1, 0] } },
        states: [{ create: 'entry', base: ['A'] }]
    });
    assert.throws(() => parser.parse('a'), /invalid goto for entry in state 0/);

    const underflow = new Parser(new Lexer(lexerTable), {
        table: { 0: { eof: [1, 0] } },
        states: [{ create: 'entry', base: ['A'] }]
    });
    assert.throws(() => underflow.parse(''), /invalid reduction for entry/);

    const invalidAccept = new Parser(new Lexer(lexerTable), {
        table: { 0: { eof: [2, 0] } },
        states: [{ create: 'entry', base: ['A'] }]
    });
    assert.throws(() => invalidAccept.parse(''), /invalid reduction for entry/);
});

test('parses regex rules from the internal grammar', () => {
    const parser = new Parser(new Lexer(regexConfig.lexerTable), regexConfig.parserTable);
    const result = parser.parse('[a-z]+');

    assert.equal(result.tokenType, 'concat');
    assert.equal(result.rules[0].tokenType, 'plus');
    assert.equal(result.rules[0].rules[0].tokenType, 'range');
    assert.deepEqual(result.rules[0].rules[0].rules.map(token => token.content), ['a', 'z']);
});

test('reports unexpected tokens and end of input with positions and expected terminals', () => {
    const { lexerRules, parserRules } = expressionFixture();
    const parser = new Parser(new Lexer(lexerRules), parserRules);

    for (const [input, token, position] of [['3 4', 'NUMBER', 2], ['3 +', 'eof', 3]]) {
        assert.throws(() => parser.parse(input), error => {
            assert.ok(error instanceof SyntaxError);
            assert.match(error.message, new RegExp(token));
            assert.match(error.message, new RegExp(`position ${position}`));
            assert.match(error.message, /expected/i);
            assert.match(error.message, /\n.*\n\s*\^/);
            assert.doesNotMatch(error.message, /\bexpr\b/);
            return true;
        });
    }
});

test('reports newline and tab locations and excludes explicit error actions from expected tokens', () => {
    const tokens = ['A', 'NL', 'TAB'];
    const lexerTable = createEbnfLexer('A = "a"; NL = "\\n"; TAB = "\\t";', { tokens });
    const config = createEbnfParser('entry = A;', { start: 'entry', tokens });
    const parser = new Parser(new Lexer(lexerTable), config);
    assert.throws(() => parser.parse('\n'), error =>
        error instanceof SyntaxError && error.position === 0 &&
        error.line === 1 && error.column === 1 && /1:1\n\n\^/.test(error.message));
    const tabParser = new Parser(new Lexer(lexerTable), { ...config, ignoreTokens: ['TAB'] });
    assert.throws(() => tabParser.parse('\t\n'), error =>
        error instanceof SyntaxError && error.position === 1 &&
        error.line === 1 && error.column === 2 && /1:2\n\t\n\t\^/.test(error.message));

    const errorParser = new Parser(new Lexer(lexerTable), {
        table: { 0: { A: [3, 0], NL: [0, 1] } },
        states: [{ create: 'entry', base: ['NL'] }]
    });
    assert.throws(() => errorParser.parse('a'), error =>
        error instanceof SyntaxError && !error.expected.includes('A') && error.expected.includes('NL'));
});

test('GLR expected tokens include actions from every active branch', () => {
    const lexerTable = createEbnfLexer('A = "a"; B = "b"; X = "x";', { tokens: ['A', 'B', 'X'] });
    const parser = new Parser(new Lexer(lexerTable), {
        algorithm: 'GLR',
        table: { 0: { A: [[0, 1], [0, 2]] }, 1: { X: [0, 3] }, 2: { X: [3, 0] } },
        states: [{ create: 'entry', base: [] }]
    });
    assert.throws(() => parser.parse('ab'), error =>
        error instanceof SyntaxError && error.expected.includes('X'));
});

test('reports parser conflicts with actionable metadata', () => {
    assert.throws(() => createParser({
        start: 'entry',
        precedence: [],
        ignoreTokens: [],
        states: {
            entry: {
                rules: [
                    { rule: ['entry', 'entry'] },
                    { rule: ['A'] }
                ]
            }
        }
    }), error => {
        assert.ok(error instanceof ParserConflictError);
        assert.equal(error.token, 'A');
        assert.match(error.message, /shift|reduce/);
        assert.notEqual(error.state, undefined);
        return true;
    });
});

test('accepts grammars that require LALR lookahead propagation', () => {
    const config = createParser({
        start: 'S',
        precedence: [],
        ignoreTokens: [],
        states: {
            S: {
                rules: [
                    { rule: ['a', 'A', 'd'] },
                    { rule: ['b', 'B', 'd'] },
                    { rule: ['a', 'A', 'e'] },
                    { rule: ['b', 'B', 'e'] }
                ]
            },
            A: { rules: [{ rule: ['c'] }] },
            B: { rules: [{ rule: ['c'] }] }
        }
    });
    assert.equal(config.algorithm, 'LALR(1)');
});

test('can generate canonical LR(1) tables without merging states', () => {
    const config = createParser({
        algorithm: 'lr1',
        start: 'S',
        precedence: [],
        ignoreTokens: [],
        states: {
            S: {
                rules: [
                    { rule: ['a', 'A', 'd'] },
                    { rule: ['b', 'B', 'd'] },
                    { rule: ['a', 'A', 'e'] },
                    { rule: ['b', 'B', 'e'] }
                ]
            },
            A: { rules: [{ rule: ['c'] }] },
            B: { rules: [{ rule: ['c'] }] }
        }
    });
    assert.equal(config.algorithm, 'LR(1)');
    assert.ok(Object.keys(config.table).length > 0);
});

test('can generate SLR(1) tables using FOLLOW sets', () => {
    const config = createParser({
        algorithm: 'slr1',
        start: 'entry',
        precedence: [],
        ignoreTokens: [],
        states: {
            entry: { rules: [{ rule: ['A'] }] }
        }
    });
    assert.equal(config.algorithm, 'SLR(1)');
    assert.ok(config.table[0].A);
});

test('distinguishes SLR conflicts from LALR and canonical LR(1)', () => {
    const grammar = `
        entry = left, EQ, right | right;
        left = STAR, right | ID;
        right = left;
    `;
    const tokens = ['ID', 'EQ', 'STAR'];
    const lexerTable = createEbnfLexer('ID = "i"; EQ = "="; STAR = "*";', { tokens });
    const options = { start: 'entry', tokens };
    assert.throws(() => createEbnfParser(grammar, {
        ...options, algorithm: 'slr1'
    }), ParserConflictError);
    const parsers = ['lalr1', 'lr1'].map(algorithm => new Parser(
        new Lexer(lexerTable), createEbnfParser(grammar, { ...options, algorithm })
    ));
    for (const input of ['i', '*i', 'i=i', '*i=i', 'i=*i']) {
        assert.deepEqual(parsers[0].parse(input), parsers[1].parse(input));
    }
    for (const input of ['', '=', 'i=', 'i=i=i']) {
        for (const parser of parsers) assert.throws(() => parser.parse(input), SyntaxError);
    }
});

test('distinguishes canonical LR(1) from LALR state merging', () => {
    const grammar = `
        entry = a, left, d | b, left, e | a, right, e | b, right, d;
        left = c;
        right = c;
    `;
    const tokens = ['a', 'b', 'c', 'd', 'e'];
    const lexerTable = createEbnfLexer('a = "a"; b = "b"; c = "c"; d = "d"; e = "e";', { tokens });
    const options = {
        start: 'entry',
        tokens,
        actions: {
            entry: [
                args => `a${args[1].rules}d`,
                args => `b${args[1].rules}e`,
                args => `a${args[1].rules}e`,
                args => `b${args[1].rules}d`
            ],
            left: [() => 'L'],
            right: [() => 'R']
        }
    };
    for (const algorithm of ['slr1', 'lalr1']) {
        assert.throws(() => createEbnfParser(grammar, { ...options, algorithm }), ParserConflictError);
    }
    const parser = new Parser(new Lexer(lexerTable), createEbnfParser(grammar, {
        ...options, algorithm: 'lr1'
    }));
    for (const [input, expected] of [['acd', 'aLd'], ['bce', 'bLe'], ['ace', 'aRe'], ['bcd', 'bRd']]) {
        assert.equal(parser.parse(input), expected);
    }
    for (const input of ['ac', 'acc', 'acdce']) assert.throws(() => parser.parse(input), SyntaxError);
});

test('keeps ambiguous alternatives in GLR mode', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser(`
        entry = entry, entry | A;
    `, {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: {
            entry: [
                args => ['join', args[0], args[1]],
                args => ['atom', args[0]]
            ]
        }
    });
    const results = new Parser(new Lexer(lexerTable), config).parse('aaa');
    assert.equal(config.algorithm, 'GLR');
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
});

test('preserves every GLR derivation even when semantic values coincide', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser('entry = entry, entry | A;', {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: { entry: [() => 1, () => 1] }
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    assert.deepEqual(parser.parse('aaaaa'), Array(14).fill(1));
    assert.equal(parser.parse('aaaaaaa').length, 132);
});

test('evaluates a GLR semantic action once per reduced value', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    let calls = 0;
    const config = createEbnfParser('entry = A;', {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: { entry: [args => (calls++, args[0].value)] }
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    assert.deepEqual(parser.parse('a'), ['a']);
    assert.equal(calls, 1);
});

test('GLR derivations and forests agree with an independent binary-tree oracle', () => {
    const lexerTable = createEbnfLexer('A = "a"; B = "b";', { tokens: ['A', 'B'] });
    const config = createEbnfParser('entry = entry, entry | A | B;', {
        start: 'entry',
        tokens: ['A', 'B'],
        algorithm: 'glr',
        actions: {
            entry: [
                args => `(${args[0].rules}${args[1].rules})`,
                args => args[0].content,
                args => args[0].content
            ]
        }
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    const forestParser = new Parser(new Lexer(lexerTable), { ...config, forest: true });
    const trees = input => {
        if (input.length === 1) return [input];
        const result = [];
        for (let split = 1; split < input.length; split++) {
            for (const left of trees(input.slice(0, split))) {
                for (const right of trees(input.slice(split))) result.push(`(${left}${right})`);
            }
        }
        return result.sort();
    };
    const countForest = (node, memo = new Map()) => {
        if (node.token) return 1;
        if (!memo.has(node)) {
            memo.set(node, node.alternatives.reduce((sum, alt) =>
                sum + alt.children.reduce((product, child) => product * countForest(child, memo), 1), 0));
        }
        return memo.get(node);
    };
    for (let length = 1; length <= 5; length++) {
        for (let bits = 0; bits < 2 ** length; bits++) {
            const input = Array.from({ length }, (_, index) => bits & (1 << index) ? 'b' : 'a').join('');
            const expected = trees(input);
            assert.deepEqual(parser.parse(input).sort(), expected, input);
            parser.start();
            for (const character of input) parser.push(character);
            assert.deepEqual(parser.finish().sort(), expected, `incremental ${input}`);
            assert.equal(countForest(forestParser.parse(input)), expected.length, `forest ${input}`);
        }
    }
    for (const input of ['', 'ab!', '!a']) {
        assert.throws(() => parser.parse(input), SyntaxError);
        assert.throws(() => forestParser.parse(input), SyntaxError);
    }
});

test('GLR handles combinations of nullable and ambiguous productions', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser('entry = part, part, part; part = "" | A | A, A;', {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: {
            entry: [args => args.map(arg => arg.rules).join(',')],
            part: [() => 0, () => 1, () => 2]
        }
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    const forest = new Parser(new Lexer(lexerTable), { ...config, forest: true });
    const expand = node => {
        if (node.token) return [node.token.content];
        return node.alternatives.flatMap(alternative => {
            let combinations = [[]];
            for (const child of alternative.children) {
                combinations = combinations.flatMap(prefix =>
                    expand(child).map(value => [...prefix, value]));
            }
            if (node.symbol === 'part') return combinations.map(children => children.length);
            if (node.symbol === 'entry') return combinations.map(children => children.join(','));
            assert.equal(node.symbol, config.states[0].create);
            return combinations.map(children => {
                assert.equal(children.length, 1);
                return children[0];
            });
        });
    };
    for (let length = 0; length <= 6; length++) {
        const expected = [];
        for (let first = 0; first <= 2; first++) {
            for (let second = 0; second <= 2; second++) {
                for (let third = 0; third <= 2; third++) {
                    if (first + second + third === length) expected.push(`${first},${second},${third}`);
                }
            }
        }
        const input = 'a'.repeat(length);
        expected.sort();
        assert.deepEqual(parser.parse(input).sort(), expected, input);
        parser.start();
        for (const character of input) parser.push(character);
        assert.deepEqual(parser.finish().sort(), expected, `incremental ${input}`);
        assert.deepEqual(expand(forest.parse(input)).sort(), expected, `forest ${input}`);
        forest.start();
        for (const character of input) forest.push(character);
        assert.deepEqual(expand(forest.finish()).sort(), expected, `incremental forest ${input}`);
    }
    assert.throws(() => parser.parse('aaaaaaa'), SyntaxError);
    assert.throws(() => forest.parse('aaaaaaa'), SyntaxError);
});

test('GLR forest mode packs ambiguous derivations without executing semantic actions', () => {
    let actions = 0;
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser('entry = entry, entry | A;', {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: { entry: [() => { actions++; }, () => { actions++; }] }
    });
    const parser = new Parser(new Lexer(lexerTable), { ...config, forest: true });
    parser.start();
    parser.push('aaaaaa');
    parser.push('aaaaaa');
    const root = parser.finish();
    const memo = new Map();
    const count = node => {
        if (node.token) return 1;
        if (!memo.has(node)) {
            memo.set(node, node.alternatives.reduce((sum, alt) =>
                sum + alt.children.reduce((product, child) => product * count(child), 1), 0));
        }
        return memo.get(node);
    };
    assert.equal(count(root), 58786);
    assert.ok(memo.size < 100);
    assert.equal(root.start, 0);
    assert.equal(root.end, 12);
    assert.equal(actions, 0);
    assert.strictEqual(parser.finish(), root);
});

test('GLR forest mode supports empty rules and rejects incompatible tables', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser('entry = [ A ];', {
        start: 'entry', tokens: ['A'], algorithm: 'glr'
    });
    const parser = new Parser(new Lexer(lexerTable), { ...config, forest: true });
    assert.equal(parser.parse('').start, 0);
    assert.equal(parser.parse('').end, 0);
    assert.equal(parser.parse('a').end, 1);
    assert.throws(() => new Parser(new Lexer(lexerTable), {
        ...config, algorithm: 'LALR(1)', forest: true
    }), /requires a GLR table/);
    const cyclic = createEbnfParser('entry = entry | A;', {
        start: 'entry', tokens: ['A'], algorithm: 'glr'
    });
    assert.throws(() => new Parser(new Lexer(lexerTable), {
        ...cyclic, forest: true
    }).parse('a'), /cyclic derivations/);
});

test('preserves reduce-reduce alternatives with identical results', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser('entry = left | right; left = A; right = A;', {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: {
            entry: [() => 1, () => 1],
            left: [() => 1],
            right: [() => 1]
        }
    });
    assert.deepEqual(new Parser(new Lexer(lexerTable), config).parse('a'), [1, 1]);
});

test('GLR preserves hidden tokens and resets them between parses', () => {
    const lexerTable = createEbnfLexer('A = "a"; SPACE = " ";', {
        tokens: ['A', 'SPACE'],
        actions: { SPACE: lexer => ({ tokenType: 'SPACE', content: lexer.yytext, channel: 'trivia' }) }
    });
    const config = createEbnfParser('entry = A, A;', {
        start: 'entry', tokens: ['A'], algorithm: 'glr'
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    assert.equal(parser.parse('a a').length, 1);
    assert.equal(parser.hiddenTokens.length, 1);
    assert.equal(parser.hiddenTokens[0].channel, 'trivia');
    assert.equal(parser.parse('aa').length, 1);
    assert.equal(parser.hiddenTokens.length, 0);
});

test('GLR handles nullable productions and reports unexpected end of input', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    const config = createEbnfParser('entry = [ A ], A;', {
        start: 'entry', tokens: ['A'], algorithm: 'glr'
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    assert.equal(parser.parse('a').length, 1);
    assert.equal(parser.parse('aa').length, 1);
    assert.throws(() => parser.parse(''), error =>
        error instanceof SyntaxError && error.token.tokenType === 'eof' &&
        error.expected.includes('A'));
});

test('GLR reports cyclic derivations instead of looping indefinitely', () => {
    const lexerTable = createEbnfLexer('A = "a";', { tokens: ['A'] });
    for (const [grammar, input] of [
        ['entry = entry | "";', ''],
        ['entry = entry | A;', 'a']
    ]) {
        const config = createEbnfParser(grammar, {
            start: 'entry', tokens: ['A'], algorithm: 'glr'
        });
        const parser = new Parser(new Lexer(lexerTable), config);
        assert.throws(() => parser.parse(input), /cannot enumerate cyclic derivations/);
    }
});

test('processes GLR chunks as tokens become available and preserves ambiguity', () => {
    let tokensRead = 0;
    let reductions = 0;
    const lexerTable = createEbnfLexer('A = "a"; SPACE = " ";', {
        tokens: ['A', 'SPACE'],
        actions: {
            A: lexer => {
                tokensRead++;
                return { tokenType: 'A', content: lexer.yytext };
            },
            SPACE: lexer => ({ tokenType: 'SPACE', content: lexer.yytext, channel: 'trivia' })
        }
    });
    const config = createEbnfParser('entry = entry, entry | A;', {
        start: 'entry',
        tokens: ['A'],
        algorithm: 'glr',
        actions: {
            entry: [
                args => [args[0].rules, args[1].rules],
                args => {
                    reductions++;
                    return args[0].content;
                }
            ]
        }
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    const expected = parser.parse('a a a');
    tokensRead = 0;
    reductions = 0;
    parser.start('a');
    assert.equal(parser.push(' '), undefined);
    assert.equal(tokensRead, 1);
    assert.equal(parser.push('a '), undefined);
    assert.equal(tokensRead, 2);
    assert.ok(reductions > 0);
    assert.equal(parser.hiddenTokens.length, 1);
    assert.equal(parser.push('a'), undefined);
    assert.equal(tokensRead, 2);
    assert.deepEqual(parser.finish(), expected);
    assert.equal(tokensRead, 3);
    assert.equal(parser.hiddenTokens.length, 2);
    assert.deepEqual(parser.finish(), expected);
    assert.equal(tokensRead, 3);
    assert.throws(() => parser.push('a'), /already finished/);

    for (let split = 0; split <= 5; split++) {
        parser.start();
        parser.push('a a a'.slice(0, split));
        parser.push('a a a'.slice(split));
        assert.deepEqual(parser.finish(), expected);
    }
});

test('incremental GLR reports errors as soon as tokens are decidable', () => {
    const lexerTable = createEbnfLexer('A = "a"; B = "b";', { tokens: ['A', 'B'] });
    const config = createEbnfParser('entry = A;', {
        start: 'entry', tokens: ['A', 'B'], algorithm: 'glr'
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    parser.start();
    assert.throws(() => parser.push('bb'), error =>
        error instanceof SyntaxError && error.token.tokenType === 'B' && error.position === 0);
    parser.start();
    assert.throws(() => parser.push(1), /chunk must be a string/);
    parser.start();
    assert.throws(() => parser.finish(), error =>
        error instanceof SyntaxError && error.token.tokenType === 'eof');
    parser.start();
    parser.push('a');
    assert.equal(parser.finish().length, 1);
});

test('incremental GLR retains absolute diagnostics when lexer lines are discarded', () => {
    const table = createEbnfLexer('A = "a"; B = "b"; NL = "\\n"; SPACE = " ";', {
        tokens: ['A', 'B', 'NL', 'SPACE']
    });
    const config = createEbnfParser('entry = A, A;', {
        start: 'entry', tokens: ['A', 'B'], ignoreTokens: ['NL', 'SPACE'], algorithm: 'glr'
    });
    const lexer = new Lexer(table, { discardConsumedInput: true });
    const parser = new Parser(lexer, config);
    parser.start();
    parser.push('a\n ');
    assert.throws(() => parser.push('b '), error =>
        error instanceof SyntaxError && error.position === 3 &&
        error.line === 2 && error.column === 2 && /2:2/.test(error.message));
    assert.equal(lexer.inputOffset, 2);
});

test('incremental GLR handles Unicode code points split across chunks', () => {
    const lexerTable = createEbnfLexer('EMOJI = "😀";', {
        tokens: ['EMOJI'], unicode: true
    });
    const config = createEbnfParser('entry = EMOJI;', {
        start: 'entry', tokens: ['EMOJI'], algorithm: 'glr'
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    parser.start();
    assert.equal(parser.push('\uD83D'), undefined);
    assert.equal(parser.push('\uDE00'), undefined);
    const results = parser.finish();
    assert.equal(results.length, 1);
    assert.equal(results[0][0].content, '😀');
});

test('incremental GLR waits for the longest token across chunks', () => {
    const lexerTable = createEbnfLexer('A = "a"; AB = "ab"; SPACE = " ";', {
        tokens: ['A', 'AB', 'SPACE']
    });
    const config = createEbnfParser('entry = AB;', {
        start: 'entry', tokens: ['A', 'AB'], ignoreTokens: ['SPACE'], algorithm: 'glr'
    });
    const parser = new Parser(new Lexer(lexerTable), config);
    parser.start();
    assert.equal(parser.push('a'), undefined);
    assert.equal(parser.push('b '), undefined);
    const results = parser.finish();
    assert.equal(results.length, 1);
    assert.equal(results[0][0].tokenType, 'AB');
    assert.equal(results[0][0].content, 'ab');
});

test('reports invalid parser actions explicitly', () => {
    const lexerRules = createEbnfLexer('NUMBER = "0".."9", { "0".."9" };', { tokens: ['NUMBER'] });
    const parser = new Parser(new Lexer(lexerRules), {
        table: { 0: { NUMBER: [99, 0] } },
        states: []
    });
    assert.throws(() => parser.parse('3'), /invalid action 99/i);
});

test('parses incrementally and waits for more lexer input', () => {
        const lexer = new Lexer({
            INITIAL: {
                table: [
                    { from: '0', to: '1', _ft_: 'a', _tt_: 'a' },
                    { from: '1', to: '2', _ft_: 'b', _tt_: 'b' }
                ],
                endMap: { '2': { tokenType: 'AB' } }
            }
        });
        const parser = new Parser(lexer, {
            table: {
                0: { AB: [0, 1] },
                1: { eof: [2, 0] }
            },
            states: [
                { create: 'entry', base: ['AB'], action: args => args[0].content }
            ]
        });

        parser.start();
        assert.equal(parser.push('a'), undefined);
        assert.equal(parser.push('b'), undefined);
        assert.equal(parser.finish(), 'ab');
});

test('can recover from unexpected tokens and report them together', () => {
        const lexer = new Lexer({
            INITIAL: {
                table: [
                    { from: '0', to: '1', _ft_: 'a', _tt_: 'a' },
                    { from: '0', to: '2', _ft_: '!', _tt_: '!' }
                ],
                endMap: {
                    '1': { tokenType: 'A' },
                    '2': { tokenType: 'B' }
                }
            }
        });
        const parser = new Parser(lexer, {
            table: {
                0: { A: [0, 1] },
                1: { eof: [2, 0] }
            },
            states: [
                { create: 'entry', base: ['A'], action: args => args[0].content }
            ],
            recoverErrors: true
        });

        assert.equal(parser.parse('!a'), 'a');
        assert.equal(parser.errors.length, 1);
        assert.equal(parser.errors[0].token.tokenType, 'B');
});

test('preserves hidden channel tokens without sending them to the grammar', () => {
        const lexer = new Lexer({
            INITIAL: {
                table: [
                    { from: '0', to: '1', _ft_: 'a', _tt_: 'a' },
                    { from: '0', to: '2', _ft_: ' ', _tt_: ' ' }
                ],
                endMap: {
                    '1': { tokenType: 'A' },
                    '2': { tokenType: 'SPACE', parseFunction: () => ({
                        tokenType: 'SPACE',
                        channel: 'trivia',
                        content: ' '
                    }) }
                }
            }
        });
        const parser = new Parser(lexer, {
            table: {
                0: { A: [0, 1] },
                1: { eof: [2, 0] }
            },
            states: [
                { create: 'entry', base: ['A'], action: args => args[0].content }
            ]
        });

        assert.equal(parser.parse(' a'), 'a');
        assert.equal(parser.hiddenTokens.length, 1);
        assert.equal(parser.hiddenTokens[0].channel, 'trivia');
});

test('supports right and non-associative precedence declarations', () => {
        const config = createParser({
            start: 'entry',
            precedence: [
                { type: 'right', tokens: ['='] },
                { type: 'nonassoc', tokens: ['=='] }
            ],
            ignoreTokens: [],
            states: {
                entry: {
                    rules: [
                        { rule: ['entry', '=', 'entry'] },
                        { rule: ['entry', '==', 'entry'] },
                        { rule: ['ID'] }
                    ]
                }
            }
        });
        assert.equal(config.algorithm, 'LALR(1)');
});

test('table generation does not extend Array.prototype', () => {
    createParser({
        start: 'entry',
        algorithm: 'lalr1',
        states: {
            entry: {
                rules: [{
                    rule: ['NUMBER'],
                    action: args => args[0].rules
                }]
            }
        }
    });
    expandTable([{ from: '0', to: '1', _ft_: 'a', _tt_: 'z' }]);

    assert.equal(Object.hasOwn(Array.prototype, 'unique'), false);
    assert.equal(Object.hasOwn(Array.prototype, 'contains'), false);
});
