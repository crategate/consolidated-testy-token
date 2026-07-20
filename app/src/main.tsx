import 'virtual:buffer-polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';
import App from './App';
import Dash from './pages/Dash';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { refetchInterval: 30000, staleTime: 15000, retry: 2 },
    },
});

const wallets = [new SolflareWalletAdapter()];
const endpoint = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <QueryClientProvider client={queryClient}>
                        <BrowserRouter>
                            <Routes>
                                <Route path="/" element={<App />} />
                                <Route path="/dash" element={<Dash />} />
                            </Routes>
                        </BrowserRouter>
                    </QueryClientProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    </StrictMode>
);
