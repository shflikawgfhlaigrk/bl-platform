import { el } from '../dom.js';
import { icon } from '../icons.js';
import { button, definitionList, drawerSection, emptyState, errorState, loadingState, mutateWithFeedback, statusLabel, viewHeader } from '../ui.js';
import { normalizeStatus, transformSetupPayload } from '../../src/transforms.mjs';

function completion(steps) {
  const completed = steps.filter((step) => normalizeStatus(step.status) === 'completed').length;
  return { completed, total: steps.length, percent: steps.length ? Math.round((completed / steps.length) * 100) : 0 };
}

function completeStep(installation, step, control, context) {
  mutateWithFeedback(control, () => context.api.completeSetupStep(installation.id, step.id), context, {
    success: `${step.title} completed.`,
  }).then(() => context.rerender()).catch(() => {});
}

function openStep(installation, step, context) {
  const done = normalizeStatus(step.status) === 'completed';
  const complete = button('Mark complete', { icon: 'check', variant: 'primary', disabled: done || !step.id });
  complete.addEventListener('click', () => completeStep(installation, step, complete, context));
  context.drawer.open({
    context: 'Setup step',
    title: step.title,
    body: [
      drawerSection(null, definitionList([
        ['Service', installation.name],
        ['State', statusLabel(step.status)],
        ['Required', step.required ? 'Yes' : 'No'],
        ['Position', step.position],
      ])),
      drawerSection('What to complete', el('p', { className: 'detail-summary', text: step.description || 'No additional instructions were returned.' })),
      step.evidence ? drawerSection('Current evidence', el('pre', { className: 'detail-summary', text: JSON.stringify(step.evidence, null, 2) })) : null,
    ],
    actions: [complete],
  });
}

function setupList(installation, context) {
  return el('ol', { className: 'setup-steps' }, installation.steps.map((step, index) => {
    const done = normalizeStatus(step.status) === 'completed';
    const action = button(done ? 'Complete' : 'Mark complete', { icon: done ? 'check' : null, disabled: done || !step.id });
    action.classList.add('step-action');
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      completeStep(installation, step, action, context);
    });
    return el('li', { className: `setup-step${done ? ' is-completed' : ''}` }, [
      el('span', { className: 'step-number', text: step.position || index + 1 }),
      el('button', { className: 'row-button step-copy', type: 'button', onclick: () => openStep(installation, step, context) }, [
        el('strong', { text: step.title }),
        el('span', { text: step.description || (step.required ? 'Required setup step' : 'Optional setup step') }),
      ]),
      el('div', {}, [statusLabel(step.status), action]),
    ]);
  }));
}

function renderSetup(installation, installations, select, context) {
  const progress = completion(installation.steps);
  const selection = el('select', { className: 'select', 'aria-label': 'Choose installation' }, installations.map((item) => el('option', {
    value: item.id,
    text: item.name,
    selected: item.id === installation.id,
  })));
  selection.addEventListener('change', () => select(installations.find((item) => item.id === selection.value) || installation));

  return el('div', {}, [
    el('section', { className: 'panel' }, [
      el('header', { className: 'panel-header' }, [
        el('div', {}, [el('h2', { text: installation.name }), el('span', { className: 'view-description', text: `${progress.completed} of ${progress.total} steps complete` })]),
        el('div', { className: 'filter-row' }, [selection, statusLabel(installation.status)]),
      ]),
      el('div', { className: 'panel-body' }, [
        el('div', { className: 'progress-copy' }, [el('span', { text: 'Setup progress' }), el('strong', { text: `${progress.percent}%` })]),
        el('div', { className: 'progress-track', role: 'progressbar', 'aria-label': 'Client setup progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': progress.percent },
          el('div', { className: 'progress-bar', style: { width: `${progress.percent}%` } })),
      ]),
      setupList(installation, context),
    ]),
    el('section', { className: 'card-grid pack-section' }, [
      el('article', { className: 'panel metric-card' }, [el('span', { className: 'metric-label', text: 'Required connectors pending' }), el('div', { className: 'metric-value', text: installation.readiness.pendingRequiredConnectorIds?.length ?? 0 }), el('div', { className: 'metric-note', text: 'From the live installation readiness check' })]),
      el('article', { className: 'panel metric-card' }, [el('span', { className: 'metric-label', text: 'Required steps incomplete' }), el('div', { className: 'metric-value', text: installation.readiness.incompleteRequiredStepIds?.length ?? 0 }), el('div', { className: 'metric-note', text: 'Must be completed before activation' })]),
      el('article', { className: 'panel metric-card' }, [el('span', { className: 'metric-label', text: 'Blocked workflows' }), el('div', { className: 'metric-value', text: installation.readiness.blockedWorkflowIds?.length ?? 0 }), el('div', { className: 'metric-note', text: installation.readiness.ready ? 'Installation is ready' : 'Readiness checks still open' })]),
    ]),
  ]);
}

export async function renderClientSetup(root, context) {
  root.append(viewHeader('Client setup', 'Complete the installation checklist using live onboarding state.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading installations and onboarding steps…'));
  try {
    const response = await context.api.setup({ signal: context.signal });
    const installations = transformSetupPayload(response);
    context.setConnection(true);
    content.replaceChildren();
    if (!installations.length) {
      content.append(emptyState('No setup in progress', 'Install a reusable service or vertical pack to start a client onboarding checklist.', {
        icon: 'setup',
        action: button('Browse services', { variant: 'primary', onClick: () => context.navigate('services') }),
      }));
      return;
    }
    let selected = installations[0];
    const shell = el('div');
    const draw = () => shell.replaceChildren(renderSetup(selected, installations, (installation) => { selected = installation; draw(); }, context));
    draw();
    content.append(shell);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
