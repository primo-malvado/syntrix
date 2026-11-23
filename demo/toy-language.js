import { Lexer, Parser, createEbnfLexer, createEbnfParser } from '../src/client/index.js';

export const toyLexerGrammar = String.raw`
LET = "let";
PRINT = "print";
IDENT = ("a".."z" | "A".."Z" | "_"),
        { "a".."z" | "A".."Z" | "0".."9" | "_" };
NUMBER = "0".."9", { "0".."9" };
EQUAL = "=";
PLUS = "+";
MINUS = "-";
STAR = "*";
SLASH = "/";
LP = "(";
RP = ")";
SEMICOLON = ";";
SPACE = (" " | "\t" | "\n" | "\r"), { " " | "\t" | "\n" | "\r" };`;

export const toyParserGrammar = String.raw`
program = statements { $$ = $1; };
statements = statement { $$ = [$1]; }
           | statements, statement { $$ = [...$1, $2]; };
statement = LET, IDENT, EQUAL, expression, SEMICOLON
            { $$ = { type: "declaration", name: $2, value: $4 }; }
          | IDENT, EQUAL, expression, SEMICOLON
            { $$ = { type: "assignment", name: $1, value: $3 }; }
          | PRINT, expression, SEMICOLON
            { $$ = { type: "print", value: $2 }; };
expression = expression, PLUS, expression
             { $$ = { type: "binary", operator: "+", left: $1, right: $3 }; }
           | expression, MINUS, expression
             { $$ = { type: "binary", operator: "-", left: $1, right: $3 }; }
           | expression, STAR, expression
             { $$ = { type: "binary", operator: "*", left: $1, right: $3 }; }
           | expression, SLASH, expression
             { $$ = { type: "binary", operator: "/", left: $1, right: $3 }; }
           | LP, expression, RP { $$ = $2; }
           | NUMBER { $$ = { type: "number", value: Number($1) }; }
           | IDENT { $$ = { type: "identifier", name: $1 }; };`;

const lexerTokens = [
    'LET', 'PRINT', 'IDENT', 'NUMBER', 'EQUAL', 'PLUS', 'MINUS', 'STAR',
    'SLASH', 'LP', 'RP', 'SEMICOLON', 'SPACE'
];
const parserTokens = lexerTokens.filter(token => token !== 'SPACE');

export function parseToyLanguage (input, algorithm = 'lalr1') {
    const lexerTable = createEbnfLexer(toyLexerGrammar, { tokens: lexerTokens });
    const parserTable = createEbnfParser(toyParserGrammar, {
        start: 'program',
        tokens: parserTokens,
        ignoreTokens: ['SPACE'],
        precedence: [
            { type: 'left', tokens: ['PLUS', 'MINUS'] },
            { type: 'left', tokens: ['STAR', 'SLASH'] }
        ],
        algorithm
    });

    const lexer = new Lexer(lexerTable);
    lexer.setInput(input);
    const tokens = [];
    while (true) {
        const token = lexer.nextToken();
        if (token === null) throw new Error('The lexer needs more input.');
        if (token.tokenType === 'eof') break;
        if (token.tokenType !== 'SPACE') {
            tokens.push({ type: token.tokenType, content: token.content });
        }
    }

    const parser = new Parser(new Lexer(lexerTable), parserTable);
    return {
        ast: parser.parse(input),
        tokens,
        states: Object.keys(parserTable.table).length,
        diagnostics: parserTable.diagnostics
    };
}
