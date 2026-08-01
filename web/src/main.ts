import './style.css';
import { registerServiceWorker } from './pwa';
import { CameraView } from './ui/cameraView';

/** Fail loudly at startup rather than with `null` deref deep in the loop. */
function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}

const view = new CameraView({
  video: required<HTMLVideoElement>('#video'),
  canvas: required<HTMLCanvasElement>('#canvas'),
  repCount: required('#repCount'),
  phase: required('#phase'),
  cue: required('#cue'),
  statusBanner: required('#statusBanner'),
  perf: required('#perf'),
  startButton: required<HTMLButtonElement>('#start'),
  exerciseSelect: required<HTMLSelectElement>('#exercise'),
  modelSelect: required<HTMLSelectElement>('#model'),
});

registerServiceWorker();

// Exposed for manual inspection during device testing and for capturing the
// latency/FPS table that goes into the paper.
Object.assign(window, { latih: view });
