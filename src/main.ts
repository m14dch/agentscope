import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
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

async function render(): Promise<void> {
  if (!app) return;
  if (problems.length) {
    renderProblems(app);
    return;
  }
  if (location.hash === '#/design') {
    const { renderSpecimen } = await import('./design/specimen');
    // The hash may have changed while the specimen was loading.
    if (location.hash === '#/design') renderSpecimen(app);
    return;
  }
  app.className = 'page';
  app.innerHTML = `
    <h1>AgentScope</h1>
    <p>See how MCP, RAG and agent workflows exchange messages and context, step by step.</p>
    <p class="small muted">In development. Everything here is simulated; nothing leaves your browser.</p>
  `;
}

window.addEventListener('hashchange', () => void render());
void render();
