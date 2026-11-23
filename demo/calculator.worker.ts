/// <reference lib="webworker" />

import { calculate } from './calculator.js';

addEventListener('message', ({ data }) => {
    try {
        postMessage({ ok: true, result: calculate(data) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        postMessage({ ok: false, error: message });
    }
});
