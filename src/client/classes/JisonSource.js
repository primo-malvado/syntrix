function syntaxError (message) {
    return new SyntaxError(`Jison source: ${message}`);
}

function decodeQuoted (value) {
    if (value[0] === '"') return JSON.parse(value);
    return value.slice(1, -1).replace(/\\(.)/g, (_, character) => {
        const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
        return escapes[character] ?? character;
    });
}

function words (source) {
    const values = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
    return values.map(value => value[0] === '"' || value[0] === "'"
        ? decodeQuoted(value)
        : value);
}

function normalizeLexerPattern (pattern) {
    if (pattern.length < 2 || !['"', "'"].includes(pattern[0]) ||
        pattern.at(-1) !== pattern[0]) return pattern;
    return decodeQuoted(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineMarker (lines, marker, start = 0) {
    return lines.findIndex((line, index) => index >= start && line.trim() === marker);
}

function splitLexRule (line) {
    let quote = null;
    let inClass = false;
    let depth = 0;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '[') {
            inClass = true;
        } else if (character === ']') {
            inClass = false;
        } else if (!inClass && character === '(') {
            depth++;
        } else if (!inClass && character === ')') {
            depth--;
        } else if (!inClass && depth === 0 && /\s/.test(character)) {
            const pattern = line.slice(0, index).trim();
            const action = line.slice(index).trim();
            if (pattern && action) return [pattern, action];
        }
    }
    return null;
}

function macroDefinitions (lines) {
    const macros = Object.create(null);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('/*')) continue;
        const definition = splitLexRule(line);
        if (!definition || !/^[A-Za-z_]\w*$/.test(definition[0])) {
            throw syntaxError(`unsupported lexer macro: ${line}`);
        }
        const [name, pattern] = definition;
        if (Object.hasOwn(macros, name)) throw syntaxError(`duplicate lexer macro ${name}`);
        macros[name] = normalizeLexerPattern(pattern);
    }
    return macros;
}

function expandMacros (pattern, macros, parents = []) {
    let result = '';
    for (let index = 0; index < pattern.length;) {
        if (pattern[index] === '\\') {
            result += pattern.slice(index, index + 2);
            index += 2;
        } else if (pattern[index] === '[') {
            const start = index++;
            let escaped = false;
            while (index < pattern.length) {
                const character = pattern[index++];
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === ']') break;
            }
            result += pattern.slice(start, index);
        } else if (pattern[index] === '{') {
            const match = pattern.slice(index).match(/^\{([A-Za-z_]\w*)\}/);
            if (!match) {
                result += pattern[index++];
                continue;
            }
            const name = match[1];
            if (!Object.hasOwn(macros, name)) throw syntaxError(`unknown lexer macro ${name}`);
            if (parents.includes(name)) {
                throw syntaxError(`cyclic lexer macro reference: ${[...parents, name].join(' -> ')}`);
            }
            result += `(?:${expandMacros(macros[name], macros, [...parents, name])})`;
            index += match[0].length;
        } else {
            result += pattern[index++];
        }
    }
    return result;
}

function parseLexRules (lines) {
    const delimiter = lineMarker(lines, '%%');
    if (delimiter < 0) throw syntaxError('the %lex section is missing its %% rule delimiter');
    const macros = macroDefinitions(lines.slice(0, delimiter));
    const rules = [];
    let pendingPattern = null;
    const ruleLines = lines.slice(delimiter + 1);
    for (let index = 0; index < ruleLines.length; index++) {
        const rawLine = ruleLines[index];
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;
        const split = pendingPattern === null ? splitLexRule(line) : null;
        let pattern = pendingPattern;
        let action = line;
        if (split) [pattern, action] = split;
        else if (pendingPattern === null) {
            pendingPattern = line;
            continue;
        }

        pattern = normalizeLexerPattern(pattern);
        if (action.startsWith('{')) {
            const combined = [action, ...ruleLines.slice(index + 1)].join('\n');
            let actionEnd;
            [action, actionEnd] = readAction(combined, 0);
            const trailing = combined.slice(actionEnd).split('\n')[0].trim();
            if (trailing && !trailing.startsWith('//') && !trailing.startsWith('/*')) {
                throw syntaxError('unexpected text after a lexer action block');
            }
            const consumedLines = combined.slice(0, actionEnd).split('\n').length - 1;
            index += consumedLines;
        }
        rules.push([expandMacros(pattern, macros), action.trim()]);
        pendingPattern = null;
    }
    if (pendingPattern !== null) {
        throw syntaxError(`lexer rule ${pendingPattern} has no action`);
    }
    if (!rules.length) throw syntaxError('the %lex section contains no lexer rules');
    return rules;
}

function extractLexer (source) {
    const lines = source.split(/\r?\n/);
    const starts = lines.reduce((indices, line, index) => {
        if (line.trim() === '%lex') indices.push(index);
        return indices;
    }, []);
    if (!starts.length) return { source, lex: undefined };
    if (starts.length !== 1) throw syntaxError('only one %lex section is supported');

    const start = starts[0];
    const end = lines.findIndex((line, index) => index > start && line.trim() === '/lex');
    if (end < 0) throw syntaxError('the %lex section is missing its /lex terminator');
    const lex = parseLexRules(lines.slice(start + 1, end));
    return {
        source: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n'),
        lex
    };
}

