import { Lexer, Parser, createEbnfLexer, createEbnfParser } from '../src/client/index.js';
import { lexerInput, sourceInput, sourceWorkloads, workloads } from './benchmark-data.mjs';

export { lexerInput, sourceInput, sourceWorkloads, workloads };

const tokens = ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP', 'SPACE'];
const lexerGrammar = `
    NUMBER = "0".."9", { "0".."9" };
    PLUS = "+";
    STAR = "*";
    LP = "(";
    RP = ")";
    SPACE = " ", { " " };
`;
const parserGrammar = `
    entry = expr;
    expr = expr, PLUS, expr | expr, STAR, expr | LP, expr, RP | NUMBER;
`;

export function createSyntrix (algorithm = 'lalr1') {
    const lexerTable = createEbnfLexer(lexerGrammar, { tokens });
    const parserTable = createEbnfParser(parserGrammar, {
        start: 'entry',
        tokens,
        ignoreTokens: ['SPACE'],
        algorithm,
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
    return new Parser(new Lexer(lexerTable), parserTable);
}

export function createSourceSyntrix () {
    const tokens = ['IDENT', 'NUMBER', 'EQUALS', 'SEMICOLON', 'SPACE', 'COMMENT'];
    const lexer = createEbnfLexer(`
        IDENT = ("a".."z" | "_"), { "a".."z" | "_" | "0".."9" };
        NUMBER = [ "-" ], "0".."9", { "0".."9" };
        EQUALS = "="; SEMICOLON = ";";
        SPACE = (" " | "\\n" | "\\t"), { " " | "\\n" | "\\t" };
        COMMENT = "#", { "a".."z" | "0".."9" | "_" | " " };
    `, { tokens });
    const config = createEbnfParser(`
        entry = statements;
        statements = statement | statements, statement;
        statement = IDENT, EQUALS, NUMBER, SEMICOLON;
    `, {
        start: 'entry',
        tokens,
        ignoreTokens: ['SPACE', 'COMMENT'],
        actions: {
            entry: [args => args[0].rules],
            statements: [args => [args[0].rules], args => {
                args[0].rules.push(args[1].rules);
                return args[0].rules;
            }],
            statement: [args => [args[0].content, Number(args[2].content)]]
        }
    });
    return new Parser(new Lexer(lexer), config);
}

export function createBenchmarkLexer (discardConsumedInput = false) {
    const lexerTable = createEbnfLexer(`
        NUMBER = "0".."9", { "0".."9" };
        PLUS = "+";
        SPACE = (" " | "\\n"), { " " | "\\n" };
    `, { tokens: ['NUMBER', 'PLUS', 'SPACE'] });
    return new Lexer(lexerTable, { discardConsumedInput });
}

export function createSourceBenchmarkLexer (discardConsumedInput = false) {
    const lexerTable = createEbnfLexer(`
        IDENT = ("a".."z" | "_"), { "a".."z" | "_" | "0".."9" };
        NUMBER = "0".."9", { "0".."9" };
        EQUALS = "=";
        SEMICOLON = ";";
        SPACE = (" " | "\\n"), { " " | "\\n" };
    `, { tokens: ['IDENT', 'NUMBER', 'EQUALS', 'SEMICOLON', 'SPACE'] });
    return new Lexer(lexerTable, { discardConsumedInput });
}

