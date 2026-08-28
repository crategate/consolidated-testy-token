import 'virtual:buffer-polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';
import App from './App';
import Dash from './pages/Dash';
import AmmPage from './pages/AmmPage';
import { HomePageIndicator } from './components/amm/HomePageIndicator';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 15000, retry: 2 },
    },
});

const wallets = [new SolflareWalletAdapter()];
const endpoint = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com';

function Shell() {
    const { pathname } = useLocation();
    const onOfferDesk = pathname === '/offer-desk' || pathname.startsWith('/offer-desk/');
    return (
        <>
            {!onOfferDesk && <HomePageIndicator />}
            <Outlet />
        </>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <QueryClientProvider client={queryClient}>
                        <BrowserRouter>
                            <Routes>
                                <Route element={<Shell />}>
                                    <Route path="/" element={<App />} />
                                    <Route path="/dash" element={<Dash />} />
                                    <Route path="/offer-desk" element={<AmmPage />} />
                                </Route>
                            </Routes>
                        </BrowserRouter>
                    </QueryClientProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    </StrictMode>
);