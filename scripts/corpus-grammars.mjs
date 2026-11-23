const tokens = [
    'STRING', 'NUMBER', 'TRUE', 'FALSE', 'NULL', 'LBRACE', 'RBRACE',
    'LBRACKET', 'RBRACKET', 'COLON', 'COMMA', 'SPACE'
];

export async function createCorpusParser (implementation) {
    if (implementation === 'syntrix') {
        const { Lexer, Parser, createEbnfLexer, createEbnfParser } = await import('../src/client/index.js');
        const lexer = createEbnfLexer(`
            STRING = '"', { "a".."z" | "A".."Z" | "0".."9" | " " | "_" }, '"';
            NUMBER = [ "-" ], ( "0" | "1".."9", { "0".."9" } ), [ ".", "0".."9", { "0".."9" } ];
            TRUE = "true"; FALSE = "false"; NULL = "null";
            LBRACE = "{"; RBRACE = "}"; LBRACKET = "["; RBRACKET = "]";
            COLON = ":"; COMMA = ",";
            SPACE = ( " " | "\\n" | "\\r" | "\\t" ), { " " | "\\n" | "\\r" | "\\t" };
        `, { tokens });
        const config = createEbnfParser(`
            entry = value;
            value = STRING | NUMBER | TRUE | FALSE | NULL | object | array;
            object = LBRACE, members, RBRACE | LBRACE, RBRACE;
            members = member | members, COMMA, member;
            member = STRING, COLON, value;
            array = LBRACKET, elements, RBRACKET | LBRACKET, RBRACKET;
            elements = value | elements, COMMA, value;
        `, {
            start: 'entry',
            tokens,
            ignoreTokens: ['SPACE'],
            actions: {
                entry: [args => args[0].rules],
                value: [
                    args => JSON.parse(args[0].content),
                    args => Number(args[0].content),
                    () => true,
                    () => false,
                    () => null,
                    args => args[0].rules,
                    args => args[0].rules
                ],
                object: [args => Object.fromEntries(args[1].rules), () => ({})],
                members: [args => [args[0].rules], args => {
                    args[0].rules.push(args[2].rules);
                    return args[0].rules;
                }],
                member: [args => [JSON.parse(args[0].content), args[2].rules]],
                array: [args => args[1].rules, () => []],
                elements: [args => [args[0].rules], args => {
                    args[0].rules.push(args[2].rules);
                    return args[0].rules;
                }]
            }
        });
        return new Parser(new Lexer(lexer), config);
    }
    throw new TypeError(`Unknown corpus implementation: ${implementation}`);
}

const records = count => Array.from({ length: count }, (_, index) => ({
    id: index,
    name: `record_${index}`,
    enabled: index % 2 === 0,
    tags: ['alpha', 'beta', null]
}));

export const corpus = [
    { name: 'config-small', input: JSON.stringify({ enabled: true, retry: 3, name: 'demo', items: [] }, null, 2) },
    { name: 'nested-64', input: `${'['.repeat(64)}{"value":42}${']'.repeat(64)}` },
    { name: 'records-128', input: JSON.stringify(records(128)) },
    { name: 'numbers-2048', input: JSON.stringify(Array.from({ length: 2048 }, (_, index) => index - 1024)) },
    { name: 'records-512', input: JSON.stringify(records(512)) }
];
