export function isJisonInstalled () {
    try {
        import.meta.resolve('jison');
        return true;
    } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return false;
        throw error;
    }
}

export function requireJison () {
    if (!isJisonInstalled()) {
        throw new Error('Jison is required for comparative benchmarks. Install it with: ' +
            'npm install --no-save --package-lock=false jison@0.3.12');
    }
    const metadata = JSON.parse(readFileSync(new URL(import.meta.resolve('jison/package.json')), 'utf8'));
    if (typeof metadata.version !== 'string' || !metadata.version) {
        throw new Error('The installed Jison package does not declare a version.');
    }
    return metadata.version;
}
import { readFileSync } from 'node:fs';

