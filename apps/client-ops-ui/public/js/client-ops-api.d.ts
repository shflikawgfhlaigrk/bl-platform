type SignalOptions = { signal?: AbortSignal };
type PortfolioTargetOptions = {
  targetKind?: 'product' | 'feature';
  targetKey?: string;
};

export interface ClientOpsApi {
  [key: string]: (...args: any[]) => Promise<any>;
  portfolio(options?: SignalOptions): Promise<unknown>;
  portfolioProduct(productKey: string, options?: SignalOptions): Promise<unknown>;
  portfolioTestRuns(productKey: string, options?: SignalOptions): Promise<unknown>;
  portfolioPackages(productKey: string, options?: SignalOptions): Promise<unknown>;
  runPortfolioTest(productKey: string, suiteKey: string, options?: PortfolioTargetOptions & { sourceRevision?: string }): Promise<unknown>;
  buildPortfolioPackage(productKey: string, version: string, options?: PortfolioTargetOptions): Promise<unknown>;
}

export const clientOpsApi: Readonly<ClientOpsApi>;
