import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Inline plugin: injects Buffer polyfill before any dependency loads
function bufferPolyfill(): Plugin {
    const virtualModuleId = 'virtual:buffer-polyfill';
    const resolvedVirtualModuleId = '\0' + virtualModuleId;

    return {
        name: 'buffer-polyfill',
        enforce: 'pre',
        resolveId(id) {
            if (id === virtualModuleId) return resolvedVirtualModuleId;
        },
        load(id) {
            if (id === resolvedVirtualModuleId) {
                return `
                    import bufferPkg from 'buffer';
                    const Buffer = bufferPkg.Buffer ?? bufferPkg;
                    if (typeof window !== 'undefined' && !window.Buffer) {
                        window.Buffer = Buffer;
                    }
                    if (typeof globalThis !== 'undefined' && !globalThis.Buffer) {
                        globalThis.Buffer = Buffer;
                    }
                    export { Buffer };
                `;
            }
        },
    };
}

export default defineConfig({
    // Clean browser-router URLs need an absolute base. If you deploy to a
    // subfolder, change this to '/subfolder/' and set BrowserRouter basename
    // to match, and configure your server to serve index.html for all routes.
    base: '/',
    plugins: [bufferPolyfill(), react()],
    resolve: {
        alias: {
            // Force every bare `import 'buffer'` to the npm package's filesystem
            // entry. Otherwise the rolldown optimizer treats `buffer` as a node
            // builtin, externalizes it (browser stub), and bn.js inside
            // @solana/web3.js crashes with "Buffer is not defined" → blank page.
            buffer: 'buffer/',
            '@idl': path.resolve(__dirname, '../target/idl'),
            '@types': path.resolve(__dirname, '../target/types'),
            '@': path.resolve(__dirname, '../')
        },
    },
    define: {
        global: 'globalThis',
    },
    optimizeDeps: {
        rolldownOptions: {
            output: {
                // No codeSplitting groups here: sharing one vendor chunk
                // merges `buffer` with @solana/* packages, so importing the
                // polyfill chunk evaluates spl-token-metadata's top-level
                // `Buffer.from()` before window.Buffer exists → blank page.
                // Per-entry chunks keep main.tsx's import order intact.
            },
        },
        include: ['buffer', '@coral-xyz/anchor', '@solana/web3.js'],
    },
});
