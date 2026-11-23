import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { createCorpusParser, corpus } from './corpus-grammars.mjs';

const settings = { workload: 'config-small', stage: 'parse', mode: 'cpu', warmup: 3, iterations: 20 };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!['--workload', '--stage', '--mode', '--warmup', '--iterations'].includes(option) ||
        index + 1 === args.length) throw new Error(`Unknown or incomplete option ${option}`);
    const value = args[++index];
    if (option === '--warmup' || option === '--iterations') {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw new Error(`Expected a positive integer for ${option}`);
        }
        settings[option.slice(2)] = Number(value);
    } else {
        settings[option.slice(2)] = value;
    }
}
const workload = corpus.find(item => item.name === settings.workload);
if (!workload || !['parse', 'lexer', 'parser'].includes(settings.stage) ||
    !['cpu', 'alloc'].includes(settings.mode)) throw new Error('Unknown workload, stage or mode');

const parser = await createCorpusParser('syntrix');
const lexer = parser.lexer;
const expected = JSON.parse(workload.input);
const tokens = [];
if (settings.stage !== 'parse') {
    lexer.setInput(workload.input);
    while (true) {
        const token = lexer.nextToken();
        tokens.push(token);
        if (token.tokenType === 'eof') break;
    }
    assert.equal(tokens.slice(0, -1).map(token => token.content).join(''), workload.input);
}

if (settings.stage === 'parser') {
    parser.lexer = {
        setInput (input) { this.input = input; this.index = 0; },
        finishInput () {},
        readToken () { return tokens[this.index]; },
        popToken () { return tokens[this.index++]; }
    };
}

const run = settings.stage === 'lexer'
    ? () => {
        lexer.setInput(workload.input);
        let count = 0;
        while (true) {
            const token = lexer.nextToken();
            count++;
            if (token.tokenType === 'eof') return count;
        }
    }
    : () => parser.parse(workload.input);
const verify = settings.stage === 'lexer'
    ? result => assert.equal(result, tokens.length)
    : result => assert.deepEqual(result, expected);

for (let index = 0; index < settings.warmup; index++) verify(run());
if (typeof global.gc === 'function') global.gc();

const session = new Session();
session.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
});
if (settings.mode === 'cpu') {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 100 });
    await post('Profiler.start');
} else {
    await post('HeapProfiler.enable');
    await post('HeapProfiler.startSampling', {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true
    });
}
let result;
for (let index = 0; index < settings.iterations; index++) result = run();
const { profile } = await post(settings.mode === 'cpu' ? 'Profiler.stop' : 'HeapProfiler.stopSampling');
session.disconnect();
verify(result);
console.log(JSON.stringify({ settings, node: process.version, profile }));
