import { el } from '../dom.js';
import { button, definitionList, drawerSection, statusLabel } from '../ui.js';
import { formatBytes, formatDateTime, titleCase } from '../../src/transforms.mjs';

function safeWebUri(value) {
  try {
    const url = new URL(value, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function openArtifactDetail(artifact, context) {
  const body = [
    drawerSection(null, definitionList([
      ['Type', titleCase(artifact.kind)],
      ['Status', statusLabel(artifact.status)],
      ['Created', formatDateTime(artifact.createdAt)],
      ['Workflow', artifact.workflow],
      ['Media type', artifact.mediaType || '—'],
      ['Size', formatBytes(artifact.sizeBytes)],
      ['Artifact ID', artifact.id || '—'],
      ['Run ID', artifact.runId || '—'],
    ])),
    artifact.summary ? drawerSection('Receipt summary', el('p', { className: 'detail-summary', text: artifact.summary })) : null,
    artifact.sha256 ? drawerSection('Verification', definitionList([['SHA-256', artifact.sha256], ['State', statusLabel(artifact.status)]])) : null,
  ];
  const href = safeWebUri(artifact.uri);
  const actions = href ? [el('a', { className: 'button is-primary', href, target: '_blank', rel: 'noopener noreferrer' }, [el('span', { text: 'Open artifact' })])] : [];
  context.drawer.open({ context: 'Artifact / receipt', title: artifact.name, body, actions });
}
