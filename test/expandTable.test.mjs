import assert from 'node:assert/strict';
import { test } from 'node:test';
import expandTable from '../src/client/misc/expandTable.js';

test('splits overlapping character ranges without losing their remaining characters', () => {
    const table = [
        { from: '0', to: '1', _ft_: '0', _tt_: 'z' },
        { from: '2', to: '3', _ft_: 'A', _tt_: 'Z' }
    ];

    assert.deepEqual(expandTable(table), [
        { from: '0', to: '1', _ft_: '0', _tt_: '@' },
        { from: '0', to: '1', _ft_: 'A', _tt_: 'Z' },
        { from: '0', to: '1', _ft_: '[', _tt_: 'z' },
        { from: '2', to: '3', _ft_: 'A', _tt_: 'Z' }
    ]);
});

test('orders split points numerically across character-code digit lengths', () => {
    const table = [
        { from: '0', to: '1', _ft_: '0', _tt_: 'z' },
        { from: '2', to: '3', _ft_: 'd', _tt_: 'f' },
        { from: '4', to: '5', _ft_: 'A', _tt_: 'B' }
    ];
    const segments = expandTable(table).filter(item => item.from === '0');

    assert.deepEqual(segments.map(item => [item._ft_, item._tt_]), [
        ['0', '@'], ['A', 'B'], ['C', 'c'], ['d', 'f'], ['g', 'z']
    ]);
});
