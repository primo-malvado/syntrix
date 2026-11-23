import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpus, platform, arch, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { corpus } from './corpus-grammars.mjs';
import { workloads } from './benchmark-data.mjs';

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const worker = args[0] === '--worker';
const positiveInteger = (value, option) => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${option} must be a positive integer`);
    }
    return Number(value);
};
const settings = { samples: 20, minSamples: 20, warmup: 5, iterations: 25, json: false };

if (!worker) {
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === '--json') settings.json = true;
        else if (['--samples', '--min-samples', '--warmup', '--iterations'].includes(option)) {
            const name = option === '--min-samples' ? 'minSamples' : option.slice(2);
            settings[name] = positiveInteger(args[++index], option);
        } else {
            throw new Error(`Unknown option ${option}`);
        }
    }
}

const jisonExpressionGrammar = {
    lex: {
        rules: [
            ['\\s+', '/* skip whitespace */'],
            ['[0-9]+\\b', "return 'NUMBER';"],
            ['\\+', "return 'PLUS';"],
            ['\\*', "return 'STAR';"],
            ['\\(', "return 'LP';"],
            ['\\)', "return 'RP';"]
        ]
    },
    operators: [['left', 'PLUS'], ['left', 'STAR']],
    bnf: {
        entry: [['expr', 'return $1;']],
        expr: [
            ['expr PLUS expr', '$$ = $1 + $3;'],
            ['expr STAR expr', '$$ = $1 * $3;'],
            ['LP expr RP', '$$ = $2;'],
            ['NUMBER', '$$ = Number($1);']
        ]
    }
};

const jisonJsonGrammar = {
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

const parserGroups = [
    { name: 'expression', workloads },
    { name: 'json', workloads: corpus }
];

function expectedResult (group, workload) {
    return group === 'json' ? JSON.parse(workload.input) : workload.expected;
}

async function createParser (group, implementation) {
    if (implementation === 'syntrix' && group === 'expression') {
        const { createSyntrix } = await import('./benchmark-grammars.mjs');
        return createSyntrix();
    }
    if (implementation === 'syntrix' && group === 'json') {
        const { createCorpusParser } = await import('./corpus-grammars.mjs');
        return createCorpusParser('syntrix');
    }
    if (implementation === 'jison') {
        const { default: jison } = await import('jison');
        return new jison.Parser(group === 'json' ? jisonJsonGrammar : jisonExpressionGrammar);
    }
    throw new Error(`Unknown benchmark implementation ${implementation}`);
}

function summarize (values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
        medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        sampleCount: sorted.length
    };
}

if (worker) {
    const [groupName, implementation, workloadName, warmupArg, iterationsArg] = args.slice(1);
    const group = parserGroups.find(item => item.name === groupName);
    const workload = group?.workloads.find(item => item.name === workloadName);
    if (!workload) throw new Error(`Unknown benchmark workload ${groupName}/${workloadName}`);
    const warmup = positiveInteger(warmupArg, '--warmup');
    const iterations = positiveInteger(iterationsArg, '--iterations');
    const expected = expectedResult(groupName, workload);

    const warmupParser = await createParser(groupName, implementation);
    assert.deepEqual(warmupParser.parse(workload.input), expected);
    for (let index = 0; index < warmup; index++) {
        assert.deepEqual(warmupParser.parse(workload.input), expected);
    }

    const constructionStart = performance.now();
    const parser = await createParser(groupName, implementation);
    const constructionMs = performance.now() - constructionStart;
    assert.deepEqual(parser.parse(workload.input), expected);

    for (let index = 0; index < warmup; index++) {
        assert.deepEqual(parser.parse(workload.input), expected);
    }
    const parseStart = performance.now();
    for (let index = 0; index < iterations; index++) {
        assert.deepEqual(parser.parse(workload.input), expected);
    }
    const parsingMs = (performance.now() - parseStart) / iterations;
    console.log(JSON.stringify({ constructionMs, parsingMs }));
} else {
    const measurements = [];
    for (const group of parserGroups) {
        for (const workload of group.workloads) {
            const samples = { syntrix: [], jison: [] };
            for (let pair = 0; pair < settings.samples; pair++) {
                const implementations = pair % 2 ? ['jison', 'syntrix'] : ['syntrix', 'jison'];
                for (const implementation of implementations) {
                    samples[implementation].push(JSON.parse(execFileSync(process.execPath, [
                        script, '--worker', group.name, implementation, workload.name,
                        String(settings.warmup), String(settings.iterations)
                    ], { encoding: 'utf8' })));
                }
            }
            const result = {
                group: group.name,
                name: workload.name,
                characters: workload.input.length,
                sampleSufficiency: {
                    minimum: settings.minSamples,
                    observed: settings.samples,
                    sufficient: settings.samples >= settings.minSamples
                }
            };
            for (const implementation of ['syntrix', 'jison']) {
                result[implementation] = {
                    construction: summarize(samples[implementation].map(item => item.constructionMs)),
                    parsing: summarize(samples[implementation].map(item => item.parsingMs))
                };
            }
            measurements.push(result);
        }
    }

    const output = {
        environment: {
            node: process.version,
            jison: '0.3.12',
            platform: platform(),
            arch: arch(),
            release: release(),
            cpu: cpus()[0]?.model ?? 'unknown'
        },
        settings: {
            samples: settings.samples,
            minSamples: settings.minSamples,
            warmup: settings.warmup,
            iterations: settings.iterations
        },
        sampleSufficiency: {
            minimum: settings.minSamples,
            observed: settings.samples,
            sufficient: settings.samples >= settings.minSamples
        },
        workloads: measurements
    };

    if (settings.json) console.log(JSON.stringify(output, null, 2));
    else {
        console.log(`Node ${output.environment.node}, ${output.environment.cpu}`);
        console.log(`Independent paired process samples: ${settings.samples}; minimum: ${settings.minSamples}.`);
        console.log(`Warmup parses/process: ${settings.warmup}; parses/measurement: ${settings.iterations}.`);
        console.log('Times are median and p95 milliseconds; lower is better.');
        if (!output.sampleSufficiency.sufficient) {
            console.warn('WARNING: sample count is below the stated minimum; treat these measurements as exploratory.');
        }
        console.table(measurements.flatMap(item => [
            { workload: `${item.group}/${item.name} / construction`, syntrix: item.syntrix.construction, jison: item.jison.construction },
            { workload: `${item.group}/${item.name} / parsing`, syntrix: item.syntrix.parsing, jison: item.jison.parsing }
        ]).map(item => ({
            workload: item.workload,
            'Syntrix median': item.syntrix.medianMs.toFixed(3),
            'Jison median': item.jison.medianMs.toFixed(3),
            'Syntrix p95': item.syntrix.p95Ms.toFixed(3),
            'Jison p95': item.jison.p95Ms.toFixed(3)
        })));
    }
}
