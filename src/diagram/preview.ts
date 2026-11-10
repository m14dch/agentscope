/**
 * Diagram preview (#/diagram/<scenario>/<step>): one scenario's sequence diagram with a
 * mode switch and step buttons. The app shell (navigation, controls, inspector) replaces
 * it; until then it lets the renderer be seen and tested on its own.
 */
import { Playback } from '../engine/playback.ts';
import { Player } from '../engine/player.ts';
import { loadRegistry, participantLabels } from '../scenarios/registry.ts';
import type { Mode } from './model.ts';
import { DiagramView } from './view.ts';
import '../styles/diagram.css';

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Renders the preview; returns a function that removes its listeners and timers. */
export function renderPreview(
  app: HTMLElement,
  scenarioId: string,
  step: number,
  mode: Mode,
): () => void {
  const scenario = loadRegistry()[scenarioId];
  app.className = 'page';
  if (!scenario) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `× Unknown scenario: ${scenarioId}`;
    app.replaceChildren(p);
    return () => undefined;
  }
  const player = new Player(new Playback(scenario));
  player.jump(step);

  const title = document.createElement('h1');
  title.textContent = scenario.title;
  const status = document.createElement('p');
  status.className = 'small muted';
  status.setAttribute('aria-live', 'polite');
  const modes = document.createElement('div');
  modes.className = 'preview-controls';
  const diagram = document.createElement('div');
  diagram.setAttribute('role', 'region');
  diagram.setAttribute('aria-label', 'Sequence diagram, scrolls in both directions');
  diagram.className = 'preview-diagram';

  const view = new DiagramView(diagram, player, { labels: participantLabels(), mode });
  const modeButtons = (['architecture', 'protocol'] as const).map((m) => {
    const b = button(m === 'architecture' ? 'Architecture' : 'Protocol', () => {
      view.setMode(m);
      update();
    });
    b.dataset['mode'] = m;
    return b;
  });
  const update = (): void => {
    for (const b of modeButtons)
      b.setAttribute('aria-pressed', String(b.dataset['mode'] === view.mode));
    status.textContent = `Step ${player.cursor} of ${player.playback.length}`;
    history.replaceState(null, '', `#/diagram/${scenarioId}/${player.cursor}/${view.mode}`);
  };
  modes.append(
    ...modeButtons,
    button('Previous', () => player.previous()),
    button('Next', () => player.next()),
  );
  player.subscribe(update);
  update();

  const keys = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLButtonElement) return;
    if (e.key === 'ArrowRight') player.next();
    else if (e.key === 'ArrowLeft') player.previous();
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', keys);
  app.replaceChildren(title, status, modes, diagram);
  return () => {
    view.destroy();
    player.dispose();
    window.removeEventListener('keydown', keys);
  };
}
