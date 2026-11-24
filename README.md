# Syntrix

[GitHub repository](https://github.com/primo-malvado/syntrix)

Syntrix creates lexers and parsers from EBNF grammars. The basic workflow is:

1. Define tokens with a lexical grammar.
2. Define the language structure with a parser grammar.
3. Generate the lexer and parser tables.
4. Parse input with `Lexer` and `Parser`.
5. Optionally, associate semantic actions with tokens and rules.

## Why Syntrix?

Syntrix is designed as a modern JavaScript alternative to traditional
Yacc-style tools: it uses readable EBNF, exposes a typed ESM API, and supports
LALR(1), canonical LR(1), SLR(1), GLR, incremental input, and structured
diagnostics in the same package.

Choose it when you need:

- grammar source that is easy to read and review;
- a browser-friendly ESM package and TypeScript declarations;
- incremental parsing for editors, streams, or large inputs;
- GLR derivations or a packed GLR forest for ambiguous grammars;
- generated parser modules without a runtime code-generation step.

Syntrix is not a drop-in replacement for every Jison feature. The parser
and lexer converters below cover useful subsets of Jison's grammar formats,
while Jison-specific runtime APIs still need to be migrated manually.

## Installation

```bash
npm install syntrix
```

Import the ESM API:

```js
import {
    Lexer,
    Parser,
    createEbnfLexer,
    createEbnfParser
} from 'syntrix';
```

## Explore automata

For automata exploration, the public `regexToNfa`, `regexToDfa`, and
`determinize` functions expose transition tables. For example:

```js
import { regexToNfa, determinize } from 'syntrix';
const nfa = regexToNfa('a(b|c)*');
const dfa = determinize(nfa);
// Each machine has start and end state arrays and a table of transitions.
```

The regular-expression converter supports the library's regex syntax, including
concatenation, `|`, `*`, `+`, `?`, groups and ordered character ranges. This is
not the full JavaScript RegExp syntax. `ε` is reserved for epsilon transitions
and cannot appear in a character range.

## 1. Write the lexical grammar

A lexical grammar defines how text is split into tokens. Each rule ends with
`;`.

```ebnf
NUMBER = "0".."9", { "0".."9" };
PLUS = "+";
STAR = "*";
LP = "(";
RP = ")";
SPACE = " ", { " " };
```

`"0".."9"` represents a character range. `{ ... }` repeats an expression zero
or more times. The lexer receives a list of the names that should produce
tokens:

```js
const lexerTable = createEbnfLexer(`
    NUMBER = "0".."9", { "0".."9" };
    PLUS = "+";
    STAR = "*";
    LP = "(";
    RP = ")";
    SPACE = " ", { " " };
`, {
    tokens: ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP', 'SPACE']
});
```

By default, the token's content is stored in `token.content` and is also
available through `token.value`. The `value` property is a non-enumerable alias,
so existing object serialization stays unchanged. A lexical action can
transform the token:

```js
const lexerTable = createEbnfLexer(`
    NUMBER = "0".."9", { "0".."9" };
    PLUS = "+";
    STAR = "*";
    LP = "(";
    RP = ")";
    SPACE = " ", { " " };
`, {
    tokens: ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP', 'SPACE'],
    actions: {
        NUMBER: lexer => ({
            tokenType: 'NUMBER',
            content: Number(lexer.yytext)
        }),
        PLUS: lexer => ({
            tokenType: 'PLUS',
            content: lexer.yytext
        })
    }
});
```

Use `ignoreTokens` in the parser to discard spaces:

```js
ignoreTokens: ['SPACE']
```

## 2. Write the parser grammar

The parser grammar defines how tokens form the language's structures. A comma
separates elements, `|` separates alternatives, and `;` ends a rule:

```ebnf
entry = expr;
expr = expr, PLUS, expr
     | expr, STAR, expr
     | LP, expr, RP
     | NUMBER;
```

In EBNF, `[...]` makes a part optional, `{...}` repeats it, and `(...)` creates
a group.

Generate the parser table:

```js
const parserTable = createEbnfParser(`
    entry = expr;
    expr = expr, PLUS, expr
         | expr, STAR, expr
         | LP, expr, RP
         | NUMBER;
`, {
    start: 'entry',
    tokens: ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP'],
    ignoreTokens: ['SPACE']
});
```

`start` identifies the start rule. `tokens` identifies the parser's terminal
symbols. The names must match the `tokenType` values produced by the lexer.

## 3. Create the lexer and parser

```js
const lexer = new Lexer(lexerTable);
const parser = new Parser(lexer, parserTable);

const result = parser.parse('(2 + 3) * 4');
console.log(result);
```

Without semantic actions, the result follows the default reduction:

```js
[
    tokenOrResult,
    ...
]
```

When a rule has no action, the elements of the reduction are returned in
`rules`; in a regular parser, non-terminals also expose the rule's result in
the `rules` field. Both terminals and reduced non-terminals also expose their
semantic value through `value`.

## 4. Add semantic actions

Each rule has an array of actions. Each position corresponds to an alternative
of the rule, in the same order:

```js
const parserTable = createEbnfParser(`
    entry = expr;
    expr = expr, PLUS, expr
         | expr, STAR, expr
         | LP, expr, RP
         | NUMBER;
`, {
    start: 'entry',
    tokens: ['NUMBER', 'PLUS', 'STAR', 'LP', 'RP'],
    ignoreTokens: ['SPACE'],
    precedence: [
        { type: 'left', tokens: ['PLUS'] },
        { type: 'left', tokens: ['STAR'] }
    ],
    actions: {
        entry: [
            args => args[0].rules
        ],
        expr: [
            args => args[0].rules + args[2].rules,
            args => args[0].rules * args[2].rules,
            args => args[1].rules,
            args => args[0].content
        ]
    }
});
```

Each `args` array contains the elements of the alternative:

- `args[n].content` contains a token's text or value.
- `args[n].rules` contains the semantic value of a non-terminal.
- `args[n].value` provides a uniform alias for either field.

Actions can also be written directly after an alternative, using Jison-style
references:

```ebnf
entry = NUMBER { $$ = Number($1); };
```

`$1`, `$2`, and so on refer to the alternative's values, while `$$` is the
value produced by the rule. Embedded actions run as JavaScript and may use
helpers supplied through `actionContext`:

```js
createEbnfParser(grammar, {
    start: 'entry',
    tokens: ['NUMBER'],
    actionContext: { Number }
});
```

Only use embedded actions with grammar source you trust. The `actions` option
continues to support externally defined functions.

With these actions:

```js
new Parser(new Lexer(lexerTable), parserTable).parse('(2 + 3) * 4');
// 20
```

If the lexer defines `NUMBER` with an action that returns `Number(lexer.yytext)`,
the fourth `expr` action can use `Number(args[0].content)`.

## 5. Use precedence

For arithmetic expressions, declare precedence levels from lowest to highest:

```js
precedence: [
    { type: 'left', tokens: ['PLUS'] },
    { type: 'left', tokens: ['STAR'] }
]
```

Available associativities:

- `left`
- `right`
- `nonassoc`

For a specific alternative, use `precedenceOverrides`:

```js
precedenceOverrides: {
    expr: {
        0: 'PLUS'
    }
}
```

## 6. Select the algorithm

By default, `createEbnfParser` uses LALR(1):

```js
createEbnfParser(grammar, {
    start: 'entry',
    tokens: ['NUMBER'],
    algorithm: 'lalr1'
});
```

Available algorithms:

- `slr1`: uses FOLLOW sets.
- `lalr1`: LALR(1), suitable for most languages.
- `lr1`: canonical LR(1), without state merging.
- `glr`: preserves alternative derivations instead of resolving conflicts.

In `glr` mode, `parse()` returns a list of all derivations:

```js
const parserTable = createEbnfParser(grammar, {
    start: 'entry',
    tokens,
    algorithm: 'glr'
});

const results = new Parser(new Lexer(lexerTable), parserTable).parse(input);
```

## 7. Incremental parsing

Start an incremental parse:

```js
parser.start();
parser.push('12 +');
parser.push(' 3');
const result = parser.finish();
```

Use `parse()` for complete input.

To stream characters into the lexer:

```js
const lexer = new Lexer(lexerTable, {
    discardConsumedInput: false
});

lexer.setInput('', { final: false });
lexer.appendInput('12 ');

let token;
while ((token = lexer.nextToken()) !== null) {
    console.log(token);
}

lexer.appendInput('+ 3');
while ((token = lexer.nextToken()) !== null) {
    console.log(token);
}

lexer.finishInput();
while ((token = lexer.nextToken()) !== null) {
    console.log(token);
}
```

While a token cannot yet be determined, `nextToken()` returns `null`.

## 8. Handle errors

Lexical errors are `SyntaxError` instances and include position, line, and column:

```js
try {
    parser.parse('12 @ 3');
} catch (error) {
    console.error(error.message);
    console.error(error.position, error.line, error.column);
}
```

Syntax errors use `ParserSyntaxError`:

```js
import { ParserSyntaxError } from 'syntrix';

try {
    parser.parse('12 + * 3');
} catch (error) {
    if (error instanceof ParserSyntaxError) {
        console.error(error.expected);
        console.error(error.position, error.line, error.column);
    } else {
        throw error;
    }
}
```

## 9. Use the CLI

Validate a grammar:

```bash
syntrix check grammar.ebnf
```

Validate with a start rule and known tokens:

```bash
syntrix check grammar.ebnf --start entry --tokens NUMBER,PLUS,STAR
```

Generate a JSON file with the tables:

```bash
syntrix generate grammar.ebnf \
    --start entry \
    --tokens NUMBER,PLUS,STAR,LP,RP \
    --lexer-tokens NUMBER,PLUS,STAR,LP,RP,SPACE \
    --ignore SPACE \
    --out parser.json
```

If the lexical rules are in a separate file:

```bash
syntrix generate grammar.ebnf \
    --lexer-grammar lexer.ebnf \
    --start entry \
    --tokens NUMBER,PLUS,STAR,LP,RP \
    --lexer-tokens NUMBER,PLUS,STAR,LP,RP,SPACE \
    --ignore SPACE \
    --out parser.json
```

Generate a reusable ESM module:

```bash
syntrix generate grammar.ebnf \
    --lexer-grammar lexer.ebnf \
    --start entry \
    --tokens NUMBER,PLUS,STAR,LP,RP \
    --lexer-tokens NUMBER,PLUS,STAR,LP,RP,SPACE \
    --ignore SPACE \
    --actions actions.mjs \
    --format module \
    --out generated-parser.mjs
```

The generated module exports `lexerTable` and `parserConfig`:

```js
import { Lexer, Parser } from 'syntrix';
import { lexerTable, parserConfig } from './generated-parser.mjs';

const parser = new Parser(new Lexer(lexerTable), parserConfig);
console.log(parser.parse('(2 + 3) * 4'));
```

Parse a file with the CLI:

```bash
syntrix parse grammar.ebnf input.txt \
    --lexer-grammar lexer.ebnf \
    --start entry \
    --tokens NUMBER,PLUS,STAR,LP,RP \
    --lexer-tokens NUMBER,PLUS,STAR,LP,RP,SPACE \
    --ignore SPACE
```

## Migrate from Jison

The parser part of a Jison grammar can be converted from its JavaScript
configuration object:

```js
import { convertJisonGrammar, createEbnfParser } from 'syntrix';

const converted = convertJisonGrammar({
    startSymbol: 'expression',
    operators: [
        ['left', 'PLUS'],
        ['left', 'STAR']
    ],
    bnf: {
        expression: [
            ['expression PLUS expression', '$$ = $1 + $3;'],
            ['expression STAR expression', '$$ = $1 * $3;'],
            ['NUMBER', '$$ = Number($1);']
        ]
    }
});

const parserTable = createEbnfParser(converted.source, {
    ...converted.options,
    tokens: ['NUMBER', 'PLUS', 'STAR']
});
```

Common Jison lexer rules can be converted separately:

```js
import { convertJisonLexer, createEbnfLexer } from 'syntrix';

const lexer = convertJisonLexer({
    rules: [
        ['\\s+', '/* skip whitespace */'],
        ['[0-9]+', 'return "NUMBER";'],
        ['\\+', 'return "PLUS";']
    ]
});

const lexerTable = createEbnfLexer(lexer.source, { tokens: lexer.tokens });
```

For a Jison JSON configuration or a `.jison` source file using the supported
syntax subset, the CLI can write the converted files:

```bash
syntrix migrate-jison grammar.json --out migrated/
syntrix migrate-jison grammar.jison --out migrated/
```

This creates `parser.ebnf`, `lexer.ebnf` when a `lex` section is present, and
`syntrix.json` with the start rule, precedence, and available token lists. Review
the generated files before using them in production; unsupported Jison
features are reported instead of being silently dropped. Source files support
`%lex` sections with `%%` and `/lex` delimiters, simple lex macros, `%start`,
`%token`, `%type`, associativity declarations, and ordinary BNF rule
alternatives with JavaScript action blocks. Single- and multiline lexer action
blocks are accepted when they reduce to a supported `return` or skip action.
JavaScript prologues, lex options, and unknown declarations are rejected
explicitly. When parser actions depend on Jison runtime state, the CLI also
creates `actions.mjs` with external
action implementations for the affected rule and explicit throwing stubs for
actions that need manual porting. The manifest's `actionsModule` field names
this file; pass it to `syntrix generate --actions` after reviewing and
editing the stubs.

The parser converter supports `bnf` rules represented as strings or
`[body, action]` pairs, `startSymbol`, `operators` entries for `left`, `right`,
and `nonassoc`, `%prec TOKEN` overrides, and `/* empty */` productions. The
lexer converter supports common literals, character classes, capturing and
non-capturing groups, nested alternation, `+`, `*`, `?`, common escapes,
bounded repetitions up to 128 copies, whitespace skipping, and `return "TOKEN"`
or literal-token actions. Literal
tokens receive generated names and are mapped consistently in the parser and
precedence declarations. Default token content preserves the matched text, and
simple parser actions using `yytext` receive the last terminal's content.

Jison runtime APIs such as `yy`, `parseError`, and custom `this` properties are
not emulated. Negated classes, anchors, bounded quantifiers, unsupported
escapes, `<<EOF>>`, and arbitrary lexer actions must still be migrated manually.
The CLI records unsupported lexer rules as
`MIGRATION REQUIRED` comments, writes structured warnings to
`syntrix.json`, and prints them to stderr. Review every warning before
using generated grammars. The converters do not claim to be a complete `.y`
or `lex` file converter.

### Complete migration example

The [Jison migration example](./examples/jison-migration/grammar.json) contains
a parser and lexer configuration. Run the converted parser with:

```bash
node examples/jison-migration/run.mjs
```

It evaluates `2 + 3 * 4` to `14`. The example imports the repository source so
it runs in this checkout; in a consuming project, import the same APIs from
`syntrix`.

| Jison | Syntrix |
| --- | --- |
| `bnf` / `operators` | `convertJisonGrammar()` and `createEbnfParser()` |
| `lex.rules` | `convertJisonLexer()` and `createEbnfLexer()` |
| `$1`, `$2`, `$$` | Embedded actions |
| `%left`, `%right`, `%nonassoc` | `operators` or `precedence` |
| `parseError` | `ParserSyntaxError`, `ParserParseError`, `recoverErrors` |
| Generated CommonJS parser | Generated ESM module via the CLI |

## Performance and reproducibility

Run the built-in benchmarks with JSON output to record the environment and
measured workload:

```bash
npm run benchmark -- --json
npm run benchmark:memory -- --json
npm run benchmark:corpus -- --json
```

The comparative benchmarks require Jison separately; it is not a Syntrix
dependency. In the repository checkout, install the comparison version without
changing the dependency manifest or lockfile, then run:

```bash
npm install --no-save --package-lock=false jison@0.3.12
npm run benchmark:compare -- --json
npm run benchmark:memory:compare -- --json
```

The regular test suite skips the two comparative benchmark tests when Jison is
absent; installing it also enables those tests. The other benchmarks and Jison
grammar migration features do not require the Jison package.

`benchmark:compare` runs the same expression workloads through Syntrix and the
installed Jison version, validating that both produce the same results. Each measurement
uses separate implementation processes, alternates execution order across
pairs, and reports medians/P95 plus whether the minimum process-pair sample
count was met. Increase `--samples` for a larger report and use `--min-samples`
to set its sufficiency threshold. `benchmark:memory:compare` likewise runs each
implementation in separate `--expose-gc` processes and aggregates repeated
process pairs; use `--pairs` and `--min-pairs` to control its sample count and
minimum. Reports record the installed Jison version; use the recommended legacy
0.3.12 release for reproducibility, not as a claim about every Jison version.
The other commands report generation,
lexing, streaming, memory, and corpus metrics for Syntrix.

Results depend on grammar shape, generated code, Node version, and measurement
settings. Treat the comparison as an engineering baseline, not a universal
performance claim; publish the raw JSON and environment when sharing results.

## Supported EBNF syntax

```ebnf
rule = "literal";
range = "a".."z";
sequence = first, second;
alternatives = first | second;
optional = [ first ];
repeat = { first };
group = ( first | second );
empty = "";
comment = (* comment *);
```

Single and double quotes are accepted in literals. Supported escapes are
`\\`, `\"`, `\'`, `\n`, `\r` e `\t`.

The implementation does not cover all ISO EBNF extensions, such as exceptions
and special sequences.

## Advanced features

### Lexer states

Lexers with contexts can use `pushState`, `beginState`, `popState`, and
`currentState()` in lexical actions:

```js
COMMENT: lexer => {
    lexer.pushState('COMMENT');
    return { tokenType: 'COMMENT_START', content: lexer.yytext };
}
```

### Unicode

To consume Unicode code points instead of UTF-16 code units:

```js
const lexerTable = createEbnfLexer(grammar, {
    tokens,
    unicode: true
});
```

Character positions remain based on UTF-16 offsets.

### Channels

Tokens can belong to different channels:

```js
{ tokenType: 'COMMENT', channel: 'trivia', content: '...' }
```

By default, the parser reads only the `default` channel. Use `channels` in the
parser to consume additional channels:

```js
const parser = new Parser(lexer, {
    ...parserTable,
    channels: ['default', 'trivia']
});
```

### Error recovery

```js
const parser = new Parser(lexer, {
    ...parserTable,
    recoverErrors: true
});

parser.parse(input);
console.log(parser.errors);
```

In this mode, the parser attempts to continue after unexpected tokens.

### GLR forest

In GLR mode, a compact forest can avoid enumerating every derivation:

```js
const parser = new Parser(lexer, {
    ...parserTable,
    forest: true
});

const forest = parser.parse(input);
```

Semantic actions are not executed in this mode.

## Development

To open the interactive Angular site:

```bash
npm run dev
```

To generate the static site:

```bash
npm run build:site
```

The output is in `dist-site/`. The playground uses a scientific calculator:
you can edit the lexical and parser grammars, change the expression, and
choose the algorithm. The example's semantic actions are fixed, so the rules
and order of alternatives must remain compatible with those actions. Token
names are also fixed, although their lexical rules can be edited.

```bash
npm test
npm run build
npm run typecheck
```

### Publishing

Pushes to `master` run the tests and build the library and demo. After a
successful build, GitHub Actions deploys the demo to GitHub Pages and publishes
the version in `package.json` to npm if that version does not already exist.
Update the version in both `package.json` and `package-lock.json` (for example
with `npm version patch --no-git-tag-version`) before publishing a new release.
The npm package and CLI command are both named `syntrix`.

Before enabling automatic publication:

1. In GitHub repository settings, enable Pages and select **GitHub Actions** as
   the source. The build uses the configured Pages base path.
2. Publish the first `syntrix` version manually from an npm account that owns
   the name: run `npm ci`, `npm test`, `npm run build`, then
   `npm publish --access public`. Check that the name is still available first.
3. In the npm package settings, configure a GitHub Actions trusted publisher
   for owner `primo-malvado`, repository `syntrix`, and workflow filename
   `publish.yml`. Allow direct `npm publish`. No npm token is needed in GitHub.
   Complete the first trusted publish within the npm configuration's validity
   period by incrementing the version and pushing to `master`.

The workflow can also be started manually from the Actions tab. Existing
versions are skipped; registry and publication errors fail the npm job.
