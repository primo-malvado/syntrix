import { ebnfLexerTable, ebnfParserConfig } from './Ebnf.generated.js';
import Lexer from './Lexer.js';
import Parser from './Parser.js';

const escapes = {
    n: '\n', r: '\r', t: '\t', f: '\f', v: '\v',
    '\\': '\\', '"': '"', "'": "'"
};

function syntaxError (source, message, position) {
    const before = source.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    return new SyntaxError(`${message} at ${line}:${column}`);
}

function stripComments (source) {
    const characters = source.split('');
    let quote = null;
    for (let position = 0; position < source.length; position++) {
        const char = source[position];
        if (quote) {
            if (char === '\\') {
                position++;
            } else if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (source.startsWith('(*', position)) {
            const end = source.indexOf('*)', position + 2);
            if (end === -1) throw syntaxError(source, 'Unterminated comment', position);
            for (let index = position; index < end + 2; index++) {
                if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
            }
            position = end + 1;
        }
    }
    return characters.join('');
}

function actionBlock (source, start) {
    let depth = 1;
    let quote = null;
    for (let position = start + 1; position < source.length; position++) {
        const char = source[position];
        if (quote) {
            if (char === '\\') position++;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'" || char === '`') {
            quote = char;
        } else if (char === '{') {
            depth++;
        } else if (char === '}' && --depth === 0) {
            return { source: source.slice(start + 1, position), end: position + 1 };
        }
    }
    throw syntaxError(source, 'Unterminated action', start);
}

function extractActions (source) {
    const characters = source.split('');
    const actions = new Map();
    let rule;
    let alternative = 0;
    let depth = 0;
    let quote = null;
    for (let position = 0; position < source.length; position++) {
        const char = source[position];
        if (quote) {
            if (char === '\\') position++;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
        } else if (source.startsWith('(*', position)) {
            const end = source.indexOf('*)', position + 2);
            if (end === -1) break;
            position = end + 1;
        } else if (char === '=' && depth === 0) {
            const match = source.slice(0, position).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
            rule = match?.[1];
            alternative = 0;
        } else if (char === '(' || char === '[') {
            depth++;
        } else if (char === ')' || char === ']') {
            depth--;
        } else if (char === '|' && depth === 0) {
            alternative++;
        } else if (char === '{') {
            const block = actionBlock(source, position);
            if (/\$\d+|\$\$|\breturn\b|\byytext\b/.test(block.source)) {
                if (!rule) throw syntaxError(source, 'Action must follow a grammar rule', position);
                if (!actions.has(rule)) actions.set(rule, new Map());
                actions.get(rule).set(alternative, block.source);
                for (let index = position; index < block.end; index++) {
                    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
                }
                position = block.end - 1;
            } else {
                depth++;
            }
        } else if (char === '}') {
            depth--;
        } else if (char === ';' && depth === 0) {
            rule = undefined;
        }
    }
    return { source: characters.join(''), actions };
}

function literalError (source, startPosition) {
    const quote = source[startPosition];
    for (let position = startPosition + 1; position < source.length; position++) {
        if (source[position] === '\\') {
            position++;
            if (position === source.length) return ['Unterminated string', position];
            if (!Object.hasOwn(escapes, source[position])) {
                return ['Unknown escape', position];
            }
        } else if (source[position] === quote) {
            return null;
        }
    }
    return ['Unterminated string', source.length];
}

function decodeLiteral (raw) {
    let value = '';
    for (let position = 1; position < raw.length - 1; position++) {
        if (raw[position] === '\\') value += escapes[raw[++position]];
        else value += raw[position];
    }
    return value;
}

class EbnfTokenLexer {
    constructor () {
        this.lexer = new Lexer(ebnfLexerTable);
    }

    get YYCURSOR () {
        return this.lexer.YYCURSOR;
    }

    setInput (source) {
        if (this.source === source) return;
        this.source = source;
        const withoutComments = stripComments(source);
        this.isEmpty = withoutComments.trim().length === 0;
        this.lexer.setInput(withoutComments);
    }

    finishInput () {
        this.lexer.finishInput();
    }

    read (token) {
        if (token.tokenType === 'literal') {
            return { ...token, content: decodeLiteral(token.content) };
        }
        return token;
    }

    normalize (error) {
        const match = error.message.match(/Lexer: unexpected input (?:(?:"[^"]*") )?at position (\d+)/);
        const position = error.position ?? (match ? Number(match[1]) : null);
        if (position === null) throw error;
        const literalIssue = ['"', "'"].includes(this.lexer.input[position])
            ? literalError(this.lexer.input, position)
            : null;
        if (literalIssue) throw syntaxError(this.source, literalIssue[0], literalIssue[1]);
        throw syntaxError(
            this.source,
            `Unexpected character ${JSON.stringify(this.source[position])}`,
            position
        );
    }

    readToken () {
        try {
            return this.read(this.lexer.readToken());
        } catch (error) {
            return this.normalize(error);
        }
    }

    popToken () {
        try {
            return this.read(this.lexer.popToken());
        } catch (error) {
            return this.normalize(error);
        }
    }
}

export function parseEbnf (source) {
    if (typeof source !== 'string') throw new TypeError('EBNF source must be a string');

    const extracted = extractActions(source);
    const lexer = new EbnfTokenLexer();
    lexer.setInput(extracted.source);
    if (lexer.isEmpty) throw new SyntaxError('EBNF must contain at least one rule');

    const parser = new Parser(lexer, ebnfParserConfig);
    let definitions;
    try {
        definitions = parser.parse(extracted.source);
    } catch (error) {
        const missingSemicolon = error.message.match(/Unexpected token eof at position (\d+); expected: (.+)/);
        if (missingSemicolon && missingSemicolon[2].split(', ').includes(';')) {
            const position = Number(missingSemicolon[1]);
            throw syntaxError(source, 'Expected ;, found eof', position);
        }
        throw error;
    }

    const rules = new Map();
    for (const [name, expression] of definitions) {
        if (rules.has(name)) throw new SyntaxError(`Duplicate EBNF rule ${name}`);
        rules.set(name, expression);
    }
    Object.defineProperty(rules, 'actions', { value: extracted.actions });
    return rules;
}
