function assertString (value, name) {
    if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
    return value;
}

function productionParts (production, rule) {
    if (typeof production === 'string') return { body: production, action: '' };
    if (!Array.isArray(production) || production.length < 1 || production.length > 2) {
        throw new TypeError(`Invalid Jison production for ${rule}`);
    }
    return {
        body: assertString(production[0], `${rule} production`),
        action: production[1] === undefined ? '' : assertString(production[1], `${rule} action`)
    };
}

function decodeQuoted (value) {
    if (value[0] === '"') return JSON.parse(value);
    return value.slice(1, -1).replace(/\\(.)/g, (_, character) => {
        const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
        return escapes[character] ?? character;
    });
}

function convertBody (body, aliases) {
    const trimmed = body.trim();
    if (!trimmed || trimmed === '/* empty */') return '""';
    const symbols = trimmed.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
    return symbols.map(symbol => {
        if (symbol.startsWith('"') || symbol.startsWith("'")) {
            const literal = decodeQuoted(symbol);
            return aliases[literal] || JSON.stringify(literal);
        }
        return aliases[symbol] || symbol;
    }).join(', ');
}

function convertAlternative (production, rule, aliases, warnings) {
    const { body, action } = productionParts(production, rule);
    const precedence = body.match(/\s+%prec\s+([^\s]+)$/);
    const syntax = convertBody(precedence ? body.slice(0, precedence.index) : body, aliases);
    const requiresManualAction = /\byy\s*\./.test(action) ||
        /\bthis\s*\./.test(action) || /@\s*\$?\d*/.test(action);
    const actionSource = action.trim() && !requiresManualAction ? ` { ${action.trim()} }` : '';
    if (requiresManualAction) {
        warnings.push({
            code: 'MANUAL_PARSER_ACTION',
            rule,
            message: `Parser action for ${rule} uses Jison runtime state or locations; review it manually`
        });
    }
    return {
        source: `${syntax}${actionSource}`,
        precedence: precedence ? (aliases[precedence[1]] || precedence[1]) : undefined,
        action: action.trim(),
        requiresManualAction
    };
}

function normalizeOperators (operators, aliases) {
    if (operators === undefined) return [];
    if (!Array.isArray(operators)) throw new TypeError('Jison operators must be an array');
    return operators.map((operator, index) => {
        if (!Array.isArray(operator) || operator.length < 2) {
            throw new TypeError(`Invalid Jison operator at index ${index}`);
        }
        const [type, ...tokens] = operator;
        if (!['left', 'right', 'nonassoc'].includes(type)) {
            throw new TypeError(`Unsupported Jison associativity: ${type}`);
        }
        return {
            type,
            tokens: tokens.map(token => {
                const name = assertString(token, 'Jison operator token');
                return aliases[name] || name;
            })
        };
    });
}

function quoted (value) {
    return JSON.stringify(value).replace(/\\u00([0-9a-f]{2})/gi, (_, code) =>
        JSON.stringify(String.fromCharCode(parseInt(code, 16))).slice(1, -1))
        .replace(/\\u000b/gi, '\\v');
}

function quotedCharacter (value) {
    for (const character of value) {
        const code = character.codePointAt(0);
        if ((code < 0x20 && ![0x09, 0x0A, 0x0B, 0x0C, 0x0D].includes(code)) ||
            (code >= 0xD800 && code <= 0xDFFF)) {
            throw new SyntaxError('Control characters and lone surrogates need manual conversion');
        }
    }
    return quoted(value);
}

function escapedCharacter (character) {
    const escapes = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
    return escapes[character] ?? character;
}

function characterClass (source) {
    if (source[0] === '^') throw new SyntaxError('Negated Jison lexer classes are not supported');
    if (source === '\\d') return '"0".."9"';
    if (source === '\\w') return '( "a".."z" | "A".."Z" | "0".."9" | "_" )';
    if (source === '\\s') return '( " " | "\\n" | "\\r" | "\\t" | "\\f" | "\\v" )';
    if (!source) throw new SyntaxError('Empty Jison lexer classes are not supported');
    const items = [];
    for (let index = 0; index < source.length;) {
        let value = source[index++];
        let escaped = false;
        if (value === '\\') {
            if (index >= source.length) throw new SyntaxError('Invalid escape in Jison lexer class');
            const escape = source[index++];
            if ('dwsDSW'.includes(escape)) {
                throw new SyntaxError(`Unsupported character-class escape \\${escape}`);
            }
            if (!'\\]-^$.*+?(){}|/'.includes(escape) && !'nrtfv'.includes(escape)) {
                throw new SyntaxError(`Unsupported character-class escape \\${escape}`);
            }
            value = escapedCharacter(escape);
            escaped = true;
        }
        if (!escaped && value === '-') {
            items.push(value);
        } else if (index < source.length - 1 && source[index] === '-' && source[index + 1] !== ']') {
            index++;
            let end = source[index++];
            if (end === '\\') {
                if (index >= source.length) throw new SyntaxError('Invalid range in Jison lexer class');
                const escape = source[index++];
                if (!'\\]-^$.*+?(){}|/nrtfv'.includes(escape)) {
                    throw new SyntaxError(`Unsupported character-class range escape \\${escape}`);
                }
                end = escapedCharacter(escape);
            }
            items.push(`${quotedCharacter(value)}..${quotedCharacter(end)}`);
        } else {
            items.push(quotedCharacter(value));
        }
    }
    return items.length === 1 ? items[0] : `( ${items.join(' | ')} )`;
}

