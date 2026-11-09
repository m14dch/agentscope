import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';

const app = document.querySelector<HTMLElement>('#app');

async function render(): Promise<void> {
  if (!app) return;
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
