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
                    import { Buffer } from 'buffer';
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
    // Relative base so the built app works from ANY path (cPanel subfolder,
    // subdomain, file:// preview) — absolute /assets/... paths 404 when the
    // dist folder isn't at the domain root.
    base: './',
    plugins: [bufferPolyfill(), react()],
    resolve: {
        alias: {
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

        },
        include: ['buffer', '@coral-xyz/anchor', '@solana/web3.js'],
    },
});
