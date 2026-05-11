use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, solana_pubkey::Pubkey as SplPubkey,
    state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("ACuGbED6m6PwyeU9x9eFPLGk8tu2snQhUe9mrWq44Y9N");

#[error_code]
pub enum MyError {
    #[msg("Failed to read market status oracle")]
    InvalidOracle,
}

pub const CRANK_ORACLE_PROGRAM_ID: Pubkey = pubkey!("5BkqMghT4iAWbfJyNhJ5oSYBoAfBMD1SvHKtxMxzssRF");

#[program]
pub mod coin_mint {
    use super::*;

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let (market_status_pda, _) =
            Pubkey::find_program_address(&[b"market_status"], &CRANK_ORACLE_PROGRAM_ID);

        let account_metas = vec![
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal {
                    bytes: b"counter".to_vec(),
                }],
                false,
                true,
            )
            .unwrap(),
            ExtraAccountMeta::new_with_pubkey(
                &SplPubkey::from(market_status_pda.to_bytes()),
                false,
                false,
            )
            .unwrap(),
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len()).unwrap() as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        let mint = ctx.accounts.mint.key();

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];

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

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )
        .unwrap();

        Ok(())
    }

    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // No-op: variable fees removed. Counter kept for analytics.
        let counter = &mut ctx.accounts.counter_account;
        counter.counter += 1;
        msg!("NYSEH transfer #{}", counter.counter);
        Ok(())
    }

    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data).unwrap();
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    payer: Signer<'info>,
    /// CHECK: extra account metas
    #[account(mut, seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init_if_needed, seeds = [b"counter"], bump, payer = payer, space = 16)]
    pub counter_account: Account<'info, CounterAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint, token::authority = owner)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: owner
    pub owner: UncheckedAccount<'info>,
    /// CHECK: extra account metas
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"counter"], bump)]
    pub counter_account: Account<'info, CounterAccount>,
    /// CHECK: oracle
    pub oracle: UncheckedAccount<'info>,
}

#[account]
pub struct CounterAccount {
    counter: u64,
}
