import { MarketStatus } from './components/MarketStatus';
// import { StakeForm } from './components/StakeForm';
// import { Positions } from './components/Positions';

function App() {
    return (
        <div className="app-shell">
            <MarketStatus />

            <main className="app-content">
                {/* Staking UI layers on top here */}
                {/* <StakeForm /> */}
                {/* <Positions /> */}
            </main>
        </div>
    );
}

export default App;
