#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEbnf } from '../src/client/classes/Ebnf.js';
import { createEbnfLexer } from '../src/client/classes/EbnfLexer.js';
import { createEbnfParser, ebnfActions } from '../src/client/classes/EbnfParser.js';
import { convertJisonGrammar, convertJisonLexer } from '../src/client/classes/Jison.js';
import { parseJisonSource } from '../src/client/classes/JisonSource.js';
import Lexer from '../src/client/classes/Lexer.js';
import Parser from '../src/client/classes/Parser.js';

function usage () {
    console.error(`Usage:
  syntrix check <grammar>
  syntrix migrate-jison <grammar.json|grammar.jison> --out <directory>
  syntrix generate <grammar> --start <rule> --tokens A,B [--lexer-tokens A,B] [--algorithm slr1|lalr1|lr1|glr] [--actions actions.mjs] [--format module] --out <file>
  syntrix parse <grammar> <input> --start <rule> --tokens A,B [--lexer-tokens A,B] [--algorithm slr1|lalr1|lr1|glr] [--ignore A,B]`);
}

function options (argumentsList) {
    const result = {};
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}`);
        const name = argument.slice(2);
        const value = argumentsList[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
        result[name] = value;
        index++;
    }
    return result;
}

function list (value, name) {
    if (!value) throw new Error(`Missing --${name}`);
    const values = value.split(',').map(item => item.trim()).filter(Boolean);
    if (!values.length) throw new Error(`--${name} must not be empty`);
    return values;
}

function parseConfig (flags) {
    const parserTokens = list(flags.tokens, 'tokens');
    return {
        parserTokens,
        lexerTokens: flags['lexer-tokens'] ? list(flags['lexer-tokens'], 'lexer-tokens') : parserTokens,
        ignoreTokens: flags.ignore ? list(flags.ignore, 'ignore') : []
    };
}

async function loadGrammar (filename) {
    return readFile(resolve(filename), 'utf8');
}

async function check (filename, flags) {
    const source = await loadGrammar(filename);
    const rules = parseEbnf(source);
    let diagnostics = [];
    if (flags.start) {
        const { parserTokens, ignoreTokens } = parseConfig(flags);
        const config = createEbnfParser(source, {
            start: flags.start,
            tokens: parserTokens,
            ignoreTokens
        });
        diagnostics = config.diagnostics;
    }

    console.log(JSON.stringify({
        valid: true,
        rules: [...rules.keys()],
        diagnostics
    }, null, 2));
}

async function migrateJison (filename, flags) {
    if (!flags.out) throw new Error('Missing --out');
    const source = await loadGrammar(filename);
    const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    let grammar;
    if (extension === '.json') grammar = JSON.parse(source);
    else if (extension === '.jison') grammar = parseJisonSource(source);
    else throw new Error('Jison input must use .json or .jison extension');
    const lexer = grammar.lex ? convertJisonLexer(grammar.lex) : null;
    const parser = convertJisonGrammar(grammar, { tokenAliases: lexer?.tokenAliases });
    const warnings = [...(lexer?.warnings || []), ...parser.warnings];
    const hasManualActions = Object.keys(parser.manualActions).length > 0;
    if (!lexer) {
        warnings.unshift({
            code: 'MANUAL_LEXER_REQUIRED',
            message: 'No Jison lex rules found; define the Syntrix lexer manually'
        });
    }
    const output = resolve(flags.out);
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'parser.ebnf'), `${parser.source}\n`);
    if (lexer) await writeFile(resolve(output, 'lexer.ebnf'), `${lexer.source}\n`);
    if (hasManualActions) {
        const actionEntries = Object.entries(parser.manualActions).map(([rule, alternatives]) =>
            `    ${JSON.stringify(rule)}: [\n${alternatives.map((alternative, index) => {
                if (!alternative.action) return '        args => args';
                if (alternative.manual) {
                    return `        () => { throw new Error(${JSON.stringify(
                        `Manual Jison action migration required for ${rule} alternative ${index}. Original action: ${alternative.action}`
                    )}); }`;
                }
                const references = [...alternative.action.matchAll(/\$(\d+)/g)]
                    .map(match => Number(match[1]));
                const count = Math.max(0, ...references);
                const bindings = Array.from({ length: count }, (_, parameter) =>
                    `            const $${parameter + 1} = args[${parameter}]?.rules ?? args[${parameter}]?.content;`);
                return `        args => {\n            let $$;\n${bindings.join('\n')}${bindings.length ? '\n' : ''}            const yytext = args.filter(arg => arg && Object.hasOwn(arg, 'content')).at(-1)?.content;\n            ${alternative.action}\n            return $$;\n        }`;
            }).join(',\n')}\n    ]`
        );
        await writeFile(resolve(output, 'actions.mjs'), `export const parserActions = {\n${actionEntries.join(',\n')}\n};\n`);
    }
    await writeFile(resolve(output, 'syntrix.json'), `${JSON.stringify({
        start: parser.options.start,
        precedence: parser.options.precedence,
        precedenceOverrides: parser.options.precedenceOverrides,
        parserTokens: (lexer?.tokens || []).filter(token => !lexer?.ignoreTokens.includes(token)),
        lexerTokens: lexer?.tokens || [],
        ignoreTokens: lexer?.ignoreTokens || [],
        tokenAliases: lexer?.tokenAliases || {},
        actionsModule: hasManualActions ? 'actions.mjs' : null,
        warnings
    }, null, 2)}\n`);
    console.log(`Migrated Jison grammar to ${output}`);
    for (const warning of warnings) {
        console.error(`WARNING [${warning.code}]: ${warning.message}`);
    }
}

async function build (filename, flags) {
    const source = await loadGrammar(filename);
    const lexerSource = flags['lexer-grammar']
        ? await loadGrammar(flags['lexer-grammar'])
        : source;
    const { parserTokens, lexerTokens, ignoreTokens } = parseConfig(flags);
    if (!flags.start) throw new Error('Missing --start');
    const actions = flags.actions
        ? await import(pathToFileURL(resolve(flags.actions)).href)
        : {};
    const lexerTable = createEbnfLexer(lexerSource, {
        tokens: lexerTokens,
        actions: actions.lexerActions || {}
    });
    const parserTable = createEbnfParser(source, {
        start: flags.start,
        tokens: parserTokens,
        ignoreTokens,
        algorithm: flags.algorithm || 'lalr1',
        actions: actions.parserActions || {}
    });
    return { lexerTable, parserTable, actions };
}

function serializableLexer (table) {
    return {
        INITIAL: {
            table: table.INITIAL.table,
            endMap: Object.fromEntries(Object.entries(table.INITIAL.endMap)
                .map(([state, entry]) => [state, { tokenType: entry.tokenType }]))
        }
    };
}

function serializableParser (config) {
    return {
        table: config.table,
        states: config.states.map(state => ({
            create: state.create,
            base: state.base
        })),
        ignoreTokens: config.ignoreTokens,
        diagnostics: config.diagnostics,
        algorithm: config.algorithm
    };
}

function actionModuleSpecifier (output, actions) {
    const path = relative(dirname(resolve(output)), resolve(actions))
        .split(sep).map(encodeURIComponent).join('/');
    return path.startsWith('../') || path.startsWith('./') ? path : `./${path}`;
}

function moduleSource (lexerTable, parserTable, actions, flags) {
    const lexer = lexerTable.INITIAL;
    const lexerActions = Object.entries(lexer.endMap).map(([state, entry]) => {
        if (typeof entry.tokenType !== 'string') {
            throw new Error(`Missing token type for lexer state ${state}`);
        }
        const name = JSON.stringify(entry.tokenType);
        const action = actions.lexerActions?.[entry.tokenType]
            ? `actions.lexerActions[${name}]`
            : `lexer => ({ tokenType: ${name}, content: lexer.yytext })`;
        return `    ${JSON.stringify(state)}: ${action}`;
    });
    const actionReferences = new Map();
    for (const [name, alternatives] of Object.entries(actions.parserActions || {})) {
        alternatives.forEach((action, index) => {
            actionReferences.set(action, `actions.parserActions[${JSON.stringify(name)}][${index}]`);
        });
    }
    const builtinActions = new Set(Object.values(ebnfActions));
    const parserActions = parserTable.states.map(state => {
        if (actionReferences.has(state.action)) return actionReferences.get(state.action);
        if (state.action === undefined) return 'undefined';
        if (!builtinActions.has(state.action)) {
            throw new Error(`Cannot generate parser action for ${state.create}`);
        }
        return state.action.toString();
    });
    const parserStates = parserTable.states.map(({ create, base }) => ({ create, base }));
    const actionImport = flags.actions
        ? `import * as actions from ${JSON.stringify(actionModuleSpecifier(flags.out, flags.actions))};\n\n`
        : '';
    return `// Generated by Syntrix. Do not edit.
