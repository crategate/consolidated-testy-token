use anchor_lang::{
    prelude::*,
    system_program::{create_account, CreateAccount},
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface, metadata_pointer},
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList, solana_pubkey::Pubkey as SplPubkey
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("DiBpZD4ynNg19gMHL67hH9b8JGhRfkNHeHgmcVQB6EZd");

#[error_code]
pub enum MyError {
    #[msg("The amount is too big")]
    AmountTooBig,

    #[msg("Failed to read SPY Oracle status! NYSEH can't transfer without this market data")]
    InvalidOracle,
    #[msg("Borrowing and translating the spy data failed!!")]
    InvalidBorrowSpy,
}

#[program]
pub mod coin_mint {
    use super::*;
        // this is the PDA address which should have the MarketStatus account type
      pub const DEVNET_ORACLE: anchor_lang::prelude::Pubkey = pubkey!("Fk1p2HvsEFCVuh7sHFY7gCcBhhfiyBDeB4WzqZw4xACA");//
    //
      pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
              // The `addExtraAccountsToInstruction` JS helper function resolving incorrectly
        let account_metas = vec![
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal {
                    bytes: "counter".as_bytes().to_vec(),
                }],
                false, // is_signer
                true,  // is_writable
            ).unwrap(),
            ExtraAccountMeta::new_with_pubkey(
                // devnet 
                &SplPubkey::from(DEVNET_ORACLE.to_bytes()),
                false,
                false,
            ).unwrap()
        ];

        // calculate account size
        let account_size = ExtraAccountMetaList::size_of(account_metas.len()).unwrap() as u64;
        // calculate minimum required lamports
        let lamports = Rent::get()?.minimum_balance(account_size as usize);

        let mint = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            &mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];

        // create ExtraAccountMetaList account
        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        // initialize ExtraAccountMetaList account with extra accounts
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        ).unwrap();

        Ok(())
    }

    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let fee;


        let oracle_data = ctx.accounts.oracle.try_borrow_data().map_err(|_| error!(MyError::InvalidOracle))?;

        let market_status = MarketStatus::try_deserialize(&mut &oracle_data[..]).map_err(|_| error!(MyError::InvalidOracle))?;


        match market_status.current_state {
            0 => fee = 0.0,
            1 => fee = 0.01,
            2 => fee = 0.025,
            3 => fee = 0.08,
            _ => fee = 0.0,
        }

        let counter = &mut ctx.accounts.counter_account;
        counter.counter += 1;
       // ctx.accounts.counter_account.counter.checked_add(1).unwrap();

        msg!("The NYSEH token has transfered {} times, current fee: {} percent", counter.counter, fee * 100.0);

        Ok(())
    }

    // fallback instruction handler as workaround to anchor instruction discriminator check
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data).unwrap();

        // match instruction discriminator to transfer hook interface execute instruction  
        // token2022 program CPIs this instruction on token transfer
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();

                // invoke custom transfer hook instruction on our program
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => return Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList Account, must use these seeds
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()], 
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        seeds = [b"counter"], 
        bump,
        payer = payer,
        space = 16
    )]
    pub counter_account: Account<'info, CounterAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// Order of accounts matters for this struct.
// The first 4 accounts are the accounts required for token transfer (source, mint, destination, owner)
// Remaining accounts are the extra accounts required from the ExtraAccountMetaList account
// These accounts are provided via CPI to this program from the token2022 program
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(
        token::mint = mint, 
        token::authority = owner,
    )]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
    )]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source token account owner, can be SystemAccount or PDA owned by another program
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList Account,
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()], 
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"counter"],
        bump
    )]
    pub counter_account: Account<'info, CounterAccount>,
    /// CHECK: PDA account which updates from the crank script
    pub oracle: UncheckedAccount<'info>
}
#[account]
pub struct MarketStatus {
    pub current_state: u8,
    pub last_updated_timestamp: i64,
}

#[account]
pub struct CounterAccount {
    counter: u64,
}