function parseDeclarations (source) {
    const operators = [];
    let startSymbol;
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('/*')) continue;
        if (line.startsWith('%{')) {
            throw syntaxError('JavaScript prologues require manual migration');
        }
        const declaration = line.match(/^%(start|left|right|nonassoc|token|type)\b(.*)$/);
        if (!declaration) throw syntaxError(`unsupported declaration: ${line}`);
        const [, directive, body] = declaration;
        const values = words(body);
        if (directive === 'token' || directive === 'type') continue;
        if (!values.length) throw syntaxError(`%${directive} requires a value`);
        if (directive === 'start') {
            if (values.length !== 1 || startSymbol) {
                throw syntaxError('%start must declare exactly one start symbol');
            }
            startSymbol = values[0];
        } else {
            operators.push([directive, ...values]);
        }
    }
    return { startSymbol, operators };
}

function readQuoted (source, start) {
    const quote = source[start];
    let escaped = false;
    for (let index = start + 1; index < source.length; index++) {
        const character = source[index];
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) return [source.slice(start, index + 1), index + 1];
    }
    throw syntaxError('unterminated quoted terminal');
}

function readAction (source, start) {
    let depth = 1;
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    let escaped = false;
    for (let index = start + 1; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') quote = character;
        else if (character === '/' && next === '/') lineComment = true;
        else if (character === '/' && next === '*') {
            blockComment = true;
            index++;
        } else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) {
            return [source.slice(start + 1, index), index + 1];
        }
    }
    throw syntaxError('unterminated parser action');
}

function skipTrivia (source, position) {
    while (position < source.length) {
        if (/\s/.test(source[position])) {
            position++;
        } else if (source.startsWith('//', position)) {
            const newline = source.indexOf('\n', position + 2);
            position = newline < 0 ? source.length : newline + 1;
        } else if (source.startsWith('/*', position)) {
            const end = source.indexOf('*/', position + 2);
            if (end < 0) throw syntaxError('unterminated comment');
            position = end + 2;
        } else {
            break;
        }
    }
    return position;
}

function parseRules (source) {
    const bnf = Object.create(null);
    let position = 0;
    while ((position = skipTrivia(source, position)) < source.length) {
        const rule = source.slice(position).match(/^([A-Za-z_$][\w$]*)/);
        if (!rule) throw syntaxError(`expected a rule name near ${source.slice(position, position + 24)}`);
        const name = rule[1];
        if (Object.hasOwn(bnf, name)) throw syntaxError(`duplicate rule ${name}`);
        position += name.length;
        position = skipTrivia(source, position);
        if (source[position] !== ':') throw syntaxError(`expected : after rule ${name}`);
        position++;

        const alternatives = [];
        let body = '';
        let action = '';
        while (position < source.length) {
            const character = source[position];
            if (character === '"' || character === "'") {
                const [quoted, end] = readQuoted(source, position);
                body += quoted;
                position = end;
            } else if (source.startsWith('/*', position)) {
                const end = source.indexOf('*/', position + 2);
                if (end < 0) throw syntaxError('unterminated comment in a rule');
                const comment = source.slice(position, end + 2);
                body += /\/\*\s*empty\s*\*\//i.test(comment) ? ' /* empty */ ' : ' ';
                position = end + 2;
            } else if (source.startsWith('//', position)) {
                const end = source.indexOf('\n', position + 2);
                body += ' ';
                position = end < 0 ? source.length : end + 1;
            } else if (character === '{') {
                if (action) throw syntaxError(`rule ${name} has more than one action in an alternative`);
                [action, position] = readAction(source, position);
            } else if (character === '|' || character === ';') {
                const production = body.trim();
                alternatives.push(action ? [production, action] : production);
                body = '';
                action = '';
                position++;
                if (character === ';') break;
            } else {
                body += character;
                position++;
            }
        }
        if (source[position - 1] !== ';') throw syntaxError(`rule ${name} is missing its ; terminator`);
        bnf[name] = alternatives;
    }
    if (!Object.keys(bnf).length) throw syntaxError('no parser rules found');
    return bnf;
}

export function parseJisonSource (source) {
    if (typeof source !== 'string') throw new TypeError('Jison source must be a string');
    const extracted = extractLexer(source);
    const lines = extracted.source.split(/\r?\n/);
    const delimiter = lineMarker(lines, '%%');
    if (delimiter < 0) throw syntaxError('the parser section is missing its %% delimiter');
    const declarations = parseDeclarations(lines.slice(0, delimiter).join('\n'));
    return {
        ...declarations,
        bnf: parseRules(lines.slice(delimiter + 1).join('\n')),
        ...(extracted.lex ? { lex: { rules: extracted.lex } } : {})
    };
}
