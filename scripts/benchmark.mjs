import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, release } from 'node:os';
import {
    createBenchmarkLexer, createSyntrix, createSourceBenchmarkLexer,
    createSourceSyntrix, lexerInput, sourceInput, sourceWorkloads, workloads
} from './benchmark-grammars.mjs';

const settings = { samples: 7, warmup: 3, iterations: 10, json: false };
for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (option === '--json') {
        settings.json = true;
        continue;
    }
    if (!['--samples', '--warmup', '--iterations'].includes(option)) {
        throw new Error(`Unknown option ${option}`);
    }
    const value = process.argv[++index];
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${option} must be a positive integer`);
    }
    settings[option.slice(2)] = Number(value);
}

function summarize (values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
        medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
    };
}

const factories = { syntrix: createSyntrix };
const parsers = Object.fromEntries(Object.entries(factories).map(([name, factory]) => [name, factory()]));
for (const workload of workloads) {
    for (const parser of Object.values(parsers)) {
        assert.equal(parser.parse(workload.input), workload.expected, `${workload.name}: incorrect result`);
    }
}

const generation = { syntrix: [] };
for (let index = 0; index < settings.warmup + settings.samples; index++) {
    const names = ['syntrix'];
    for (const name of names) {
        const start = performance.now();
        const parser = factories[name]();
        const duration = performance.now() - start;
        assert.equal(parser.parse('1+2*3'), 7, `${name}: incorrect generated parser`);
        if (index >= settings.warmup) generation[name].push(duration);
    }
}

function measureParsing (inputs, implementations, prevalidated = false) {
    const measurements = [];
    for (const workload of inputs) {
        if (!prevalidated) {
            for (const parser of Object.values(implementations)) {
                assert.deepEqual(parser.parse(workload.input), workload.expected, `${workload.name}: incorrect result`);
            }
        }
        const samples = { syntrix: [] };
        for (let index = 0; index < settings.warmup + settings.samples; index++) {
            const names = ['syntrix'];
            for (const name of names) {
                let result;
                const start = performance.now();
                for (let iteration = 0; iteration < settings.iterations; iteration++) {
                    result = implementations[name].parse(workload.input);
                }
                const duration = (performance.now() - start) / settings.iterations;
                assert.deepEqual(result, workload.expected, `${name}: incorrect result in ${workload.name}`);
                if (index >= settings.warmup) samples[name].push(duration);
            }
        }
        measurements.push({
            name: workload.name,
            characters: workload.input.length,
            expected: workload.expected,
            syntrix: summarize(samples.syntrix)
        });
    }
    return measurements;
}
const parsing = measureParsing(workloads, parsers, true);
const sourceParsing = measureParsing(sourceWorkloads, {
    syntrix: createSourceSyntrix()
});

function expectedTokensFor (input, source) {
    const pattern = source ? /[a-z_][a-z_0-9]*|[0-9]+|[=;]|[ \n]+/g : /[0-9]+|\+|[ \n]+/g;
    const symbols = { '+': 'PLUS', '=': 'EQUALS', ';': 'SEMICOLON' };
    const tokens = Array.from(input.matchAll(pattern), match => ({
        tokenType: /^[0-9]/.test(match[0]) ? 'NUMBER'
            : /^[a-z_]/.test(match[0]) ? 'IDENT' : symbols[match[0]] ?? 'SPACE',
        content: match[0],
        startPosition: match.index,
        pos: match.index + match[0].length
    }));
    assert.equal(tokens.map(token => token.content).join(''), input, 'incomplete benchmark oracle');
    return tokens;
}

function scan (lexer, input, chunkSize, collect = false) {
    lexer.setInput(chunkSize === null ? input : '', { final: chunkSize === null });
    const tokens = [];
    let count = 0;
    let characters = 0;
    const consume = () => {
        while (true) {
            const token = lexer.nextToken();
            if (token === null || token.tokenType === 'eof') return token;
            count++;
            characters += token.content.length;
            if (collect) tokens.push({
                tokenType: token.tokenType,
                content: token.content,
                startPosition: token.startPosition,
                pos: token.toPos ?? token.pos
            });
        }
    };
    if (chunkSize !== null) {
        for (let offset = 0; offset < input.length; offset += chunkSize) {
            lexer.appendInput(input.slice(offset, offset + chunkSize));
            if (consume() !== null) throw new Error('Lexer ended before the final chunk');
        }
        lexer.finishInput();
    }
    assert.equal(consume().tokenType, 'eof');
    return { count, characters, tokens, retainedInputChars: lexer.input.length };
}

const lexerModes = [
    { name: 'complete', chunkSize: null, discard: false },
    { name: 'streaming-1', chunkSize: 1, discard: false },
    { name: 'streaming-64', chunkSize: 64, discard: false },
    { name: 'streaming-64-discard', chunkSize: 64, discard: true },
    { name: 'streaming-long-token', chunkSize: 8, discard: false, input: `${'7'.repeat(1024)} +` },
    { name: 'source-complete', chunkSize: null, discard: false, input: sourceInput, source: true },
    { name: 'source-streaming-64', chunkSize: 64, discard: false, input: sourceInput, source: true },
    { name: 'source-streaming-64-discard', chunkSize: 64, discard: true, input: sourceInput, source: true }
];
const lexerRuns = lexerModes.map(mode => {
    const input = mode.input ?? lexerInput;
    const expectedTokens = expectedTokensFor(input, mode.source);
    const lexer = mode.source ? createSourceBenchmarkLexer(mode.discard) : createBenchmarkLexer(mode.discard);
    const verification = scan(lexer, input, mode.chunkSize, true);
    assert.equal(verification.tokens.length, expectedTokens.length, `${mode.name}: incorrect token count`);
    for (let index = 0; index < expectedTokens.length; index++) {
        assert.deepEqual(verification.tokens[index], expectedTokens[index], `${mode.name}: token ${index}`);
    }
    return { mode, input, expectedTokens, lexer, verification, samples: [] };
});
for (let index = 0; index < settings.warmup + settings.samples; index++) {
    const runs = index % 2 ? [...lexerRuns].reverse() : lexerRuns;
    for (const { mode, input, expectedTokens, lexer, samples } of runs) {
        let result;
        const start = performance.now();
        for (let iteration = 0; iteration < settings.iterations; iteration++) {
            result = scan(lexer, input, mode.chunkSize);
        }
        const duration = (performance.now() - start) / settings.iterations;
        assert.equal(result.count, expectedTokens.length, `${mode.name}: incorrect token count`);
        assert.equal(result.characters, input.length, `${mode.name}: incomplete input`);
        if (index >= settings.warmup) samples.push(duration);
    }
}
const lexing = lexerRuns.map(({ mode, input, expectedTokens, verification, samples }) => ({
    name: mode.name,
    characters: input.length,
    tokens: expectedTokens.length,
    retainedInputChars: verification.retainedInputChars,
    ...summarize(samples)
}));
const lexerComparisons = [
    ['streaming-64-discard', 'streaming-64'],
    ['source-streaming-64-discard', 'source-streaming-64']
].map(([numerator, denominator]) => {
    const discard = lexerRuns.find(run => run.mode.name === numerator);
    const retain = lexerRuns.find(run => run.mode.name === denominator);
    const ratios = summarize(discard.samples.map((sample, index) => sample / retain.samples[index]));
    return { numerator, denominator, medianRatio: ratios.medianMs, p95Ratio: ratios.p95Ms };
});

const result = {
    environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown'
    },
    settings: { samples: settings.samples, warmup: settings.warmup, iterations: settings.iterations },
    generation: { syntrix: summarize(generation.syntrix) },
    parsing,
    sourceParsing,
    lexing,
    lexerComparisons
};

if (settings.json) {
    console.log(JSON.stringify(result, null, 2));
} else {
    console.log(`Node ${result.environment.node}, ${result.environment.cpu}`);
    console.log(`Samples: ${settings.samples}; warmup: ${settings.warmup}; parses/sample: ${settings.iterations}`);
    console.log('Times are median and p95 milliseconds per operation; lower is better.');
    console.table([
        { workload: 'generation', ...result.generation },
        ...[...parsing, ...sourceParsing].map(({ name, syntrix }) => ({ workload: name, syntrix }))
    ].map(({ workload, syntrix }) => ({
        workload,
        'Syntrix median': syntrix.medianMs.toFixed(3),
        'Syntrix p95': syntrix.p95Ms.toFixed(3)
    })));
    console.log('Syntrix lexer metrics:');
    console.table(lexing.map(({ name, medianMs, p95Ms, retainedInputChars }) => ({
        workload: name,
        'median': medianMs.toFixed(3),
        'p95': p95Ms.toFixed(3),
        'retained input characters': retainedInputChars
    })));
    console.log('Paired per-sample ratios (discard / retain):');
    console.table(lexerComparisons);
}
