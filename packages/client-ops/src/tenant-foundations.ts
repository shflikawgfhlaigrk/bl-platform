import { ApiError } from '@blacklabel/core';
import {
  SERVICE_EXECUTION_FOUNDATIONS,
  type FoundationAdapterReadiness,
  type OwnedSourceConnection,
  type ServiceExecutionFoundation,
  type ServiceFoundationRegistry,
} from './adapters';
import type { ClientOpsService } from './service';

/**
 * Per-tenant execution readiness.
 *
 * The registry answers a process-wide question ("is an adapter wired into this
 * runtime?"). Hosting several paying clients makes that answer dangerous on its
 * own: the three live adapters bind to Black Label's OWN sources, so a client
 * run would read our data. Readiness therefore resolves per tenant — a
 * foundation is ready for a tenant only when that tenant has its own connected
 * connector row naming the adapter's owned source and carrying its own
 * credential ref. A tenant without one gets the honest awaiting-connection
 * state and the runner refuses to invoke.
 */

/** Connector-metadata key that names the owned source a connector row supplies. */
export const OWNED_SOURCE_METADATA_KEY = 'ownedSource';

export type TenantFoundationConnectionStatus =
  /** Adapter wired, ready, and this tenant has its own connector row. */
  | 'ready'
  /** Adapter wired and ready, but this tenant has connected no such source. */
  | 'awaiting_connection'
  /** Adapter is registered but reports it cannot execute yet. */
  | 'adapter_not_ready'
  /** No adapter for this capability exists in this runtime at all. */
  | 'adapter_not_connected';

export interface TenantFoundationState extends ServiceExecutionFoundation {
  /** True ONLY when this tenant can execute this foundation against its own source. */
  connected: boolean;
  /** Process-wide: an adapter for this capability is registered in this runtime. */
  adapterConnected: boolean;
  adapterReadiness: FoundationAdapterReadiness;
  connectionStatus: TenantFoundationConnectionStatus;
  /** This tenant's own connector row for the owned source, or null. */
  ownedSourceConnection: OwnedSourceConnection | null;
}

/** Narrow view of ClientOpsService, so the resolver needs no direct DB handle. */
export interface OwnedSourceLookup {
  listConnectedOwnedSources(tenantId: string): Promise<OwnedSourceConnection[]>;
}

export async function resolveTenantFoundations(
  lookup: OwnedSourceLookup,
  tenantId: string,
  registry: ServiceFoundationRegistry,
): Promise<TenantFoundationState[]> {
  const connections = new Map(
    (await lookup.listConnectedOwnedSources(tenantId))
      .map((connection) => [connection.ownedSourceIdentifier, connection] as const),
  );
  return registry.list().map((state) => {
    const ownedSourceConnection = connections.get(state.ownedSourceIdentifier) ?? null;
    const connectionStatus: TenantFoundationConnectionStatus = !state.connected
      ? 'adapter_not_connected'
      : state.adapterReadiness !== 'ready'
        ? 'adapter_not_ready'
        : ownedSourceConnection === null
          ? 'awaiting_connection'
          : 'ready';
    return {
      ...state,
      adapterConnected: state.connected,
      connected: connectionStatus === 'ready',
      connectionStatus,
      ownedSourceConnection,
    };
  });
}

export async function resolveTenantFoundation(
  lookup: OwnedSourceLookup,
  tenantId: string,
  capabilityId: string,
  registry: ServiceFoundationRegistry,
): Promise<TenantFoundationState | undefined> {
  const all = await resolveTenantFoundations(lookup, tenantId, registry);
  return all.find((state) => state.capabilityId === capabilityId);
}

/**
 * Explicitly declare that ONE connector row supplies this tenant's own instance
 * of its service's owned source, and connect it with the tenant's own
 * credential ref.
 *
 * Call this only for a tenant whose sources you are deliberately provisioning
 * (Black Label's own operator tenant). Never loop it over client tenants — a
 * client connects its own source through the connector API, and auto-creating
 * the row for them is exactly the pooling defect this module exists to prevent.
 */
export async function declareOwnedSourceConnector(
  service: ClientOpsService,
  tenantId: string,
  installationId: string,
  connectorId: string,
  credentialRef: string,
  actor = 'system',
): Promise<OwnedSourceConnection> {
  const installation = await service.getInstallation(tenantId, installationId);
  const foundation = SERVICE_EXECUTION_FOUNDATIONS
    .find((item) => item.serviceId === installation.catalogId);
  if (!foundation) {
    throw ApiError.badRequest(`no execution foundation declared for service '${installation.catalogId}'`);
  }
  const binding = installation.connectors.find((item) => item.connectorId === connectorId);
  if (!binding) throw ApiError.notFound(`connector binding not found: ${connectorId}`);
  await service.updateConnector(tenantId, installationId, binding.id, {
    status: 'connected',
    credentialRef,
    metadata: { ...binding.metadata, [OWNED_SOURCE_METADATA_KEY]: foundation.ownedSourceIdentifier },
  }, actor);
  return {
    ownedSourceIdentifier: foundation.ownedSourceIdentifier,
    bindingId: binding.id,
    installationId,
    connectorId: binding.connectorId,
    credentialRef,
  };
}
