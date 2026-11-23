import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Lexer from '../src/client/classes/Lexer.js';

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const worker = args[0] === '--worker';
if (worker) {
    const discard = args[1] === 'discard';
    const chunks = Number(args[2]);
    if (!['discard', 'retain'].includes(args[1]) || !Number.isSafeInteger(chunks) || chunks < 1 ||
        typeof global.gc !== 'function') {
        throw new Error('Memory worker requires a mode, a positive chunk count and --expose-gc');
    }

    const lexer = new Lexer({
        INITIAL: {
            table: [
                { from: '0', to: '1', _ft_: 'a', _tt_: 'a' },
                { from: '1', to: '1', _ft_: 'a', _tt_: 'a' },
                { from: '0', to: '2', _ft_: '\n', _tt_: '\n' }
            ],
            endMap: { '1': { tokenType: 'A' }, '2': { tokenType: 'NL' } }
        }
    }, { discardConsumedInput: discard });
    const chunk = `${'a'.repeat(127)}\n`.repeat(32);
    lexer.setInput(chunk);
    while (lexer.nextToken().tokenType !== 'eof') {}
    lexer.setInput('', { final: false });
    global.gc();
    const baseline = process.memoryUsage();
    let peakHeapUsedBytes = baseline.heapUsed;
    let peakRssBytes = baseline.rss;
    let tokens = 0;
    for (let index = 0; index < chunks; index++) {
        lexer.appendInput(chunk);
        let token;
        while ((token = lexer.nextToken()) !== null) {
            if (token.tokenType === 'eof') throw new Error('Unexpected EOF before final chunk');
            tokens++;
        }
        const memory = process.memoryUsage();
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
        peakRssBytes = Math.max(peakRssBytes, memory.rss);
    }
    lexer.finishInput();
    let token;
    while ((token = lexer.nextToken()).tokenType !== 'eof') tokens++;
    assert.equal(tokens, chunks * 64);
    global.gc();
    const retained = process.memoryUsage();
    console.log(JSON.stringify({
        mode: args[1],
        characters: chunks * chunk.length,
        tokens,
        retainedInputChars: lexer.input.length,
        baselineHeapUsedBytes: baseline.heapUsed,
        retainedHeapUsedBytes: retained.heapUsed,
        retainedHeapChangeBytes: retained.heapUsed - baseline.heapUsed,
        peakHeapUsedBytes,
        peakRssBytes
    }));
} else {
    let chunks = 256;
    let json = false;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--json') {
            json = true;
        } else if (args[index] === '--chunks') {
            const value = args[++index];
            if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
                throw new Error('--chunks must be a positive integer');
            }
            chunks = Number(value);
        } else {
            throw new Error(`Unknown option ${args[index]}`);
        }
    }
    const measurements = ['retain', 'discard'].map(mode => JSON.parse(execFileSync(process.execPath, [
        '--expose-gc', script, '--worker', mode, String(chunks)
    ], { encoding: 'utf8' })));
    const result = { node: process.version, chunks, chunkCharacters: 4096, measurements };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log('Isolated lexer streaming processes; heap and RSS peaks sampled after each chunk.');
        console.table(measurements);
    }
}
