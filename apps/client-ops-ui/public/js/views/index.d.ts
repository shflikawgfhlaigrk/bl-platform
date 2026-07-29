export type ClientOpsView = (root: HTMLElement, context: Record<string, unknown>) => Promise<void>;
export const views: Readonly<Record<string, ClientOpsView>>;
export const REGISTERED_VIEW_IDS: readonly string[];
