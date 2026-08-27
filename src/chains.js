// The chains the aquarium keeps a tank for. Everything chain-shaped in the app
// reads from here: the tab label, the name written into feed rows and the
// footer, where a data folder lives, how an address is spelled, and which
// explorer a transaction belongs to.
//
// `tx` is deliberately allowed to be null. A wrong explorer link is worse than
// no link at all, so a chain only gets clickable transactions once its explorer
// is confirmed to resolve the hashes Nansen returns for it.

export const CHAINS = [
  {
    id: 'robinhood',
    tab: 'Robinhood',
    name: 'Robinhood Chain',
    // Arbitrum Orbit L2, chain id 4663 — the Blockscout instance in
    // Robinhood's own docs, verified against hashes from tgm/dex-trades.
    tx: (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`,
    explorer: 'Blockscout',
    // EVM: 20 bytes of hex, plus ENS names for the people who own one
    accepts: (v) => /^0x[a-fA-F0-9]{40}$/.test(v) || /\.eth$/i.test(v),
    placeholder: '0x… or vitalik.eth',
  },
  {
    id: 'solana',
    tab: 'Solana',
    name: 'Solana',
    tx: (sig) => `https://solscan.io/tx/${sig}`,
    explorer: 'Solscan',
    // base58, 32–44 characters, and case matters
    accepts: (v) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) || /\.sol$/i.test(v),
    placeholder: 'Solana address or name.sol',
  },
];

export const DEFAULT_CHAIN = CHAINS[0].id;

export const chainById = (id) => CHAINS.find((c) => c.id === id) || CHAINS[0];
