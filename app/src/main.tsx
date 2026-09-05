import 'virtual:buffer-polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';
import App from './App';
import Dash from './pages/Dash';
import Records from './pages/Records';
import AmmPage from './pages/AmmPage';
import { HomePageIndicator } from './components/amm/HomePageIndicator';
import { ChainDataProvider } from './context/ChainDataProvider';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 15000, retry: 2 },
    },
});

const wallets = [new SolflareWalletAdapter()];
const endpoint = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com';

// web3.js retries HTTP 429s internally (5x, 500ms→8s) and console.errors
// "Server responded with 429 Too Many Requests. Retrying…" on every attempt.
// On rate-limited shared endpoints (Helius free-tier devnet) that turns a
// single 429 into a console-spam retry storm that multiplies the load.
// Disable it so TanStack Query is the single retry layer (backoff + jitter).
const connectionConfig = { disableRetryOnRateLimit: true };

function Shell() {
    const { pathname } = useLocation();
    // Hide the yellow "offers available" indicator on the offer desk itself
    // (it links there) and on the Records ledger (kept dry for marketing).
    const hideIndicator =
        pathname === '/offer-desk' ||
        pathname.startsWith('/offer-desk/') ||
        pathname === '/records' ||
        pathname.startsWith('/records/');
    return (
        <>
            {!hideIndicator && <HomePageIndicator />}
            <Outlet />
        </>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <QueryClientProvider client={queryClient}>
                        <ChainDataProvider>
                            <BrowserRouter>
                                <Routes>
                                    <Route element={<Shell />}>
                                        <Route path="/" element={<App />} />
                                        <Route path="/dash" element={<Dash />} />
                                        <Route path="/records" element={<Records />} />
                                        <Route path="/offer-desk" element={<AmmPage />} />
                                    </Route>
                                </Routes>
                            </BrowserRouter>
                        </ChainDataProvider>
                    </QueryClientProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    </StrictMode>
);
