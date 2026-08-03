import './style.css';
import { registerServiceWorker } from './pwa.ts';
import { CameraView } from './ui/cameraView.ts';
import { NutritionPanel } from './nutrition/nutritionPanel.ts';

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
  guide: required<HTMLDetailsElement>('#guide'),
  guideList: required('#guideList'),
  guideNote: required('#guideNote'),
  finishSetButton: required<HTMLButtonElement>('#finishSet'),
  coachPanel: required('#coachPanel'),
  coachNarration: required('#coachNarration'),
  coachFocus: required('#coachFocus'),
  coachMeta: required('#coachMeta'),
});

new NutritionPanel({
  form: required<HTMLFormElement>('#nutritionForm'),
  input: required<HTMLInputElement>('#nutritionQuestion'),
  submit: required<HTMLButtonElement>('#nutritionForm button[type="submit"]'),
  answer: required('#nutritionAnswer'),
  warning: required('#nutritionWarning'),
  citations: required('#nutritionCitations'),
  verify: required('#nutritionVerify'),
});

registerServiceWorker();

// Exposed for manual inspection during device testing and for capturing the
// latency/FPS table that goes into the paper.
Object.assign(window, { latih: view });
