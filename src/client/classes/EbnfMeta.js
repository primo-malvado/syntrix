const document = args => [args[0].rules, ...args[1].rules];
const definitions = args => [args[0].rules, ...args[1].rules];
const emptyDefinitions = () => [];
const definition = args => [args[0].content, args[2].rules];
const alternatives = args => ({
    type: 'alternatives',
    choices: [args[0].rules, ...args[1].rules]
});
const alternativesTail = args => [args[1].rules, ...args[2].rules];
const emptyAlternativesTail = () => [];
const sequence = args => ({
    type: 'sequence',
    items: [args[0].rules, ...args[1].rules]
});
const sequenceTail = args => [args[1].rules, ...args[2].rules];
const emptySequenceTail = () => [];
const name = args => ({ type: 'name', value: args[0].content });
const literal = args => {
    const value = args[0].content;
    const end = args[1].rules;
    if (end === null) return { type: 'literal', value };
    if (value.length !== 1 || end.length !== 1 || value > end) {
        throw new SyntaxError('A range must have ascending single-character endpoints');
    }
    return { type: 'range', from: value, to: end };
};
const group = args => ({ type: 'group', expression: args[1].rules });
const optional = args => ({ type: 'optional', expression: args[1].rules });
const repeat = args => ({ type: 'repeat', expression: args[1].rules });
const literalTail = args => args[1].content;
const emptyLiteralTail = () => null;
const root = args => args[0].rules;

export const ebnfMetaActions = {
    document,
    definitions,
    emptyDefinitions,
    definition,
    alternatives,
    alternativesTail,
    emptyAlternativesTail,
    sequence,
    sequenceTail,
    emptySequenceTail,
    name,
    literal,
    group,
    optional,
    repeat,
    literalTail,
    emptyLiteralTail,
    root
};

export const ebnfMetaActionRules = {
    document: [document],
    definitions: [definitions, emptyDefinitions],
    definition: [definition],
    alternatives: [alternatives],
    alternatives_tail: [alternativesTail, emptyAlternativesTail],
    sequence: [sequence],
    sequence_tail: [sequenceTail, emptySequenceTail],
    primary: [name, literal, group, optional, repeat],
    literal_tail: [literalTail, emptyLiteralTail]
};
