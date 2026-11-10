import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import { Shell } from './app/shell';
import { enableOffline } from './app/offline';
import { loadRegistry, ScenarioError } from './scenarios/registry';

const app = document.querySelector<HTMLElement>('#app');

/** Expands and validates the bundled scenarios once; returns the problems, if any. */
function startupProblems(): string[] {
  try {
    loadRegistry();
    return [];
  } catch (error) {
    return error instanceof ScenarioError ? error.problems : [String(error)];
  }
}

const problems = startupProblems();

/** The app shell, kept while the learner moves between its pages. */
let shell: Shell | undefined;

function renderProblems(root: HTMLElement): void {
  root.className = 'page';
  const title = document.createElement('h1');
  title.textContent = 'AgentScope';
  const message = document.createElement('p');
  message.className = 'error';
  message.textContent = '× Scenario data error: the bundled scenarios failed validation.';
  const items = document.createElement('ul');
  items.className = 'small';
  for (const problem of problems) {
    const item = document.createElement('li');
    item.textContent = problem;
    items.append(item);
  }
  root.replaceChildren(title, message, items);
}

/** A lazily loaded page failed to load: say so instead of leaving the page blank. */
function renderLoadError(root: HTMLElement): void {
  root.className = 'page';
  const title = document.createElement('h1');
  title.textContent = 'AgentScope';
  const message = document.createElement('p');
  message.className = 'error';
  message.textContent =
    '× The design specimen could not be loaded. Reload the page to get the current version.';
  const back = document.createElement('a');
  back.href = '#/';
  back.textContent = 'Back to the app';
  root.replaceChildren(title, message, back);
}

async function render(): Promise<void> {
  if (!app) return;
  if (problems.length) {
    renderProblems(app);
    return;
  }
  if (location.hash === '#/design') {
    shell?.destroy();
    shell = undefined;
    let specimen: typeof import('./design/specimen');
    try {
      specimen = await import('./design/specimen');
    } catch {
      // For example a tab still running a build whose files are gone (01-architecture.yaml
      // offline_mechanics failed_load).
      if (location.hash === '#/design') renderLoadError(app);
      return;
    }
    // The hash may have changed while the specimen was loading.
    if (location.hash === '#/design') specimen.renderSpecimen(app);
    return;
  }
  shell ??= new Shell(app);
  shell.show(location.hash);
}

window.addEventListener('hashchange', () => void render());
void render();
// The development server serves modules that are not files of a build: nothing to precache.
if (import.meta.env.PROD) void enableOffline();
