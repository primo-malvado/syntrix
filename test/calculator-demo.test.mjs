import assert from 'node:assert/strict';
import test from 'node:test';
import { calculate, lexerGrammar, parserGrammar } from '../demo/calculator.js';

const run = input => calculate({ lexerSource: lexerGrammar, parserSource: parserGrammar, input });

test('scientific calculator handles precedence, functions and scientific notation', () => {
    assert.equal(run('(2 + 3) * 4').value, 20);
    assert.equal(run('-2^2').value, -4);
    assert.equal(run('2^3^2').value, 512);
    assert.equal(run('2^-2').value, 0.25);
    assert.equal(run('sqrt(81) + log(100) + 1.5e2').value, 161);
    assert.ok(Math.abs(run('sin(pi / 2)').value - 1) < 1e-12);
    assert.deepEqual(calculate({
        lexerSource: lexerGrammar, parserSource: parserGrammar, input: '2 + 3', algorithm: 'glr'
    }).value, [5]);
});

test('scientific calculator exposes tokens and rejects invalid calculations', () => {
    const result = run('2 + 3');
    assert.deepEqual(result.tokens, [
        { type: 'NUMBER', content: '2' },
        { type: 'PLUS', content: '+' },
        { type: 'NUMBER', content: '3' }
    ]);
    assert.ok(result.states > 0);
    assert.throws(() => run('2 +'), SyntaxError);
    assert.throws(() => run('2 @ 3'), SyntaxError);
    assert.throws(() => run('sqrt(-1)'), /not a finite number/);
    assert.throws(() => run('1/0'), /not a finite number/);
    assert.throws(() => run('unknown(1)'), /Unknown function/);
});

test('scientific calculator uses edited grammars rather than fixed tables', () => {
    const modified = lexerGrammar.replace('PLUS = "+";', 'PLUS = "?";');
    const result = calculate({ lexerSource: modified, parserSource: parserGrammar, input: '2 ? 3' });
    assert.equal(result.value, 5);
    assert.throws(() => calculate({ lexerSource: modified, parserSource: parserGrammar, input: '2 + 3' }));
});
