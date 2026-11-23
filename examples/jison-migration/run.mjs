import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    convertJisonGrammar,
    convertJisonLexer,
    createEbnfLexer,
    createEbnfParser,
    Lexer,
    Parser
} from '../../src/client/index.js';

const grammarPath = fileURLToPath(new URL('./grammar.json', import.meta.url));
const grammar = JSON.parse(await readFile(grammarPath, 'utf8'));
const lexer = convertJisonLexer(grammar.lex);
const parser = convertJisonGrammar(grammar, { tokenAliases: lexer.tokenAliases });
const lexerTable = createEbnfLexer(lexer.source, { tokens: lexer.tokens });
const parserTable = createEbnfParser(parser.source, {
    ...parser.options,
    tokens: lexer.tokens.filter(token => !lexer.ignoreTokens.includes(token)),
    ignoreTokens: lexer.ignoreTokens
});

console.log(String(new Parser(new Lexer(lexerTable), parserTable).parse('2 + 3 * 4')));
