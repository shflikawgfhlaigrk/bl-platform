import { el } from '../dom.js';
import { button, definitionList, drawerSection, mutateWithFeedback, statusLabel } from '../ui.js';
import { formatDateTime, titleCase } from '../../src/transforms.mjs';

function approvalSummary(policy) {
  if (!policy || typeof policy !== 'object') return 'Not reported';
  return policy.when || policy.mode || policy.name || 'Configured';
}

export function openWorkflowDetail(workflow, context) {
  const installationActive = String(workflow.installationStatus || '').toLowerCase() === 'active';
  const run = button('Run now', {
    icon: 'play',
    variant: 'primary',
    disabled: !workflow.installationId || !workflow.id || !installationActive,
    title: installationActive ? 'Request a workflow run' : 'Complete setup and activate this installation before running workflows',
  });
  const pause = button('Pause', { icon: 'pause', disabled: !workflow.installationId || !workflow.id });
  const retry = button('Retry last run', { icon: 'retry', disabled: !workflow.runId, wide: true });

  run.addEventListener('click', () => {
    mutateWithFeedback(run, () => context.api.runWorkflow(workflow.installationId, workflow.id), context, {
      success: 'Workflow run requested.',
    }).then(() => context.rerender()).catch(() => {});
  });
  pause.addEventListener('click', () => {
    mutateWithFeedback(pause, () => context.api.pauseWorkflow(workflow.installationId, workflow.id), context, {
      success: 'Workflow paused.',
    }).then(() => context.rerender()).catch(() => {});
  });
  retry.addEventListener('click', () => {
    mutateWithFeedback(retry, () => context.api.retryWorkflow(workflow.runId), context, {
      success: 'Workflow retry requested.',
    }).then(() => context.rerender()).catch(() => {});
  });

  const body = [
    drawerSection(null, definitionList([
      ['Service', workflow.service],
      ['Installation', titleCase(workflow.installationStatus)],
      ['State', statusLabel(workflow.status)],
      ['Last run', formatDateTime(workflow.lastRun)],
      ['Run ID', workflow.runId || '—'],
      ['Outcome', workflow.outcome],
      ['Next action', workflow.nextAction],
    ])),
  ];

  if (workflow.progress !== null) {
    body.push(drawerSection('Progress', [
      el('div', { className: 'progress-copy' }, [el('span', { text: 'Latest run' }), el('strong', { text: `${workflow.progress}%` })]),
      el('div', { className: 'progress-track', role: 'progressbar', 'aria-label': 'Latest run progress', 'aria-valuenow': workflow.progress, 'aria-valuemin': '0', 'aria-valuemax': '100' },
        el('div', { className: 'progress-bar', style: { width: `${workflow.progress}%` } })),
    ]));
  }

  body.push(
    drawerSection('Controls', [
      el('div', { className: 'button-row' }, [run, pause]),
      el('div', { className: 'button-row' }, retry),
    ]),
    drawerSection('Approval policy', definitionList([
      ['Policy', approvalSummary(workflow.approvalPolicy)],
      ['Enabled', workflow.enabled ? 'Yes' : 'No'],
    ])),
  );

  if (workflow.requiredConnectors?.length) {
    body.push(drawerSection('Required connectors', el('ul', { className: 'plain-list' }, workflow.requiredConnectors.map((connector) =>
      el('li', {}, [statusLabel(connector.status || 'not reported'), el('span', { text: connector.name || connector.label || connector.id || 'Connector' })])))));
  }

  context.drawer.open({
    context: 'Workflow',
    title: workflow.name,
    body,
  });
}
