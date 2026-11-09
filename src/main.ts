import './style.css';

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  app.innerHTML = `
    <h1>AgentScope</h1>
    <p>See how MCP, RAG and agent workflows exchange messages and context, step by step.</p>
    <p class="note">In development. Everything here is simulated; nothing leaves your browser.</p>
  `;
}
