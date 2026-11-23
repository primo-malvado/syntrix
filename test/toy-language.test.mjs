import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToyLanguage } from '../demo/toy-language.js';

test('parses declarations, assignments, print statements and operator precedence', () => {
    const result = parseToyLanguage(`
        let total = 2 + 3 * 4;
        total = (total + 1) / 3;
        print total;
    `);

    assert.deepEqual(result.ast, [
        {
            type: 'declaration',
            name: 'total',
            value: {
                type: 'binary',
                operator: '+',
                left: { type: 'number', value: 2 },
                right: {
                    type: 'binary',
                    operator: '*',
                    left: { type: 'number', value: 3 },
                    right: { type: 'number', value: 4 }
                }
            }
        },
        {
            type: 'assignment',
            name: 'total',
            value: {
                type: 'binary',
                operator: '/',
                left: {
                    type: 'binary',
                    operator: '+',
                    left: { type: 'identifier', name: 'total' },
                    right: { type: 'number', value: 1 }
                },
                right: { type: 'number', value: 3 }
            }
        },
        {
            type: 'print',
            value: { type: 'identifier', name: 'total' }
        }
    ]);
    assert.ok(result.tokens.some(token => token.type === 'LET'));
    assert.ok(result.states > 0);
});

test('rejects malformed toy-language programs', () => {
    assert.throws(() => parseToyLanguage('let total = 2 + ;'), SyntaxError);
});
