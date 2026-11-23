import { Lexer, Parser, createEbnfLexer, createEbnfParser } from '../src/client/index.js';

export const lexerGrammar = String.raw`
NUMBER = "0".."9", { "0".."9" },
         [ ".", "0".."9", { "0".."9" } ],
         [ ("e" | "E"), [ "+" | "-" ], "0".."9", { "0".."9" } ];
IDENT = "a".."z", { "a".."z" };
PLUS = "+";
MINUS = "-";
STAR = "*";
SLASH = "/";
POWER = "^";
LP = "(";
RP = ")";
SPACE = (" " | "\t" | "\n" | "\r"), { " " | "\t" | "\n" | "\r" };`;

export const parserGrammar = `

entry = expression { $$ = $1; };
expression = expression, PLUS, term
           { $$ = finite($1 + $3); }
           | expression, MINUS, term
             { $$ = finite($1 - $3); }
           | term { $$ = $1; };
term = term, STAR, unary
       { $$ = finite($1 * $3); }
     | term, SLASH, unary
       { $$ = finite($1 / $3); }
     | unary { $$ = $1; };
unary = MINUS, unary { $$ = -$2; }
      | PLUS, unary { $$ = $2; }
      | power { $$ = $1; };
power = primary, POWER, unary { $$ = finite($1 ** $3); }
      | primary { $$ = $1; };
primary = NUMBER
          { $$ = finite(Number($1)); }
        | IDENT
          { $$ = constant($1); }
        | IDENT, LP, expression, RP
          { $$ = call($1, $3); }
        | LP, expression, RP
          { $$ = $2; };`;

export const lexerTokens = [
    'NUMBER', 'IDENT', 'PLUS', 'MINUS', 'STAR', 'SLASH', 'POWER', 'LP', 'RP', 'SPACE'
];

const functions = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    sqrt: Math.sqrt,
    ln: Math.log,
    log: Math.log10,
    abs: Math.abs
};
const constants = { pi: Math.PI, e: Math.E };

function finite (value) {
    if (!Number.isFinite(value)) throw new RangeError('The result is not a finite number.');
    return value;
}

function constant (name) {
    if (!Object.hasOwn(constants, name)) throw new Error(`Unknown constant: ${name}`);
    return constants[name];
}

function call (name, value) {
    if (!Object.hasOwn(functions, name)) throw new Error(`Unknown function: ${name}`);
    return finite(functions[name](value));
}

export function calculate ({ lexerSource, parserSource, input, algorithm = 'lalr1' }) {
    const lexerTable = createEbnfLexer(lexerSource, { tokens: lexerTokens });
    const parserTable = createEbnfParser(parserSource, {
        start: 'entry',
        tokens: lexerTokens.filter(token => token !== 'SPACE'),
        ignoreTokens: ['SPACE'],
        actionContext: { finite, constant, call },
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
        value: parser.parse(input),
        tokens,
        states: Object.keys(parserTable.table).length,
        diagnostics: parserTable.diagnostics
    };
}
