import {
    Lexer,
    Parser,
    ParserConflictError,
    compileEbnfGrammar,
    convertJisonGrammar,
    convertJisonLexer,
    createEbnfLexer,
    createEbnfParser,
    createParser,
    determinize,
    regexToDfa,
    regexToNfa,
    type Automaton,
    type EbnfParserOptions,
    type JisonGrammar,
    type ForestNode
} from '../src/client/index.js';

const nfa: Automaton = regexToNfa('a(b|c)*');
const dfa: Automaton = determinize(nfa);
const directDfa: Automaton = regexToDfa('a(b|c)*');
void [dfa, directDfa];

const lexer = new Lexer(createEbnfLexer('A = "a";', { tokens: ['A'] }));
const options: EbnfParserOptions = { start: 'entry', tokens: ['A'], algorithm: 'glr' };
const jisonGrammar: JisonGrammar = {
    bnf: { entry: 'A' },
    lex: { rules: [['a', 'return "A";']] }
};
convertJisonGrammar(jisonGrammar);
convertJisonLexer({ rules: [['[0-9]+', 'return "NUMBER";']] });
const rules = compileEbnfGrammar('entry = A;', options);
const config = createEbnfParser('entry = A;', options);
createParser(rules);

const parser = new Parser(lexer, { ...config, forest: true });
const forest = parser.parse<ForestNode>('a');
const tokenValue: unknown = lexer.nextToken()?.value;
void tokenValue;
if ('alternatives' in forest) {
    forest.alternatives.forEach(alternative => alternative.children.forEach(child => child.symbol));
}
const conflict: Error = new ParserConflictError({ state: 0, token: 'A', actions: [] });
void conflict;

// @ts-expect-error Unsupported algorithms must be rejected by the public types.
createEbnfParser('entry = A;', { start: 'entry', algorithm: 'unknown' });
