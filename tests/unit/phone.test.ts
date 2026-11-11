import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageScroll, stepDelta } from '../../src/app/phone.ts';

// 02-ui-ux.yaml layout.phone.stepping_area: how far the page jumps to show a span above the bar.
describe('stepDelta', () => {
  const bar = 700;

  it('leaves a span that is already on screen above the bar', () => {
    expect(stepDelta({ top: 0, bottom: 700 }, bar)).toBe(0);
    expect(stepDelta({ top: 300, bottom: 500 }, bar)).toBe(0);
  });

  it('puts a span above the screen 8 px below the top', () => {
    expect(stepDelta({ top: -200, bottom: 100 }, bar)).toBe(-208);
  });

  it('puts a span that ends below the bar 8 px above it, when it fits', () => {
    expect(stepDelta({ top: 600, bottom: 900 }, bar)).toBe(208);
  });

  it('puts a span too tall for the screen at the top', () => {
    expect(stepDelta({ top: 600, bottom: 1400 }, bar)).toBe(592);
  });
});

// 02 layout.phone.stepping_area: which scrolls of the page count as the learner's.
describe('PageScroll', () => {
  const root = {};
  const fakeWindow = Object.assign(new EventTarget(), { scrollY: 0, scrollTo: () => {} });
  const fire = (type: string, target: object = {}) => {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    fakeWindow.dispatchEvent(event);
  };
  let scroll: PageScroll;

  beforeEach(() => {
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', { documentElement: root });
    scroll = new PageScroll();
  });
  afterEach(() => {
    scroll.destroy();
    vi.unstubAllGlobals();
  });

  it('counts a scroll after a touch that moves, not after a tap', () => {
    fire('touchstart');
    fire('scroll');
    expect(scroll.userScrolled).toBe(false);
    fire('touchmove');
    fire('scroll');
    expect(scroll.userScrolled).toBe(true);
  });

  it('counts scrolls while the scrollbar is pressed, until the press is cancelled', () => {
    fire('pointerdown', root);
    fire('scroll');
    expect(scroll.userScrolled).toBe(true);
    scroll.reset();
    fire('pointerdown', root);
    fire('pointercancel');
    fire('scroll');
    expect(scroll.userScrolled).toBe(false);
  });

  it('forgets a press on the scrollbar on an explicit step action', () => {
    fire('pointerdown', root);
    scroll.reset();
    fire('scroll');
    expect(scroll.userScrolled).toBe(false);
  });
});
