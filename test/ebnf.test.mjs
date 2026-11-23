import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { parseEbnf } from '../src/client/classes/Ebnf.js';
import { createEbnfParser } from '../src/client/classes/EbnfParser.js';
import { createParser } from '../src/client/classes/GenerateLalrParser.js';
import { convertJisonGrammar, convertJisonLexer } from '../src/client/classes/Jison.js';
import { config as regexConfig } from '../src/client/classes/regexConfig.js';
import Lexer from '../src/client/classes/Lexer.js';
import Parser from '../src/client/classes/Parser.js';

let server;
let cacheDir;
let createEbnfLexer;
before(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ebnf-vite-test-'));
    server = await createServer({
        configFile: false,
        publicDir: false,
        cacheDir,
        server: { middlewareMode: true, hmr: false, ws: false },
        appType: 'custom'
    });
    ({ createEbnfLexer } = await server.ssrLoadModule('/src/client/classes/EbnfLexer.js'));
});
after(async () => {
    if (server) await server.close();
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

test('parses EBNF syntax and reports malformed definitions', () => {
    const rules = parseEbnf('(* comment *) digits = "0".."9", { "0".."9" };');
    assert.equal(rules.get('digits').choices[0].items[1].type, 'repeat');
    const expression = parseEbnf('entry = (NAME | "x"), [ "y" ], { "z" };').get('entry').choices[0];
    assert.deepEqual(expression.items.map(item => item.type), ['group', 'optional', 'repeat']);
    assert.deepEqual(expression.items[0].expression.choices.map(choice => choice.items[0].type), ['name', 'literal']);
    assert.throws(() => parseEbnf('x = "a"'), /Expected ;/);
    assert.throws(() => parseEbnf('x = "a"; x = "b";'), /Duplicate/);
    assert.throws(() => parseEbnf('x = "z".."a";'), /range/i);
    assert.throws(() => parseEbnf('x = "\\q";'), /escape/i);
    assert.throws(() => parseEbnf('(* no rules *)'), /at least one rule/);
});

test('builds a lexer and parser from EBNF with external actions', () => {
    const lexerTable = createEbnfLexer(String.raw`
        digit = "0".."9";
        NUMBER = digit, { digit };
        PLUS = "+";
        SPACE = " ", { " " };
    `, {
        tokens: ['NUMBER', 'PLUS', 'SPACE'],
        actions: {
            NUMBER: lexer => ({ tokenType: 'NUMBER', content: Number(lexer.yytext) }),
            PLUS: () => ({ tokenType: '+' })
        }
    });
    const table = createEbnfParser(`
        expression = NUMBER, { "+", NUMBER };
    `, {
        start: 'expression',
        tokens: ['NUMBER'],
        ignoreTokens: ['SPACE'],
        actions: {
            expression: [args => args[0].content +
                args[1].rules.reduce((sum, item) => sum + item[1].content, 0)]
        }
    });
    const parser = new Parser(new Lexer(lexerTable), table);
    assert.equal(parser.parse('12'), 12);
    assert.equal(parser.parse('12 + 3 + 4'), 19);
    assert.throws(() => parser.parse('12 +'), SyntaxError);
});

test('builds parser actions embedded after grammar alternatives', () => {
    const lexerTable = createEbnfLexer('NUMBER = "0".."9", { "0".."9" }; PLUS = "+";', {
        tokens: ['NUMBER', 'PLUS'],
        actions: {
            NUMBER: lexer => ({ tokenType: 'NUMBER', content: Number(lexer.yytext) })
        }
    });
    const table = createEbnfParser(`
        entry = expression { $$ = $1; };
        expression = expression, PLUS, NUMBER { $$ = $1 + $3; }
                  | NUMBER { $$ = $1; };
    `, { start: 'entry', tokens: ['NUMBER', 'PLUS'] });
    const parser = new Parser(new Lexer(lexerTable), table);
    assert.equal(parser.parse('12+3'), 15);
});

test('converts a Jison bnf grammar with precedence and actions', () => {
    const converted = convertJisonGrammar({
        startSymbol: 'entry',
        operators: [['left', 'PLUS'], ['left', 'STAR']],
        bnf: {
            entry: [['expression', '$$ = $1;']],
            expression: [
                ['expression PLUS expression', '$$ = $1 + $3;'],
                ['expression STAR expression', '$$ = $1 * $3;'],
                ['NUMBER', '$$ = Number($1);']
            ]
        }
    });
    assert.match(converted.source, /expression, PLUS, expression/);
    assert.deepEqual(converted.options.precedence, [
        { type: 'left', tokens: ['PLUS'] },
        { type: 'left', tokens: ['STAR'] }
    ]);
    const lexerTable = createEbnfLexer(
        'NUMBER = "0".."9"; PLUS = "+"; STAR = "*"; SPACE = " ";',
        { tokens: ['NUMBER', 'PLUS', 'STAR', 'SPACE'] }
    );
    const parserTable = createEbnfParser(converted.source, {
        ...converted.options,
        tokens: ['NUMBER', 'PLUS', 'STAR'],
        ignoreTokens: ['SPACE']
    });
    assert.equal(new Parser(new Lexer(lexerTable), parserTable).parse('2 + 3 * 4'), 14);
});

test('converts literal token aliases and supports yytext in parser actions', () => {
    const lexer = convertJisonLexer({
        rules: [
            ['\\s+', '/* skip whitespace */'],
            ['[0-9]+', 'return "NUMBER";'],
            ['\\+', 'return "+";']
        ]
    });
    assert.deepEqual(lexer.ignoreTokens, ['JISON_SKIP_0']);
    assert.deepEqual(lexer.tokenAliases, { '+': 'JISON_LITERAL_2B' });
    const parser = convertJisonGrammar({
        operators: [['left', '+']],
        bnf: {
            entry: [['expression', '$$ = $1;']],
            expression: [
                ['expression "+" expression', '$$ = $1 + $3;'],
                ['NUMBER', '$$ = Number(yytext);']
            ]
        }
    }, { tokenAliases: lexer.tokenAliases });
    const lexerTable = createEbnfLexer(lexer.source, { tokens: lexer.tokens });
    const parserTable = createEbnfParser(parser.source, {
        ...parser.options,
        tokens: lexer.tokens.filter(token => !lexer.ignoreTokens.includes(token)),
        ignoreTokens: lexer.ignoreTokens
    });
    assert.equal(new Parser(new Lexer(lexerTable), parserTable).parse('2 + 3'), 5);
    assert.deepEqual(parser.options.precedence, [
        { type: 'left', tokens: ['JISON_LITERAL_2B'] }
    ]);
});

test('binds yytext to the final terminal in a Jison parser reduction', () => {
    const lexerTable = createEbnfLexer('A = "a"; PLUS = "+"; B = "b";', {
        tokens: ['A', 'PLUS', 'B']
    });
    const converted = convertJisonGrammar({
        bnf: {
            entry: [['A PLUS B', '$$ = yytext;']]
        }
    });
    const parserTable = createEbnfParser(converted.source, {
        ...converted.options,
        tokens: ['A', 'PLUS', 'B']
    });
    assert.equal(new Parser(new Lexer(lexerTable), parserTable).parse('a+b'), 'b');
});

test('converts empty Jison productions and precedence overrides', () => {
    const converted = convertJisonGrammar({
        bnf: {
            entry: [['items', '$$ = $1;']],
            items: [
                ['/* empty */', '$$ = 0;'],
                ['items PLUS NUMBER %prec PLUS', '$$ = $1 + Number($3);']
            ]
        }
    });

    assert.match(converted.source, /items = ""/);
    assert.deepEqual(converted.options.precedenceOverrides, { items: { 1: 'PLUS' } });
});

test('converts common Jison lexer rules to EBNF', () => {
    const converted = convertJisonLexer({
        rules: [
            ['\\s+', '/* skip whitespace */'],
            ['[0-9]+', 'return "NUMBER";'],
            ['\\+', 'return "PLUS";']
        ]
    });
    assert.deepEqual(converted.tokens, ['JISON_SKIP_0', 'NUMBER', 'PLUS']);
    assert.deepEqual(converted.ignoreTokens, ['JISON_SKIP_0']);
    assert.ok(converted.source.includes('NUMBER = "0".."9", { "0".."9" };'));
    const lexerTable = createEbnfLexer(converted.source, { tokens: converted.tokens });
    const lexer = new Lexer(lexerTable);
    lexer.setInput('12+3');
    assert.deepEqual([lexer.nextToken(), lexer.nextToken(), lexer.nextToken()]
        .map(token => token.tokenType), ['NUMBER', 'PLUS', 'NUMBER']);
});

test('converts nested Jison lexer groups, alternatives, quantifiers and escapes', () => {
    const converted = convertJisonLexer({
        rules: [
            ['(?:(?:ab|cd)+|ef)+', 'return "PAIR";'],
            ['-', 'return "DASH";'],
            ['\\w+', 'return "WORD";'],
            ['\\x21', 'return "EXCLAIM";'],
            ['\\v', 'return "VT";']
        ]
    });
    const lexerTable = createEbnfLexer(converted.source, { tokens: converted.tokens });
    const lexer = new Lexer(lexerTable);
    lexer.setInput('abcdabef-word_2!\v');
    assert.deepEqual(
        [
            lexer.nextToken().tokenType,
            lexer.nextToken().tokenType,
            lexer.nextToken().tokenType,
            lexer.nextToken().tokenType,
            lexer.nextToken().tokenType
        ],
        ['PAIR', 'DASH', 'WORD', 'EXCLAIM', 'VT']
    );
});

test('converts bounded Jison repetitions and warns on invalid bounds', () => {
    const converted = convertJisonLexer({
        rules: [
            ['[A-Z]{2,3}', 'return "IDENT";'],
            ['-', 'return "DASH";'],
            ['D', 'return "D";']
        ]
    });
    const lexerTable = createEbnfLexer(converted.source, { tokens: converted.tokens });
    const lexer = new Lexer(lexerTable);
    lexer.setInput('AB-ABC-D');
    assert.deepEqual(
        Array.from({ length: 5 }, () => lexer.nextToken().tokenType),
        ['IDENT', 'DASH', 'IDENT', 'DASH', 'D']
    );

    const invalid = convertJisonLexer({
        rules: [['[A-Z]{129}', 'return "TOO_LONG";'], ['a{4,2}', 'return "BAD_RANGE";']]
    });
    assert.equal(invalid.warnings.length, 2);
    assert.ok(invalid.warnings.every(warning => warning.code === 'MANUAL_LEXER_RULE'));
});

test('reports unsupported Jison lexer actions and patterns for manual conversion', () => {
    const converted = convertJisonLexer({
        rules: [
            ['[^a]+', 'return "TEXT";'],
            ['[0-9]+', 'this.yytext = yytext;']
        ]
    });
    assert.equal(converted.warnings.length, 2);
    assert.match(converted.source, /MIGRATION REQUIRED/);
    assert.deepEqual(converted.tokens, []);
});

test('warns when parser actions depend on Jison runtime state', () => {
    const converted = convertJisonGrammar({
        bnf: { entry: [['NUMBER', '$$ = yy.value + $1;']] }
    });
    assert.equal(converted.warnings[0].code, 'MANUAL_PARSER_ACTION');
    assert.equal(converted.warnings[0].rule, 'entry');
    assert.deepEqual(converted.manualActions, {
        entry: [{ action: '$$ = yy.value + $1;', manual: true }]
    });
});

test('reports lexer actions with extra behavior for manual conversion', () => {
    const converted = convertJisonLexer({
        rules: [['[0-9]+', 'runSideEffect(); return "NUMBER";']]
    });
    assert.equal(converted.warnings[0].code, 'MANUAL_LEXER_RULE');
});

test('supports optional, grouped and empty grammar expressions', () => {
    const lexerTable = createEbnfLexer(`
        A = "a";
        B = "b";
        C = "c";
    `, { tokens: ['A', 'B', 'C'] });
    const table = createEbnfParser(`
        entry = [ A ], ( B | C ), [ A ];
    `, { start: 'entry', tokens: ['A', 'B', 'C'] });
    const parser = new Parser(new Lexer(lexerTable), table);
    for (const input of ['b', 'c', 'ab', 'ba', 'aca']) {
        assert.ok(parser.parse(input), input);
    }
    assert.throws(() => parser.parse('aa'), SyntaxError);
});

test('handles indirectly nullable rules before and after other optional terms', () => {
    const lexerTable = createEbnfLexer('A = "a"; B = "b"; C = "c";', { tokens: ['A', 'B', 'C'] });
    const table = createEbnfParser(`
        entry = prefix, [ B ], C;
        prefix = nested;
        nested = [ A ];
    `, { start: 'entry', tokens: ['A', 'B', 'C'] });
    const parser = new Parser(new Lexer(lexerTable), table);
    for (const input of ['c', 'ac', 'bc', 'abc']) {
        assert.ok(parser.parse(input), input);
    }
    assert.throws(() => parser.parse('ab'), SyntaxError);
});

test('rejects invalid lexer and grammar definitions', () => {
    assert.throws(() => createEbnfLexer('A = [ "a" ];', { tokens: ['A'] }), /empty input/);
    assert.throws(() => createEbnfLexer('A = B; B = A;', { tokens: ['A'] }), /Recursive/);
    assert.throws(() => createEbnfLexer('A = B;', { tokens: ['A'] }), /Unknown/);
    assert.throws(() => createEbnfParser('entry = { [ A ] };', { start: 'entry', tokens: ['A'] }), /empty input/);
    assert.throws(() => createEbnfParser('entry = MISSING;', { start: 'entry' }), /Unknown grammar symbol/);
    assert.throws(() => createEbnfParser('entry = A;', { start: 'entry', tokens: ['A'], precedenceOverrides: { entry: { 0: 'missing' } } }), /precedence override/);
    assert.throws(() => createEbnfLexer('A = "ε";', { tokens: ['A'] }), /reserved/);
});

test('returns diagnostics for unreachable grammar rules', () => {
    const table = createEbnfParser(`
        entry = A;
        unused = B;
    `, { start: 'entry', tokens: ['A', 'B'] });
    assert.deepEqual(table.diagnostics, [{
        severity: 'warning',
        code: 'UNREACHABLE_RULE',
        message: 'Grammar rule unused is unreachable',
        rule: 'unused'
    }, {
        severity: 'warning',
        code: 'UNUSED_TOKEN',
        message: 'Token B is declared but never used',
        token: 'B'
    }]);
});

test('reports unused precedence and rejects duplicate precedence declarations', () => {
    const table = createEbnfParser('entry = A;', {
        start: 'entry',
        tokens: ['A'],
        precedence: [{ type: 'left', tokens: ['missing'] }]
    });
    assert.deepEqual(table.diagnostics, [{
        severity: 'warning',
        code: 'UNUSED_PRECEDENCE',
        message: 'Precedence for missing has no effect because the token is unused',
        token: 'missing',
        associativity: 'left'
    }]);
    assert.throws(() => createEbnfParser('entry = A;', {
        start: 'entry',
        tokens: ['A'],
        precedence: [
            { type: 'left', tokens: ['A'] },
            { type: 'right', tokens: ['A'] }
        ]
    }), /multiple precedence levels/i);
});

test('uses lexical rule order for equally long matches', () => {
    const lexerTable = createEbnfLexer(`
        KEYWORD = "if";
        NAME = ("a".."z"), { "a".."z" };
    `, { tokens: ['KEYWORD', 'NAME'] });
    const lexer = new Lexer(lexerTable);
    lexer.setInput('if');
    assert.equal(lexer.popToken().tokenType, 'KEYWORD');
    lexer.setInput('iffy');
    assert.equal(lexer.popToken().tokenType, 'NAME');
});

