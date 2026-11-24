import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regexToNfa, regexToDfa, determinize } from '../src/client/index.js';

test('public automata API produces NFA and DFA transition tables', () => {
    const nfa = regexToNfa('a(b|c)*');
    const dfa = determinize(nfa);
    assert.ok(nfa.table.some(edge => edge._ft_ === 'ε'));
    assert.ok(dfa.table.every(edge => edge._ft_ !== 'ε'));
    assert.deepEqual(regexToDfa('a(b|c)*'), dfa);
});

test('public regex conversion rejects invalid and reserved inputs', () => {
    assert.throws(() => regexToNfa(42), TypeError);
    assert.throws(() => regexToNfa('ε'), SyntaxError);
    assert.throws(() => regexToNfa('[z-a]'), /range must be ordered/);
    assert.throws(() => regexToNfa('[α-ι]'), SyntaxError);
    assert.throws(() => regexToNfa('('));
});