function boundedRepetition (atom, source, start) {
    const match = source.slice(start).match(/^\{(\d+)(?:,(\d*))?\}/);
    if (!match) throw new SyntaxError(`Unsupported Jison quantifier in pattern: ${source}`);
    const minimum = Number(match[1]);
    const maximum = match[2] === undefined
        ? minimum
        : match[2] === '' ? Infinity : Number(match[2]);
    const limit = 128;
    if (!Number.isSafeInteger(minimum) || minimum > limit ||
        (maximum !== Infinity && (!Number.isSafeInteger(maximum) || maximum > limit)) ||
        maximum < minimum) {
        throw new SyntaxError(`Jison bounded quantifier must be ordered and no larger than ${limit}`);
    }
    const parts = Array.from({ length: minimum }, () => atom);
    if (maximum === Infinity) {
        parts.push(`{ ${atom} }`);
    } else {
        for (let count = minimum; count < maximum; count++) parts.push(`[ ${atom} ]`);
    }
    return [parts.join(', ') || '""', match[0].length];
}

function convertLexerPattern (pattern) {
    const source = assertString(pattern, 'Jison lexer pattern').trim();
    if (!source || source === '<<EOF>>') throw new SyntaxError(`Unsupported Jison lexer pattern: ${source}`);
    let index = 0;

    function atom () {
        const character = source[index++];
        if (character === '(') {
            if (source[index] === '?' && source[index + 1] === ':') index += 2;
            const expression = alternatives(')');
            if (source[index] !== ')') throw new SyntaxError(`Unclosed Jison lexer group: ${source}`);
            index++;
            return `( ${expression} )`;
        }
        if (character === '[') {
            const start = index;
            let escaped = false;
            while (index < source.length) {
                const current = source[index++];
                if (escaped) escaped = false;
                else if (current === '\\') escaped = true;
                else if (current === ']') {
                    return characterClass(source.slice(start, index - 1));
                }
            }
            throw new SyntaxError(`Unclosed Jison lexer class: ${source}`);
        }
        if (character === '\\') {
            if (index >= source.length) throw new SyntaxError(`Invalid Jison lexer escape: ${source}`);
            const escaped = source[index++];
            if (escaped === 's') return '( " " | "\\n" | "\\r" | "\\t" | "\\f" | "\\v" )';
            if (escaped === 'd') return '"0".."9"';
            if (escaped === 'w') return '( "a".."z" | "A".."Z" | "0".."9" | "_" )';
            if ('DSW'.includes(escaped)) {
                throw new SyntaxError(`Negated Jison lexer escape \\${escaped} is not supported`);
            }
            if (escaped === 'x') {
                const hex = source.slice(index, index + 2);
                if (!/^[\da-f]{2}$/i.test(hex)) throw new SyntaxError(`Invalid Jison hex escape: ${source}`);
                index += 2;
                return quotedCharacter(String.fromCharCode(parseInt(hex, 16)));
            }
            if (escaped === 'u') {
                const braced = source[index] === '{';
                const end = braced ? source.indexOf('}', index + 1) : index + 4;
                const hex = source.slice(index + Number(braced), end);
                if ((braced && end < 0) || !/^[\da-f]+$/i.test(hex) ||
                    (!braced && hex.length !== 4) || hex.length > 6 ||
                    parseInt(hex, 16) > 0x10FFFF) {
                    throw new SyntaxError(`Invalid Jison Unicode escape: ${source}`);
                }
                index = braced ? end + 1 : end;
                return quotedCharacter(String.fromCodePoint(parseInt(hex, 16)));
            }
            if ('nrtfv'.includes(escaped)) return quotedCharacter(escapedCharacter(escaped));
            if ('\\^$.*+?()[]{}|/-'.includes(escaped)) return quotedCharacter(escaped);
            throw new SyntaxError(`Unsupported Jison lexer escape \\${escaped}`);
        }
        if ('.^$)]{}?*+'.includes(character)) {
            throw new SyntaxError(`Unsupported Jison lexer pattern: ${source}`);
        }
        return quotedCharacter(character);
    }

    function sequence (end) {
        const parts = [];
        while (index < source.length && source[index] !== '|' && source[index] !== end) {
            let current = atom();
            const quantifier = source[index];
            if (quantifier === '+' || quantifier === '*' || quantifier === '?') {
                index++;
                if (quantifier === '+') current = `${current}, { ${current} }`;
                else if (quantifier === '*') current = `{ ${current} }`;
                else current = `[ ${current} ]`;
            } else if (quantifier === '{') {
                let quantifierLength;
                [current, quantifierLength] = boundedRepetition(current, source, index);
                index += quantifierLength;
            }
            parts.push(current);
        }
        if (!parts.length) throw new SyntaxError(`Empty alternative in Jison lexer pattern: ${source}`);
        return parts.join(', ');
    }

    function alternatives (end = '') {
        const choices = [sequence(end)];
        while (source[index] === '|') {
            index++;
            choices.push(sequence(end));
        }
        return choices.length === 1 ? choices[0] : choices.join(' | ');
    }

    const converted = alternatives();
    if (index !== source.length) throw new SyntaxError(`Unsupported Jison lexer pattern: ${source}`);
    return converted.includes(' | ') ? `( ${converted} )` : converted;
}

