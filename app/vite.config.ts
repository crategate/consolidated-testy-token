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
    // Code-split the build: route chunks via React.lazy in main.tsx plus
    // vendor groups here. Notes:
    // - includeDependenciesRecursively stays false so a group never drags
    //   `buffer` (or anything else) away from its import-order position;
    //   strictExecutionOrder preserves single-bundle evaluation order across
    //   chunks. This keeps the virtual buffer polyfill (import #1 in
    //   main.tsx) evaluating before any @solana module that calls
    //   Buffer.from() at top level (spl-token-metadata) → no blank page.
    // - `buffer` itself is deliberately in NO group (falls into v-misc with
    //   the other leaf packages) so the polyfill's dependency never lands in
    //   a vendor chunk that could evaluate early.
    // - v-misc must stay the LAST group: earlier matching groups win.
    build: {
        rolldownOptions: {
            output: {
                strictExecutionOrder: true,
                codeSplitting: {
                    minSize: 0,
                    includeDependenciesRecursively: false,
                    groups: [
                        { name: 'v-react', test: /node_modules\/(react|react-dom|scheduler)\// },
                        { name: 'v-router', test: /node_modules\/(react-router|react-router-dom)\// },
                        { name: 'v-query', test: /node_modules\/@tanstack\// },
                        { name: 'v-web3', test: /node_modules\/@solana\/web3\.js\// },
                        { name: 'v-anchor', test: /node_modules\/@coral-xyz\// },
                        { name: 'v-crypto', test: /node_modules\/(@noble\/|bn\.js\/|superstruct\/|uuid\/|rpc-websockets\/|eventemitter3\/|jayson\/|node-fetch\/|@swc\/helpers\/)/ },
                        { name: 'v-spl', test: /node_modules\/(@solana\/spl-token[\/-]|@solana\/spl-token-metadata|@metaplex-foundation\/|@solana\/buffer-layout\/)/ },
                        { name: 'v-wallet', test: /node_modules\/(@solana\/wallet-adapter[\/-]|@solana\/wallet-standard[\/-]|@wallet-standard\/|@solana-mobile\/|@solana\/errors\/|@solana\/codecs[\/-]|qrcode\/|dijkstrajs\/|text-encoding-utf-8\/)/ },
                        { name: 'v-misc', test: /node_modules\// },
                    ],
                },
            },
        },
    },
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