${actionImport}const lexerActions = {
${lexerActions.join(',\n')}
};

export const lexerTable = {
    INITIAL: {
        table: ${JSON.stringify(lexer.table)},
        endMap: Object.fromEntries(Object.entries(${JSON.stringify(
        Object.fromEntries(Object.entries(lexer.endMap).map(([state, entry]) => [state, {
            tokenType: entry.tokenType
        }]))
    )}).map(([state, entry]) => [state, {
            ...entry,
            parseFunction: lexerActions[state]
        }]))
    }
};

const parserActions = [
${parserActions.map(action => `    ${action}`).join(',\n')}
];

export const parserConfig = {
    tokens: ${JSON.stringify(parserTable.tokens)},
    table: ${JSON.stringify(parserTable.table)},
    states: ${JSON.stringify(parserStates)}.map((state, index) => ({
        ...state,
        action: parserActions[index]
    })),
    ignoreTokens: ${JSON.stringify(parserTable.ignoreTokens)},
    diagnostics: ${JSON.stringify(parserTable.diagnostics || [])},
    algorithm: ${JSON.stringify(parserTable.algorithm)}
};
`;
}

async function generate (filename, flags) {
    const output = flags.out;
    if (!output) throw new Error('Missing --out');
    const { lexerTable, parserTable, actions } = await build(filename, flags);
    const content = flags.format === 'module'
        ? moduleSource(lexerTable, parserTable, actions, flags)
        : `${JSON.stringify({
            lexerTable: serializableLexer(lexerTable),
            parserTable: serializableParser(parserTable)
        }, null, 2)}\n`;
    await writeFile(resolve(output), content);
    console.log(`Generated ${resolve(output)}`);
}

async function parse (grammarFilename, inputFilename, flags) {
    const { lexerTable, parserTable } = await build(grammarFilename, flags);
    const input = await readFile(resolve(inputFilename), 'utf8');
    const result = new Parser(new Lexer(lexerTable), parserTable).parse(input);
    console.log(JSON.stringify(result, null, 2));
}

async function main (argumentsList) {
    const [command, ...commandArguments] = argumentsList;
    const first = commandArguments[0];
    if (!command || !first || !['check', 'migrate-jison', 'generate', 'parse'].includes(command)) {
        usage();
        return 2;
    }
    const positionalCount = command === 'parse' ? 2 : 1;
    const positional = commandArguments.slice(0, positionalCount);
    const flags = options(commandArguments.slice(positionalCount));
    if (command === 'check') await check(first, flags);
    if (command === 'migrate-jison') await migrateJison(first, flags);
    if (command === 'generate') await generate(first, flags);
    if (command === 'parse') {
        if (!positional[1]) throw new Error('Missing input file');
        await parse(first, positional[1], flags);
    }
    return 0;
}

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    console.error(`syntrix: ${error.message}`);
    process.exitCode = 1;
}
