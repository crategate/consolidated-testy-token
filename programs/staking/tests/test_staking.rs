use anchor_lang::{Discriminator, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{signature::Keypair, signer::Signer, transaction::Transaction};

#[test]
fn test_staking_with_mock_market_status() {
    let mut svm = LiteSVM::new();

    // 1. Generate accounts
    let authority = Keypair::new();
    let owner = Keypair::new();
    let crank_program = Keypair::new(); // dummy crank program

    svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();

    // 2. Create the MarketStatus PDA manually with raw bytes
    let (market_pda, _) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"market_status"],
        &crank_program.pubkey(),
    );

    let mut market_data = vec![0u8; 32];
    // 8-byte discriminator for MarketStatus (you'll need the actual bytes)
    market_data[0..8].copy_from_slice(&MarketStatus::discriminator());
    market_data[8] = 2; // state = Closed
    market_data[9..17].copy_from_slice(&0i64.to_le_bytes()); // timestamp
    market_data[17..25].copy_from_slice(&5u64.to_le_bytes()); // trading_day_index

    svm.set_account(
        market_pda,
        solana_sdk::account::Account {
            lamports: 1_000_000,
            data: market_data,
            owner: crank_program.pubkey(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // 3. Now deploy your staking program and test unstake with state=2
    // ... initialize pool, stake, then unstake and assert penalty ...
}