function lexerRuleAction (action, index) {
    const source = assertString(action, `Jison lexer action ${index}`);
    const match = source.match(/^\s*return\s+(['"])(.*?)\1\s*;?\s*$/s);
    if (match) return { token: decodeQuoted(`${match[1]}${match[2]}${match[1]}`), skip: false };
    if (/^\s*(?:\/\*.*\*\/|\/\/.*)?\s*$/.test(source) ||
        /\b(?:skip|ignore)\b/i.test(source)) return { token: null, skip: true };
    throw new SyntaxError(`Unsupported Jison lexer action at rule ${index}`);
}

/**
 * Converts common Jison lex rules to an EBNF lexical grammar.
 * Complex regex features and arbitrary lexer actions must be migrated manually.
 */
export function convertJisonLexer (lexer) {
    if (!lexer || typeof lexer !== 'object' || !Array.isArray(lexer.rules)) {
        throw new TypeError('Jison lexer requires a rules array');
    }
    const tokens = [];
    const ignoreTokens = [];
    const tokenAliases = {};
    const warnings = [];
    const rules = lexer.rules.map((entry, index) => {
        if (!Array.isArray(entry) || entry.length < 2) {
            throw new TypeError(`Invalid Jison lexer rule at index ${index}`);
        }
        const [pattern, action] = entry;
        let result;
        try {
            result = lexerRuleAction(action, index);
            const convertedPattern = convertLexerPattern(pattern);
            let name = result.token;
            if (name && !/^[A-Za-z_]\w*$/.test(name)) {
                name = `JISON_LITERAL_${Array.from(name, character =>
                    character.codePointAt(0).toString(16).toUpperCase()).join('_')}`;
                while (tokens.includes(name)) name = `_${name}`;
                tokenAliases[result.token] = name;
            }
            if (!name) {
                name = `JISON_SKIP_${index}`;
                ignoreTokens.push(name);
            }
            if (!tokens.includes(name)) tokens.push(name);
            return `${name} = ${convertedPattern};`;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            warnings.push({
                code: 'MANUAL_LEXER_RULE',
                ruleIndex: index,
                pattern,
                message: error.message
            });
            return `(* MIGRATION REQUIRED: convert Jison lexer rule ${index} manually *)`;
        }
    });
    return { source: rules.join('\n'), tokens, ignoreTokens, tokenAliases, warnings };
}

/**
 * Converts the parser portion of a Jison grammar to Syntrix inputs.
 * Lexer rules and Jison-specific runtime APIs are intentionally not converted.
 */
export function convertJisonGrammar (grammar, { tokenAliases = {} } = {}) {
    if (!grammar || typeof grammar !== 'object') throw new TypeError('Jison grammar must be an object');
    const bnf = grammar.bnf || grammar.ebnf;
    if (!bnf || typeof bnf !== 'object') throw new TypeError('Jison grammar requires a bnf object');

    const start = grammar.startSymbol || Object.keys(bnf)[0];
    if (!start) throw new TypeError('Jison grammar requires at least one rule');

    const overrides = {};
    const warnings = [];
    const manualActions = {};
    const rules = Object.entries(bnf).map(([name, productions]) => {
        const alternatives = Array.isArray(productions) ? productions : [productions];
        const converted = alternatives.map(production =>
            convertAlternative(production, name, tokenAliases, warnings));
        converted.forEach((alternative, index) => {
            if (alternative.precedence !== undefined) {
                (overrides[name] ||= {})[index] = alternative.precedence;
            }
        });
        if (converted.some(alternative => alternative.requiresManualAction)) {
            manualActions[name] = converted.map(alternative => ({
                action: alternative.action,
                manual: alternative.requiresManualAction
            }));
        }
        return `${name} = ${converted.map(alternative => alternative.source).join('\n    | ')};`;
    });

    return {
        source: rules.join('\n'),
        options: {
            start,
            precedence: normalizeOperators(grammar.operators, tokenAliases),
            precedenceOverrides: overrides
        },
        warnings,
        manualActions
    };
}
