import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
    createSyntrix, createSourceSyntrix, sourceWorkloads, workloads
} from '../scripts/benchmark-grammars.mjs';
import { createCorpusParser, corpus } from '../scripts/corpus-grammars.mjs';
import { evaluateCorpusCriteria } from '../scripts/corpus-criteria.mjs';
import { isJisonInstalled, requireJison } from '../scripts/benchmark-jison.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('JSON-subset corpus agrees with JSON.parse and rejects invalid input', async () => {
    const parsers = [await createCorpusParser('syntrix')];
    let seed = 0x5eed1234;
    const random = maximum => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed >>> 8) % maximum;
    };
    const value = depth => {
        switch (depth === 0 ? random(5) : random(7)) {
        case 0: return null;
        case 1: return random(2) === 0;
        case 2: return (random(2001) - 1000) / 10;
        case 3: return `name_${random(100)}`;
        case 4: return '';
        case 5: return Array.from({ length: random(5) }, () => value(depth - 1));
        default: return Object.fromEntries(Array.from({ length: random(5) }, (_, index) =>
            [`key_${index}`, value(depth - 1)]));
        }
    };
    const samples = [
        ...corpus.map(item => item.input),
        '{"__proto__":1,"constructor":2,"x":1,"x":2}',
        '-0',
        ...Array.from({ length: 200 }, () => JSON.stringify(value(4)))
    ];
    for (const input of samples) {
        const expected = JSON.parse(input);
        for (const parser of parsers) assert.deepEqual(parser.parse(input), expected, input);
    }
    for (const input of samples.slice(0, 25)) {
        const parser = parsers[0];
        parser.start();
        for (let index = 0; index < input.length; index += 3) parser.push(input.slice(index, index + 3));
        assert.deepEqual(parser.finish(), JSON.parse(input), input);
    }
    for (const input of ['', '[1,]', '{"a":1,}', '{"a" 1}', '[true false]', '01', '-',
        '{"a":', 'null true', '[1,,2]']) {
        assert.throws(() => JSON.parse(input), SyntaxError, input);
        for (const parser of parsers) assert.throws(() => parser.parse(input), undefined, input);
    }
});

test('Syntrix algorithms agree with an independent expression oracle', () => {
    let seed = 0x12345678;
    const random = maximum => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % maximum;
    };
    const expression = depth => {
        if (depth === 0 || random(5) === 0) {
            const value = random(4);
            return { text: String(value), value };
        }
        const left = expression(depth - 1);
        const right = expression(depth - 1);
        const operator = random(2) ? '+' : '*';
        return {
            text: `( ${left.text} ${operator} ${right.text} )`,
            value: operator === '+' ? left.value + right.value : left.value * right.value
        };
    };
    const parsers = [
        createSyntrix('slr1'),
        createSyntrix('lalr1'),
        createSyntrix('lr1')
    ];
    const samples = [
        { text: '2+3*4', value: 14 },
        { text: '(2+3)*4', value: 20 },
        { text: '1+2+3*4', value: 15 },
        ...Array.from({ length: 150 }, () => expression(4))
    ];
    for (const sample of samples) {
        for (const parser of parsers) assert.equal(parser.parse(sample.text), sample.value, sample.text);
    }
    for (const input of ['', '1+', '(2', '1 2', '2+*3', '1@2']) {
        for (const parser of parsers) assert.throws(() => parser.parse(input), undefined, input);
    }
    for (const parser of parsers.slice(0, 3)) {
        for (const sample of samples.slice(0, 25)) {
            parser.start();
            for (let index = 0; index < sample.text.length; index += 2) {
                parser.push(sample.text.slice(index, index + 2));
            }
            assert.equal(parser.finish(), sample.value, sample.text);
        }
    }
});

test('source-like settings parser agrees on results, invalid input and streaming', () => {
    const parsers = [createSourceSyntrix()];
    const cases = [
        ...sourceWorkloads,
        { input: '# comment\nfoo = -12; foo=7;\n', expected: [['foo', -12], ['foo', 7]] }
    ];
    for (const { input, expected } of cases) {
        for (const parser of parsers) assert.deepEqual(parser.parse(input), expected);
        parsers[0].start();
        for (let index = 0; index < input.length; index += 3) {
            parsers[0].push(input.slice(index, index + 3));
        }
        assert.deepEqual(parsers[0].finish(), expected);
    }
    for (const input of ['', 'foo = ;', 'foo = 1', 'foo 1;', 'foo = 1; @', 'foo = 1.5;']) {
        for (const parser of parsers) assert.throws(() => parser.parse(input), undefined, input);
    }
});

