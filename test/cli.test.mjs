import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { Lexer, Parser, createEbnfLexer, createEbnfParser } from '../src/client/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('generates an ESM module that preserves semantic actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-cli-'));
    try {
        const grammar = join(directory, 'grammar.ebnf');
        const lexerGrammar = join(directory, 'lexer.ebnf');
        const actions = join(directory, 'actions #1.mjs');
        const generated = join(directory, 'output', 'generated.mjs');
        await mkdir(join(directory, 'output'));
        await writeFile(grammar, 'entry = NUMBER;\n');
        await writeFile(lexerGrammar, 'NUMBER = "0".."9", { "0".."9" };\n');
        await writeFile(join(directory, 'helper.mjs'), 'export const factor = 3;\n');
        await writeFile(actions, `
            import { factor } from './helper.mjs';
            const offset = 1;
            export const lexerActions = {
                NUMBER(lexer) {
                    return { tokenType: 'NUMBER', content: Number(lexer.yytext) + offset };
                }
            };
            export const parserActions = {
                entry: [args => args[0].content * factor]
            };
        `);

        execFileSync(process.execPath, [
            join(root, 'bin/syntrix.mjs'),
            'generate',
            grammar,
            '--lexer-grammar', lexerGrammar,
            '--start', 'entry',
            '--tokens', 'NUMBER',
            '--lexer-tokens', 'NUMBER',
            '--actions', actions,
            '--format', 'module',
            '--out', generated
        ], { cwd: root, stdio: 'pipe' });

        const module = await import(`${pathToFileURL(generated).href}?test`);
        const result = new Parser(
            new Lexer(module.lexerTable),
            module.parserConfig
        ).parse('42');
        assert.equal(result, 129);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('generated ESM preserves default lexer actions and EBNF reductions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-cli-'));
    try {
        const grammar = 'entry = [ NUMBER ], { PLUS, NUMBER }, [ END ];';
        const lexerGrammar = 'NUMBER = "0".."9", { "0".."9" }; PLUS = "+"; END = "!";';
        const grammarPath = join(directory, 'grammar.ebnf');
        const lexerPath = join(directory, 'lexer.ebnf');
        const generated = join(directory, 'generated.mjs');
        await writeFile(grammarPath, grammar);
        await writeFile(lexerPath, lexerGrammar);
        execFileSync(process.execPath, [
            join(root, 'bin/syntrix.mjs'), 'generate', grammarPath,
            '--lexer-grammar', lexerPath, '--start', 'entry',
            '--tokens', 'NUMBER,PLUS,END', '--format', 'module', '--out', generated
        ], { cwd: root, stdio: 'pipe' });
        const module = await import(pathToFileURL(generated).href);
        const actual = new Parser(new Lexer(module.lexerTable), module.parserConfig);
        const expected = new Parser(
            new Lexer(createEbnfLexer(lexerGrammar, { tokens: ['NUMBER', 'PLUS', 'END'] })),
            createEbnfParser(grammar, { start: 'entry', tokens: ['NUMBER', 'PLUS', 'END'] })
        );
        for (const input of ['', '1', '1+2!', '+2', '!']) {
            assert.deepEqual(actual.parse(input), expected.parse(input));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('packed package exposes its public JavaScript API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-package-'));
    try {
        const output = execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
            cwd: root, encoding: 'utf8'
        });

        const archive = join(directory, JSON.parse(output)[0].filename);
        const packageDirectory = join(directory, 'node_modules', 'syntrix');
        await mkdir(packageDirectory, { recursive: true });
        execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', packageDirectory]);
        const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
        assert.equal(packageJson.bin.syntrix, './bin/syntrix.mjs');
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { Lexer, Parser, createEbnfLexer, createEbnfParser, createParser,
                ParserConflictError } from 'syntrix';
            if (typeof createParser !== 'function' || typeof ParserConflictError !== 'function')
                throw new Error('Missing public exports');
            const lexer = new Lexer(createEbnfLexer('A = "a";', { tokens: ['A'] }));
            const config = createEbnfParser('entry = A;', { start: 'entry', tokens: ['A'] });
            if (new Parser(lexer, config).parse('a')[0].content !== 'a')
                throw new Error('Installed parser failed');
        `], { cwd: directory, stdio: 'pipe' });
        await writeFile(join(directory, 'grammar.ebnf'), 'entry = A;\n');
        await writeFile(join(directory, 'lexer.ebnf'), 'A = "a";\n');
        await writeFile(join(directory, 'input.txt'), 'a');
        const cli = join(packageDirectory, 'bin/syntrix.mjs');
        const checked = execFileSync(process.execPath, [cli, 'check', 'grammar.ebnf'], {
            cwd: directory, encoding: 'utf8'
        });

        assert.equal(JSON.parse(checked).valid, true);
        const parsed = execFileSync(process.execPath, [
            cli, 'parse', 'grammar.ebnf', 'input.txt', '--lexer-grammar', 'lexer.ebnf',
            '--start', 'entry', '--tokens', 'A'
        ], { cwd: directory, encoding: 'utf8' });
        assert.equal(JSON.parse(parsed)[0].content, 'a');
        await writeFile(join(directory, 'input.txt'), '!');
        assert.throws(() => execFileSync(process.execPath, [
            cli, 'parse', 'grammar.ebnf', 'input.txt', '--lexer-grammar', 'lexer.ebnf',
            '--start', 'entry', '--tokens', 'A'
        ], { cwd: directory, stdio: 'pipe' }), error =>
            error.status === 1 && /Lexer: unexpected input/.test(error.stderr.toString()));
        await writeFile(join(directory, 'consumer.mts'), `
            import { Lexer, Parser, createEbnfLexer, createEbnfParser, createParser }
                from 'syntrix';
            const config = createEbnfParser('entry = A;', { start: 'entry', tokens: ['A'] });
            const lexer = new Lexer(createEbnfLexer('A = "a";', { tokens: ['A'] }));
            new Parser(lexer, config).parse('a');
            createParser({ start: 'entry', states: { entry: { rules: [{ rule: ['A'] }] } } });
        `);
        execFileSync(process.execPath, [
            join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
            '--module', 'nodenext', '--moduleResolution', 'nodenext',
            '--target', 'es2022', 'consumer.mts'
        ], { cwd: directory, stdio: 'pipe' });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('migrates a Jison JSON grammar through the CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-migrate-'));
    try {
        const grammar = join(directory, 'grammar.json');
        const output = join(directory, 'migrated');
        await writeFile(grammar, JSON.stringify({
            startSymbol: 'entry',
            operators: [['left', '+']],
            bnf: {
                entry: [['NUMBER "+" NUMBER', '$$ = Number($1) + Number($3);']]
            },
            lex: {
                rules: [
                    ['\\s+', '/* skip whitespace */'],
                    ['[0-9]+', 'return "NUMBER";'],
                    ['\\+', 'return "+";']
                ]
            }
        }));
        const result = execFileSync(process.execPath, [
            join(root, 'bin/syntrix.mjs'), 'migrate-jison', grammar, '--out', output
        ], { cwd: root, encoding: 'utf8' });
        assert.match(result, /Migrated Jison grammar/);
        assert.match(await readFile(join(output, 'parser.ebnf'), 'utf8'), /entry =/);
        assert.match(await readFile(join(output, 'lexer.ebnf'), 'utf8'), /NUMBER =/);
        const manifest = JSON.parse(await readFile(join(output, 'syntrix.json'), 'utf8'));
        assert.equal(manifest.start, 'entry');
        assert.deepEqual(manifest.lexerTokens, ['JISON_SKIP_0', 'NUMBER', 'JISON_LITERAL_2B']);
        assert.deepEqual(manifest.parserTokens, ['NUMBER', 'JISON_LITERAL_2B']);
        assert.deepEqual(manifest.ignoreTokens, ['JISON_SKIP_0']);
        assert.deepEqual(manifest.tokenAliases, { '+': 'JISON_LITERAL_2B' });
        assert.deepEqual(manifest.warnings, []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('migrates a Jison source file through the CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-jison-source-'));
    try {
        const grammar = join(root, 'examples/jison-migration/arithmetic.jison');
        const output = join(directory, 'migrated');
        const result = execFileSync(process.execPath, [
            join(root, 'bin/syntrix.mjs'), 'migrate-jison', grammar, '--out', output
        ], { cwd: root, encoding: 'utf8' });
        assert.match(result, /Migrated Jison grammar/);
        assert.match(await readFile(join(output, 'parser.ebnf'), 'utf8'), /expression =/);
        assert.match(await readFile(join(output, 'lexer.ebnf'), 'utf8'), /NUMBER =/);
        const manifest = JSON.parse(await readFile(join(output, 'syntrix.json'), 'utf8'));
        assert.equal(manifest.start, 'expression');
        assert.deepEqual(manifest.precedence, [
            { type: 'left', tokens: ['JISON_LITERAL_2B'] }
        ]);
        assert.deepEqual(manifest.parserTokens, ['NUMBER', 'JISON_LITERAL_2B']);
        assert.deepEqual(manifest.ignoreTokens, ['JISON_SKIP_0']);
        assert.deepEqual(manifest.warnings, []);
        const lexerGrammar = await readFile(join(output, 'lexer.ebnf'), 'utf8');
        const parserGrammar = await readFile(join(output, 'parser.ebnf'), 'utf8');
        const lexerTable = createEbnfLexer(lexerGrammar, { tokens: manifest.lexerTokens });
        const parserTable = createEbnfParser(parserGrammar, {
            start: manifest.start,
            tokens: manifest.parserTokens,
            ignoreTokens: manifest.ignoreTokens,
            precedence: manifest.precedence,
            precedenceOverrides: manifest.precedenceOverrides
        });
        assert.equal(new Parser(new Lexer(lexerTable), parserTable).parse('12 + 30'), 42);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('rejects unsupported Jison source declarations explicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-jison-unsupported-'));
    try {
        const grammar = join(directory, 'grammar.jison');
        await writeFile(grammar, '%locations\n%%\nentry : TOKEN ;\n');
        const result = spawnSync(process.execPath, [
            join(root, 'bin/syntrix.mjs'), 'migrate-jison', grammar,
            '--out', join(directory, 'migrated')
        ], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unsupported declaration: %locations/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('runs the complete Jison migration example', () => {
    for (const forceColor of ['0', '1']) {
        const result = execFileSync(process.execPath, [
            'examples/jison-migration/run.mjs'
        ], { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: forceColor } });
        assert.equal(result.trim(), '14');
    }
});

test('writes and prints manual-review warnings for unsupported Jison features', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntrix-migrate-warnings-'));
    try {
        const grammar = join(directory, 'grammar.json');
        const output = join(directory, 'migrated');
        await writeFile(grammar, JSON.stringify({
            bnf: {
                entry: [
                    ['NUMBER', '$$ = yy.value;'],
                    ['NUMBER', '$$ = $1 + 1;']
                ]
            },
            lex: { rules: [['[0-9]+', 'setValue(); return "NUMBER";']] }
        }));
        const result = spawnSync(process.execPath, [
            join(root, 'bin/syntrix.mjs'), 'migrate-jison', grammar, '--out', output
        ], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /MANUAL_LEXER_RULE/);
        assert.match(result.stderr, /MANUAL_PARSER_ACTION/);
        const manifest = JSON.parse(await readFile(join(output, 'syntrix.json'), 'utf8'));
        assert.deepEqual(manifest.warnings.map(warning => warning.code), [
            'MANUAL_LEXER_RULE',
            'MANUAL_PARSER_ACTION'
        ]);
        assert.match(await readFile(join(output, 'lexer.ebnf'), 'utf8'), /MIGRATION REQUIRED/);
        assert.equal(manifest.actionsModule, 'actions.mjs');
        const actions = await readFile(join(output, 'actions.mjs'), 'utf8');
        assert.match(actions, /Manual Jison action migration required/);
        const actionModule = await import(`${pathToFileURL(join(output, 'actions.mjs')).href}?test`);
        assert.throws(() => actionModule.parserActions.entry[0]([]), /Manual Jison action migration required/);
        assert.equal(actionModule.parserActions.entry[1]([{ content: 2 }]), 3);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
