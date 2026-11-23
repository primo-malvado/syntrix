import { Component, OnDestroy, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { lexerGrammar, parserGrammar } from './calculator.js';

interface Calculation {
    value: number | number[];
    tokens: { type: string; content: string }[];
    states: number;
    diagnostics: { message: string }[];
}

interface ToyLanguageResult {
    ast: unknown;
    tokens: { type: string; content: string }[];
    states: number;
    diagnostics: { message: string }[];
}

type WorkerResponse = { ok: true; result: Calculation } | { ok: false; error: string };
type ToyWorkerResponse = { ok: true; result: ToyLanguageResult } | { ok: false; error: string };
type EditorTab = 'lexer' | 'parser';

@Component({
    selector: 'app-root',
    standalone: true,
    imports: [FormsModule],
    changeDetection: ChangeDetectionStrategy.Eager,
    templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
    readonly examples = [
        { label: 'Trigonometry', expression: 'sin(pi / 2) + cos(0)' },
        { label: 'Powers', expression: '2^3^2 - 2^4' },
        { label: 'Roots and logs', expression: 'sqrt(144) + log(100)' },
        { label: 'Scientific notation', expression: '6.02e2 / 2' }
    ];
    readonly toyExamples = [
        { label: 'Variables', program: 'let total = 2 + 3 * 4;\ntotal = total + 1;\nprint total;' },
        { label: 'Parentheses', program: 'let result = (8 + 4) / 3;\nprint result;' }
    ];
    readonly setupCode = `import { Lexer, Parser, createEbnfLexer,
  createEbnfParser } from 'syntrix';

const lexerTokens = [
  'NUMBER', 'IDENT', 'PLUS', 'MINUS', 'STAR',
  'SLASH', 'POWER', 'LP', 'RP', 'SPACE'
];
const parserTokens = lexerTokens.filter(token => token !== 'SPACE');

const lexerTable = createEbnfLexer(lexerGrammar, {
  tokens: lexerTokens
});

const parserTable = createEbnfParser(parserGrammar, {
  start: 'entry',
  tokens: parserTokens,
  ignoreTokens: ['SPACE'],
  actionContext: { finite, constant, call },
  algorithm: 'lalr1'
});`;
    readonly runCode = `const lexer = new Lexer(lexerTable);
const parser = new Parser(lexer, parserTable);

parser.parse('sqrt(144) + log(100)');
// 14`;
    readonly helpersCode = `const functions = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  sqrt: Math.sqrt, ln: Math.log, log: Math.log10,
  abs: Math.abs
};
const constants = { pi: Math.PI, e: Math.E };

function finite(value) {
  if (!Number.isFinite(value))
    throw new RangeError('The result is not a finite number.');
  return value;
}
function constant(name) {
  if (!Object.hasOwn(constants, name))
    throw new Error(\`Unknown constant: \${name}\`);
  return constants[name];
}
function call(name, value) {
  if (!Object.hasOwn(functions, name))
    throw new Error(\`Unknown function: \${name}\`);
  return finite(functions[name](value));
}`;

    lexerSource = lexerGrammar;
    parserSource = parserGrammar;
    expression = 'sin(pi / 2) + sqrt(81)';
    algorithm = 'lalr1';
    toySource = this.toyExamples[0].program;
    activeTab: EditorTab = 'lexer';
    result: Calculation | null = null;
    toyResult: ToyLanguageResult | null = null;
    error = '';
    toyError = '';
    running = false;
    toyRunning = false;
    stale = false;
    toyStale = false;
    private worker: Worker | null = null;
    private toyWorker: Worker | null = null;
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private toyTimeout: ReturnType<typeof setTimeout> | null = null;

    ngOnInit(): void {
        this.run();
        this.runToyLanguage();
    }

    ngOnDestroy(): void {
        this.stopWorker();
        this.stopToyWorker();
    }

    selectTab(tab: EditorTab): void {
        this.activeTab = tab;
    }

    selectExample(expression: string): void {
        this.expression = expression;
        this.run();
    }

    markStale(): void {
        this.stale = true;
    }

    formatValue(value: number | number[]): string {
        return Array.isArray(value) ? JSON.stringify(value) : String(value);
    }

    formatAst(ast: unknown): string {
        return JSON.stringify(ast, null, 2);
    }

    selectToyExample(program: string): void {
        this.toySource = program;
        this.runToyLanguage();
    }

    markToyStale(): void {
        this.toyStale = true;
    }

    reset(): void {
        this.lexerSource = lexerGrammar;
        this.parserSource = parserGrammar;
        this.expression = 'sin(pi / 2) + sqrt(81)';
        this.algorithm = 'lalr1';
        this.run();
    }

    resetToyLanguage(): void {
        this.toySource = this.toyExamples[0].program;
        this.runToyLanguage();
    }

    run(): void {
        this.stopWorker();
        this.running = true;
        this.error = '';
        this.result = null;
        this.stale = false;

        try {
            const worker = new Worker(new URL('./calculator.worker.ts', import.meta.url), { type: 'module' });
            this.worker = worker;
            worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
                if (data.ok) this.result = data.result;
                else this.error = data.error;
                this.running = false;
                this.stopWorker();
            };
            worker.onerror = event => {
                this.error = `Could not run the calculator: ${event.message}`;
                this.running = false;
                this.stopWorker();
            };
            this.timeout = setTimeout(() => {
                this.error = 'Parsing exceeded 10 seconds. Check the grammar or expression.';
                this.running = false;
                this.stopWorker();
            }, 10_000);
            worker.postMessage({
                lexerSource: this.lexerSource,
                parserSource: this.parserSource,
                input: this.expression,
                algorithm: this.algorithm
            });
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
            this.running = false;
            this.stopWorker();
        }
    }

    runToyLanguage(): void {
        this.stopToyWorker();
        this.toyRunning = true;
        this.toyError = '';
        this.toyResult = null;
        this.toyStale = false;

        try {
            const worker = new Worker(new URL('./toy-language.worker.ts', import.meta.url), { type: 'module' });
            this.toyWorker = worker;
            worker.onmessage = ({ data }: MessageEvent<ToyWorkerResponse>) => {
                if (data.ok) this.toyResult = data.result;
                else this.toyError = data.error;
                this.toyRunning = false;
                this.stopToyWorker();
            };
            worker.onerror = event => {
                this.toyError = `Could not parse the toy language program: ${event.message}`;
                this.toyRunning = false;
                this.stopToyWorker();
            };
            this.toyTimeout = setTimeout(() => {
                this.toyError = 'Parsing exceeded 10 seconds. Check the program syntax.';
                this.toyRunning = false;
                this.stopToyWorker();
            }, 10_000);
            worker.postMessage({ input: this.toySource });
        } catch (error) {
            this.toyError = error instanceof Error ? error.message : String(error);
            this.toyRunning = false;
            this.stopToyWorker();
        }
    }

    private stopWorker(): void {
        this.worker?.terminate();
        this.worker = null;
        if (this.timeout !== null) clearTimeout(this.timeout);
        this.timeout = null;
    }

    private stopToyWorker(): void {
        this.toyWorker?.terminate();
        this.toyWorker = null;
        if (this.toyTimeout !== null) clearTimeout(this.toyTimeout);
        this.toyTimeout = null;
    }
}
