import type { StatusState } from './statusText';
import { statusText } from './statusText';

export class StatusBar {
  private state: StatusState = { kind: 'disconnected' };
  private readonly element: HTMLElement;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(element: HTMLElement, onClick: () => void) {
    this.element = element;
    this.element.addClass('mod-clickable');
    this.element.addEventListener('click', onClick);
    this.render();

    this.intervalTimer = setInterval(() => {
      if (this.state.kind === 'idle') {
        this.render();
      }
    }, 30_000);
  }

  setState(state: StatusState): void {
    this.state = state;
    this.render();
  }

  getState(): StatusState {
    return this.state;
  }

  destroy(): void {
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private render(): void {
    this.element.setText(statusText(this.state, Date.now()));
  }
}
