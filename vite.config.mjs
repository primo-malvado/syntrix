import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL('./src/client/index.js', import.meta.url)),
            formats: ['es'],
            fileName: 'syntrix'
        },
        rollupOptions: {
            output: {
                exports: 'named'
            }
        }
    }
});
