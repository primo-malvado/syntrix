import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpus, platform, arch, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createCorpusParser, corpus } from './corpus-grammars.mjs';
import { evaluateCorpusCriteria } from './corpus-criteria.mjs';

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const positiveInteger = value => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('Expected a positive integer');
    }
    return Number(value);
};

if (args[0] === '--worker') {
    const [, name, warmupArg, samplesArg] = args;
    const workload = corpus.find(item => item.name === name);
    if (!workload || typeof global.gc !== 'function') {
        throw new Error('Worker requires a known workload and --expose-gc');
    }
    const warmup = positiveInteger(warmupArg);
    const samples = positiveInteger(samplesArg);
    const expected = JSON.parse(workload.input);
    const constructionStart = performance.now();
    const parser = await createCorpusParser('syntrix');
    const coldConstructionMs = performance.now() - constructionStart;
    const firstStart = performance.now();
    let firstResult = parser.parse(workload.input);
    const firstParseMs = performance.now() - firstStart;
    assert.deepEqual(firstResult, expected);
    firstResult = null;
    for (let index = 1; index < warmup; index++) {
        assert.deepEqual(parser.parse(workload.input), expected);
    }
    global.gc();
    const baseline = process.memoryUsage();
    let sampledPeakRssBytes = baseline.rss;
    let sampledPeakHeapBytes = baseline.heapUsed;
    let result;
    const timings = [];
    for (let index = 0; index < samples; index++) {
        const start = performance.now();
        result = parser.parse(workload.input);
        timings.push(performance.now() - start);
        const memory = process.memoryUsage();
        sampledPeakRssBytes = Math.max(sampledPeakRssBytes, memory.rss);
        sampledPeakHeapBytes = Math.max(sampledPeakHeapBytes, memory.heapUsed);
        assert.deepEqual(result, expected);
    }
    global.gc();
    const retained = process.memoryUsage();
    console.log(JSON.stringify({
        medianMs: median(timings),
        p95Ms: p95(timings),
        coldConstructionMs,
        firstParseMs,
        sampledPeakRssBytes,
        sampledPeakHeapBytes,
        retainedHeapBytes: retained.heapUsed
    }));
} else {
    const settings = { pairs: 5, samples: 20, warmup: 3, json: false };
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === '--json') settings.json = true;
        else if (['--pairs', '--samples', '--warmup'].includes(option)) {
            settings[option.slice(2)] = positiveInteger(args[++index]);
        } else {
            throw new Error(`Unknown option ${option}`);
        }
    }
    const workloads = [];
    for (const workload of corpus) {
        const pairs = [];
        for (let index = 0; index < settings.pairs; index++) {
            pairs.push(JSON.parse(execFileSync(process.execPath, [
                '--expose-gc', script, '--worker', workload.name,
                String(settings.warmup), String(settings.samples)
            ], { encoding: 'utf8' })));
        }
        workloads.push({
            name: workload.name,
            characters: workload.input.length,
            syntrix: {
                medianMs: median(pairs.map(pair => pair.medianMs)),
                p95Ms: median(pairs.map(pair => pair.p95Ms)),
                coldConstructionMs: median(pairs.map(pair => pair.coldConstructionMs)),
                firstParseMs: median(pairs.map(pair => pair.firstParseMs)),
                sampledPeakRssBytes: median(pairs.map(pair => pair.sampledPeakRssBytes)),
                sampledPeakHeapBytes: median(pairs.map(pair => pair.sampledPeakHeapBytes)),
                retainedHeapBytes: median(pairs.map(pair => pair.retainedHeapBytes))
            }
        });
    }
    const criteria = evaluateCorpusCriteria(workloads, settings);
    const result = {
        environment: {
            node: process.version, v8: process.versions.v8, platform: platform(), arch: arch(),
            release: release(), cpu: cpus()[0]?.model ?? 'unknown'
        },
        settings: { pairs: settings.pairs, samples: settings.samples, warmup: settings.warmup },
        workloads,
        criteria
    };
    if (settings.json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`Node ${result.environment.node}, ${result.environment.cpu}`);
        console.table(workloads.map(item => ({
            workload: item.name,
            'Syntrix median': item.syntrix.medianMs.toFixed(3),
            'Syntrix p95': item.syntrix.p95Ms.toFixed(3),
            'Syntrix first': item.syntrix.firstParseMs.toFixed(3)
        })));
        console.log(`Syntrix corpus benchmark: ${result.criteria.status}.`);
    }
}
