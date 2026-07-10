/**
 * @blacklabel/api — composition root (placeholder).
 *
 * This app is the ONLY place that:
 *   - creates the shared db (createDb) and runs ALL migrations
 *     ([...coreMigrations, ...each module's migrations])
 *   - constructs the single EventBus
 *   - wires concrete Contracts implementations
 *   - mounts each module's router under /api/<module-key>
 *
 * See /CONVENTIONS.md ("Router factories & composition").
 */
export {};