test('benchmark reports valid per-operation generation and parsing metrics', () => {
    const output = execFileSync(process.execPath, [
        'scripts/benchmark.mjs', '--json', '--samples', '2', '--warmup', '1', '--iterations', '1'
    ], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.deepEqual(result.settings, { samples: 2, warmup: 1, iterations: 1 });
    assert.deepEqual(result.parsing.map(item => item.name), workloads.map(item => item.name));
    assert.deepEqual(result.sourceParsing.map(item => item.name), sourceWorkloads.map(item => item.name));
    for (const measurement of [result.generation, ...result.parsing, ...result.sourceParsing]) {
        for (const name of ['syntrix']) {
            assert.ok(Number.isFinite(measurement[name].medianMs) && measurement[name].medianMs > 0);
            assert.ok(measurement[name].p95Ms >= measurement[name].medianMs);
        }
    }
    assert.deepEqual(result.lexing.map(item => item.name), [
        'complete', 'streaming-1', 'streaming-64', 'streaming-64-discard', 'streaming-long-token',
        'source-complete', 'source-streaming-64', 'source-streaming-64-discard'
    ]);
    for (const measurement of result.lexing) {
        assert.ok(Number.isFinite(measurement.medianMs) && measurement.medianMs > 0);
        assert.ok(measurement.p95Ms >= measurement.medianMs);
        assert.ok(measurement.tokens > 0);
        assert.ok(measurement.retainedInputChars <= measurement.characters);
    }
    assert.equal(result.lexing[0].retainedInputChars, result.lexing[0].characters);
    assert.equal(result.lexing[2].retainedInputChars, result.lexing[2].characters);
    assert.ok(result.lexing[3].retainedInputChars < result.lexing[3].characters);
    assert.deepEqual(result.lexerComparisons.map(item => [item.numerator, item.denominator]), [
        ['streaming-64-discard', 'streaming-64'],
        ['source-streaming-64-discard', 'source-streaming-64']
    ]);
    for (const comparison of result.lexerComparisons) {
        assert.ok(Number.isFinite(comparison.medianRatio) && comparison.medianRatio > 0);
        assert.ok(comparison.p95Ratio >= comparison.medianRatio);
    }
});

test('comparative benchmarks explain how to install missing Jison', () => {
    const directory = mkdtempSync(join(tmpdir(), 'syntrix-no-jison-'));
    try {
        for (const name of ['benchmark-compare.mjs', 'benchmark-memory-compare.mjs',
            'benchmark-jison.mjs', 'benchmark-data.mjs', 'corpus-grammars.mjs']) {
            copyFileSync(join(root, 'scripts', name), join(directory, name));
        }
        for (const script of ['benchmark-compare.mjs', 'benchmark-memory-compare.mjs']) {
            const result = spawnSync(process.execPath, [join(directory, script)], { encoding: 'utf8' });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /npm install --no-save --package-lock=false jison@0\.3\.12/);
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('comparative benchmark validates equivalent Syntrix and Jison results', {
    skip: isJisonInstalled() ? false : 'Install jison@0.3.12 to test comparative benchmarks'
}, () => {
    const output = execFileSync(process.execPath, [
        'scripts/benchmark-compare.mjs', '--json', '--samples', '2', '--min-samples', '3',
        '--warmup', '1', '--iterations', '1'
    ], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.environment.jison, requireJison());
    assert.deepEqual(result.settings, { samples: 2, minSamples: 3, warmup: 1, iterations: 1 });
    assert.deepEqual(result.sampleSufficiency, { minimum: 3, observed: 2, sufficient: false });
    assert.deepEqual(
        result.workloads.map(item => `${item.group}/${item.name}`),
        [...workloads.map(item => `expression/${item.name}`),
            ...corpus.map(item => `json/${item.name}`)]
    );
    for (const workload of result.workloads) {
        assert.deepEqual(workload.sampleSufficiency, {
            minimum: 3, observed: 2, sufficient: false
        });
        for (const implementation of ['syntrix', 'jison']) {
            for (const phase of ['construction', 'parsing']) {
                assert.ok(Number.isFinite(workload[implementation][phase].medianMs));
                assert.ok(workload[implementation][phase].medianMs > 0);
                assert.ok(workload[implementation][phase].p95Ms >= workload[implementation][phase].medianMs);
            }
        }
    }
});

test('comparative memory benchmark isolates Syntrix and Jison', {
    skip: isJisonInstalled() ? false : 'Install jison@0.3.12 to test comparative benchmarks'
}, () => {
    const output = execFileSync(process.execPath, [
        'scripts/benchmark-memory-compare.mjs', '--json', '--pairs', '2', '--min-pairs', '3'
    ], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.jison, requireJison());
    assert.deepEqual(result.settings, { pairs: 2, minPairs: 3, json: true });
    assert.deepEqual(result.sampleSufficiency, {
        minimum: 3, observed: 2, sufficient: false
    });
    assert.equal(result.measurements.length, corpus.length * 2);
    for (const measurement of result.measurements) {
        assert.ok(['syntrix', 'jison'].includes(measurement.implementation));
        assert.deepEqual(measurement.sampleSufficiency, {
            minimum: 3, observed: 2, sufficient: false
        });
        assert.ok(measurement.peakHeapUsedBytes >= measurement.baselineHeapUsedBytes);
        assert.ok(measurement.peakRssBytes > 0);
        assert.ok(Number.isInteger(measurement.retainedHeapChangeBytes));
    }
});

test('isolated corpus profiling supports parsing, lexing and replayed tokens', () => {
    for (const [mode, stage] of [['cpu', 'parse'], ['cpu', 'lexer'], ['alloc', 'parser']]) {
        const output = execFileSync(process.execPath, [
            '--expose-gc', 'scripts/profile-corpus.mjs', '--mode', mode, '--stage', stage,
            '--warmup', '1', '--iterations', '2'
        ], { cwd: root, encoding: 'utf8' });
        const result = JSON.parse(output);
        assert.equal(result.settings.mode, mode);
        assert.equal(result.settings.stage, stage);
        assert.equal(result.settings.iterations, 2);
        if (mode === 'cpu') assert.ok(result.profile.nodes.length > 0);
        else assert.ok(result.profile.head);
    }
    assert.throws(() => execFileSync(process.execPath, [
        'scripts/profile-corpus.mjs', '--stage', 'unknown'
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
});

test('memory benchmark isolates streaming modes and reports measured snapshots', () => {
    const output = execFileSync(process.execPath, [
        'scripts/benchmark-memory.mjs', '--json', '--chunks', '8'
    ], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.chunks, 8);
    assert.deepEqual(result.measurements.map(item => item.mode), ['retain', 'discard']);
    for (const measurement of result.measurements) {
        assert.equal(measurement.characters, result.chunkCharacters * result.chunks);
        assert.equal(measurement.tokens, result.chunks * 64);
        assert.ok(measurement.baselineHeapUsedBytes > 0);
        assert.ok(measurement.retainedHeapUsedBytes > 0);
        assert.ok(measurement.peakHeapUsedBytes >= measurement.baselineHeapUsedBytes);
        assert.ok(measurement.peakRssBytes > 0);
    }
    assert.equal(result.measurements[0].retainedInputChars, result.measurements[0].characters);
    assert.ok(result.measurements[1].retainedInputChars < result.measurements[1].characters);
    assert.throws(() => execFileSync(process.execPath, [
        'scripts/benchmark-memory.mjs', '--chunks', '0'
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
});

test('corpus benchmark reports isolated timings, memory and insufficient sample status', () => {
    const output = execFileSync(process.execPath, [
        'scripts/benchmark-corpus.mjs', '--json', '--pairs', '1', '--samples', '2', '--warmup', '1'
    ], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.deepEqual(result.settings, { pairs: 1, samples: 2, warmup: 1 });
    assert.deepEqual(result.workloads.map(item => item.name), corpus.map(item => item.name));
    assert.equal(result.criteria.status, 'insufficient');
    for (const measurement of result.workloads) {
        assert.ok(measurement.syntrix.medianMs > 0);
        assert.ok(measurement.syntrix.p95Ms >= measurement.syntrix.medianMs);
        assert.ok(measurement.syntrix.coldConstructionMs > 0);
        assert.ok(measurement.syntrix.firstParseMs > 0);
        assert.ok(measurement.syntrix.sampledPeakRssBytes > 0);
        assert.ok(measurement.syntrix.sampledPeakHeapBytes > 0);
        assert.ok(measurement.syntrix.retainedHeapBytes > 0);
    }
    assert.throws(() => execFileSync(process.execPath, [
        'scripts/benchmark-corpus.mjs', '--pairs', '0'
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
});

test('corpus acceptance criteria enforce latency, memory and minimum sample boundaries', () => {
    const settings = { pairs: 5, samples: 20, warmup: 3 };
    const workloads = Array.from({ length: 5 }, () => ({
        syntrix: {
            medianMs: 1,
            p95Ms: 2,
            coldConstructionMs: 3,
            firstParseMs: 4,
            sampledPeakRssBytes: 5,
            sampledPeakHeapBytes: 6,
            retainedHeapBytes: 7
        }
    }));
    assert.equal(evaluateCorpusCriteria(workloads, settings).status, 'pass');
    assert.equal(evaluateCorpusCriteria(workloads, { ...settings, pairs: 4 }).status, 'insufficient');
    assert.equal(evaluateCorpusCriteria([], settings).status, 'insufficient');
    const invalid = workloads.map((item, index) =>
        index === 0 ? { syntrix: { ...item.syntrix, medianMs: 0 } } : item
    );
    assert.equal(evaluateCorpusCriteria(invalid, settings).status, 'fail');
});
