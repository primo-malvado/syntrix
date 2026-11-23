/// <reference lib="webworker" />

import { parseToyLanguage } from './toy-language.js';

addEventListener('message', ({ data }) => {
    try {
        postMessage({ ok: true, result: parseToyLanguage(data.input, data.algorithm) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        postMessage({ ok: false, error: message });
    }
});
