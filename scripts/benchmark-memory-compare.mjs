import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { corpus } from './corpus-grammars.mjs';
import { requireJison } from './benchmark-jison.mjs';

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const positiveInteger = (value, option) => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${option} must be a positive integer`);
    }
    return Number(value);
};
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const jisonGrammar = {
    lex: {
        rules: [
            ['\\s+', '/* skip whitespace */'],
            ['\\"[a-zA-Z0-9_ ]*\\"', 'return "STRING";'],
            ['-?(0|[1-9][0-9]*)(\\.[0-9]+)?', 'return "NUMBER";'],
            ['true', 'return "TRUE";'], ['false', 'return "FALSE";'], ['null', 'return "NULL";'],
            ['\\{', 'return "LBRACE";'], ['\\}', 'return "RBRACE";'],
            ['\\[', 'return "LBRACKET";'], ['\\]', 'return "RBRACKET";'],
            [':', 'return "COLON";'], [',', 'return "COMMA";']
        ]
    },
    bnf: {
        entry: [['value', 'return $1;']],
        value: [
            ['STRING', '$$ = JSON.parse($1);'], ['NUMBER', '$$ = Number($1);'],
            ['TRUE', '$$ = true;'], ['FALSE', '$$ = false;'], ['NULL', '$$ = null;'],
            ['object', '$$ = $1;'], ['array', '$$ = $1;']
        ],
        object: [['LBRACE members RBRACE', '$$ = Object.fromEntries($2);'], ['LBRACE RBRACE', '$$ = {};']],
        members: [['member', '$$ = [$1];'], ['members COMMA member', '$$ = $1.concat([$3]);']],
        member: [['STRING COLON value', '$$ = [JSON.parse($1), $3];']],
        array: [['LBRACKET elements RBRACKET', '$$ = $2;'], ['LBRACKET RBRACKET', '$$ = [];']],
        elements: [['value', '$$ = [$1];'], ['elements COMMA value', '$$ = $1.concat([$3]);']]
    }
};

async function createParser (implementation) {
    if (implementation === 'syntrix') {
        const { createCorpusParser } = await import('./corpus-grammars.mjs');
        return createCorpusParser('syntrix');
    }
    if (implementation === 'jison') {
        const { default: jison } = await import('jison');
        return new jison.Parser(jisonGrammar);
    }
    throw new TypeError(`Unknown implementation: ${implementation}`);
}

if (args[0] === '--worker') {
    if (typeof global.gc !== 'function') throw new Error('Memory benchmark requires --expose-gc');
    const implementation = args[1];
    const workload = corpus.find(item => item.name === args[2]);
    if (!workload) throw new Error(`Unknown workload: ${args[2]}`);
    if (implementation === 'jison') requireJison();
    const parser = await createParser(implementation);
    const expected = JSON.parse(workload.input);
    assert.deepEqual(parser.parse(workload.input), expected);
    global.gc();
    const baseline = process.memoryUsage();
    let peakHeapUsedBytes = baseline.heapUsed;
    let peakRssBytes = baseline.rss;
    for (let index = 0; index < 5; index++) {
        assert.deepEqual(parser.parse(workload.input), expected);
        const memory = process.memoryUsage();
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
        peakRssBytes = Math.max(peakRssBytes, memory.rss);
    }
    global.gc();
    const retained = process.memoryUsage();
    console.log(JSON.stringify({
        implementation,
        workload: workload.name,
        characters: workload.input.length,
        baselineHeapUsedBytes: baseline.heapUsed,
        peakHeapUsedBytes,
        peakRssBytes,
        retainedHeapUsedBytes: retained.heapUsed,
        retainedHeapChangeBytes: retained.heapUsed - baseline.heapUsed
    }));
} else {
    const settings = { pairs: 10, minPairs: 10, json: false };
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === '--json') settings.json = true;
        else if (['--pairs', '--min-pairs'].includes(option)) {
            const name = option === '--min-pairs' ? 'minPairs' : 'pairs';
            settings[name] = positiveInteger(args[++index], option);
        } else {
            throw new Error(`Unknown option ${option}`);
        }
    }

    const jisonVersion = requireJison();
    const measurements = [];
    for (const workload of corpus) {
        const samples = { syntrix: [], jison: [] };
        for (let pair = 0; pair < settings.pairs; pair++) {
            const implementations = pair % 2 ? ['jison', 'syntrix'] : ['syntrix', 'jison'];
            for (const implementation of implementations) {
                samples[implementation].push(JSON.parse(execFileSync(process.execPath, [
                    '--expose-gc', script, '--worker', implementation, workload.name
                ], { encoding: 'utf8' })));
            }
        }
        for (const implementation of ['syntrix', 'jison']) {
            const batch = samples[implementation];
            const summarizeMemory = key => median(batch.map(item => item[key]));
            measurements.push({
                implementation,
                workload: workload.name,
                characters: workload.input.length,
                baselineHeapUsedBytes: summarizeMemory('baselineHeapUsedBytes'),
                peakHeapUsedBytes: summarizeMemory('peakHeapUsedBytes'),
                peakRssBytes: summarizeMemory('peakRssBytes'),
                retainedHeapUsedBytes: summarizeMemory('retainedHeapUsedBytes'),
                retainedHeapChangeBytes: Math.round(summarizeMemory('retainedHeapChangeBytes')),
                sampleSufficiency: {
                    minimum: settings.minPairs,
                    observed: settings.pairs,
                    sufficient: settings.pairs >= settings.minPairs
                }
            });
        }
    }
    const result = {
        node: process.version,
        jison: jisonVersion,
        settings,
        sampleSufficiency: {
            minimum: settings.minPairs,
            observed: settings.pairs,
            sufficient: settings.pairs >= settings.minPairs
        },
        measurements
    };
    if (settings.json) console.log(JSON.stringify(result, null, 2));
    else {
        if (!result.sampleSufficiency.sufficient) {
            console.warn('WARNING: process-pair count is below the stated minimum; treat these measurements as exploratory.');
        }
        console.table(measurements);
    }
}
