export type Associativity = 'left' | 'right' | 'nonassoc';
export type ParserAlgorithm = 'slr1' | 'lalr1' | 'lr1' | 'glr';

export interface Token<T = unknown> {
    tokenType: string;
    content?: T;
    value?: T;
    channel?: string;
    startPosition?: number;
    toPos?: number;
    pos?: number;
}

export interface LexerTransition {
    from: string;
    to: string;
    _ft_: string;
    _tt_: string;
}

export interface Automaton {
    start: string[];
    end: string[];
    table: LexerTransition[];
}

export function regexToNfa(expression: string): Automaton;
export function regexToDfa(expression: string): Automaton;
export function determinize(machine: Automaton): Automaton;

export interface LexerState {
    table: LexerTransition[];
    endMap: Record<string, {
        tokenType?: string;
        parseFunction?: (lexer: Lexer) => Token;
    }>;
    unicode?: boolean;
}

export type LexerGrammar = Record<string, LexerState>;

export interface LexerActionResult extends Token {}

export type LexerAction = (lexer: Lexer) => LexerActionResult;

export interface LexerOptions {
    unicode?: boolean;
    discardConsumedInput?: boolean;
}

export class Lexer {
    constructor(grammar: LexerGrammar, options?: LexerOptions);
    input: string;
    inputOffset: number;
    lineOffset: number;
    yytext: string;
    YYCURSOR: number;
    YYLIMIT: number;
    states: string[];
    setInput(input: string, options?: { final?: boolean }): void;
    appendInput(chunk: string): void;
    finishInput(): void;
    readToken(): Token | null;
    nextToken(): Token | null;
    popToken(): Token | null;
    beginState(state: string): void;
    pushState(state: string): void;
    popState(): string;
    currentState(): string;
}

export interface ParserState {
    create: string;
    base: string[];
    action?: (args: Token[]) => unknown;
}

export interface ParserConfig {
    tokens?: string[];
    table: Record<string, Record<string, [number, number] | Array<[number, number]>>>;
    states: ParserState[];
    ignoreTokens?: string[];
    channels?: string[];
    recoverErrors?: boolean;
    diagnostics?: Diagnostic[];
    algorithm?: ParserAlgorithm | 'SLR(1)' | 'LALR(1)' | 'LR(1)' | 'GLR';
    forest?: boolean;
}

/** Positions are token indices, excluding ignored and hidden tokens. */
export interface ForestTerminal {
    symbol: string;
    start: number;
    end: number;
    token: Token;
}

export interface ForestAlternative {
    production: number;
    children: ForestNode[];
}

export interface ForestNonterminal {
    symbol: string;
    start: number;
    end: number;
    alternatives: ForestAlternative[];
}

export type ForestNode = ForestTerminal | ForestNonterminal;

export interface ParserErrorDetails {
    position?: number;
    line?: number;
    column?: number;
    expected?: string[];
    token?: Token;
}

export class ParserSyntaxError extends SyntaxError implements ParserErrorDetails {
    position?: number;
    line?: number;
    column?: number;
    expected?: string[];
    token?: Token;
}

export class ParserParseError extends ParserSyntaxError {
    errors: ParserSyntaxError[];
}

export class Parser {
    constructor(lexer: Lexer, config: ParserConfig);
    errors: ParserSyntaxError[];
    hiddenTokens: Token[];
    stack: Token[];
    parse<T = unknown>(input: string): T;
    start(input?: string): void;
    push(chunk: string): unknown;
    finish<T = unknown>(): T;
}

export interface Diagnostic {
    severity: 'warning' | 'error' | string;
    code: string;
    message: string;
    rule?: string;
    token?: string;
    associativity?: Associativity;
}

export interface EbnfLexerOptions {
    tokens: string[];
    actions?: Record<string, LexerAction>;
    unicode?: boolean;
}

export function createEbnfLexer(source: string, options: EbnfLexerOptions): LexerGrammar;

export interface PrecedenceLevel {
    type: Associativity;
    tokens: string[];
}

export interface EbnfParserOptions {
    start: string;
    tokens?: string[];
    actions?: Record<string, Array<(args: Token[]) => unknown>>;
    precedence?: PrecedenceLevel[];
    precedenceOverrides?: Record<string, Record<string, string>>;
    ignoreTokens?: string[];
    actionContext?: Record<string, unknown>;
    algorithm?: ParserAlgorithm;
}

export interface GrammarProduction {
    rule: string[];
    action?: (args: Token[]) => unknown;
    prec?: string;
}

export interface ParserRules {
    start: string;
    states: Record<string, { rules: GrammarProduction[] }>;
    precedence?: PrecedenceLevel[];
    ignoreTokens?: string[];
    diagnostics?: Diagnostic[];
    algorithm?: ParserAlgorithm;
}

export class ParserConflictError extends Error {
    constructor(details: { state: number; token: string; actions: object[] });
    state: number;
    token: string;
    actions: object[];
}

export function createParser(rules: ParserRules): ParserConfig;
export function compileEbnfGrammar(source: string, options: EbnfParserOptions): ParserRules;
export function createEbnfParser(source: string, options: EbnfParserOptions): ParserConfig;

export interface JisonGrammar {
    bnf: Record<string, string | [string, string] | Array<string | [string, string]>>;
    operators?: Array<[Associativity, ...string[]]>;
    startSymbol?: string;
    lex?: JisonLexer;
}

export interface MigrationWarning {
    code: string;
    message: string;
    rule?: string;
    ruleIndex?: number;
    pattern?: string;
}

export interface ConvertedJisonGrammar {
    source: string;
    options: Pick<EbnfParserOptions, 'start' | 'precedence' | 'precedenceOverrides'>;
    warnings: MigrationWarning[];
    manualActions: Record<string, Array<{ action: string; manual: boolean }>>;
}

export function convertJisonGrammar(
    grammar: JisonGrammar,
    options?: { tokenAliases?: Record<string, string> }
): ConvertedJisonGrammar;

export interface JisonLexer {
    rules: Array<[string, string]>;
}

export interface ConvertedJisonLexer {
    source: string;
    tokens: string[];
    ignoreTokens: string[];
    tokenAliases: Record<string, string>;
    warnings: MigrationWarning[];
}

export function convertJisonLexer(lexer: JisonLexer): ConvertedJisonLexer;
