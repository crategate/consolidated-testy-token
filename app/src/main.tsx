import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { clusterApiUrl } from '@solana/web3.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';
import App from './App';

// Polyfill Buffer for browser
import { Buffer } from 'buffer';
window.Buffer = Buffer;

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchInterval: 30000,
            staleTime: 15000,
            retry: 2,
        },
    },
});

const wallets = [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
];

const endpoint = clusterApiUrl('devnet');

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <QueryClientProvider client={queryClient}>
                        <App />
                    </QueryClientProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    </StrictMode>
);
