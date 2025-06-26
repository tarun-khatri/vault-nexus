import { ethers } from 'ethers';

export const RPC_FALLBACKS = {
    sepolia: [
      'https://sepolia.infura.io/v3/2dac7bca68234491820c725b40c03cf3',
      'https://sepolia.gateway.tenderly.co',
      'https://ethereum-sepolia.publicnode.com',
      'https://rpc.sepolia.org'
    ],
    holesky: [
      'https://ethereum-holesky.publicnode.com',
      'https://holesky.drpc.org'
    ],
    arbitrum: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia.publicnode.com'
    ],
    base: [
      'https://sepolia.base.org',
      'https://base-sepolia.publicnode.com'
    ],
    bnb: [
      'https://data-seed-prebsc-1-s1.binance.org:8545',
      'https://bsc-testnet.publicnode.com'
    ]
  };

// Helper function to create provider with fallbacks
export async function createProviderWithFallbacks(chain: string): Promise<ethers.JsonRpcProvider> {
  const fallbacks = RPC_FALLBACKS[chain as keyof typeof RPC_FALLBACKS] || RPC_FALLBACKS.sepolia;
  
  for (const rpcUrl of fallbacks) {
    try {
      console.log(`[PROVIDER] Trying RPC: ${rpcUrl}`);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      
      // Test the connection
      const block = await provider.getBlock('latest');
      console.log(`[PROVIDER] RPC connection successful: ${rpcUrl} (block: ${block?.number})`);
      return provider;
    } catch (error) {
      console.log(`[PROVIDER] RPC failed: ${rpcUrl} - ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }
  
  throw new Error(`All RPC endpoints failed for chain: ${chain}`);
}

// Helper function to retry RPC calls with exponential backoff
export async function retryRpcCall<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a rate limit error
      const isRateLimit = error?.code === 'BAD_DATA' && 
                         error?.value?.some((e: any) => e?.code === -32005);
      
      if (isRateLimit && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`[RPC] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // If not rate limit or last attempt, throw
      throw error;
    }
  }
  
  throw lastError;
}