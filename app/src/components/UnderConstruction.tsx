
export function UnderConstruction() {
    return (
        <div className="infointro">
            <h1>NYSE Hours</h1>
            <h2>An Experimental Token with TradFi Time Restrictions</h2>

            <p>NYSEH has rewards & penalties structured around the market status of the NYSE.</p>

            <p>It uses a Switchboard Oracle to reliably read when the market is opend, closed, extended hours, or halted.</p>

            <p>Unlocking your tokens when the market is closed penalizes your principle. This tax gets distributed to the other holders. The longer you hold, the higher your payouts.</p>

            <h2>Discount Bonds & Buybacks</h2>
            <p>When the market is closed, insider deals become available. Anyone can buy bulk shares at a discount.</p>

            <p>These bulk sales get put into the lockup protocol, with a vesting period measured in trading days.</p>

            <p>Proceeds from the deals get split as follows:</p>
            <ul>
                <li>80% goes to buybacks executed over the next trading day</li>
                <li>10% gets distributed to stakers</li>
                <li>10% remains reserved for favorable buybacks</li>
            </ul>

            <p>The size, discount, and total available sales depend on the market performance of NYSEH. During bear cycles, there are no deals available at all.</p>
        </div>
    );

}
