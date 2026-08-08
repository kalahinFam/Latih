import './annotate.css';
import { extractFromVideo, type ExtractionResult } from './extractor.ts';
import {
  downloadSession,
  toLabelledRep,
  validateSession,
  SESSION_FORMAT_VERSION,
  type AnnotatedSession,
  type LabelledRep,
} from './session.ts';
import type { RuleErrorCode } from '../core/rules.ts';
import type { ExerciseKind } from '../core/types.ts';
import type { ModelVariant } from '../pose/poseSource.ts';

/**
 * The label vocabulary the annotator picks from.
 *
 * Deliberately the same five codes the rules emit, so the two are directly
 * comparable in the ablation. `suggested` is shown next to each rep as a hint,
 * but never pre-ticked — a pre-ticked suggestion is a suggestion the annotator
 * accepts by default, and the dataset would quietly become a copy of the rules.
 */
const LABELS: { code: RuleErrorCode; text: string; forExercise: ExerciseKind[] }[] = [
  { code: 'shallow_depth', text: 'Kedalaman kurang', forExercise: ['pushup', 'squat'] },
  { code: 'partial_lockout', text: 'Tidak lurus penuh', forExercise: ['pushup'] },
  { code: 'hip_sag', text: 'Pinggul turun', forExercise: ['pushup'] },
  { code: 'hip_pike', text: 'Pinggul naik', forExercise: ['pushup'] },
  { code: 'excessive_trunk_lean', text: 'Badan terlalu membungkuk', forExercise: ['squat'] },
];

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

const els = {
  file: required<HTMLInputElement>('#videoFile'),
  exercise: required<HTMLSelectElement>('#exercise'),
  subjectId: required<HTMLInputElement>('#subjectId'),
  model: required<HTMLSelectElement>('#model'),
  extract: required<HTMLButtonElement>('#extract'),
  progress: required<HTMLParagraphElement>('#progress'),
  reviewPanel: required<HTMLElement>('#reviewPanel'),
  stats: required<HTMLElement>('#stats'),
  expectedReps: required<HTMLInputElement>('#expectedReps'),
  reps: required<HTMLElement>('#reps'),
  exportPanel: required<HTMLElement>('#exportPanel'),
  problems: required<HTMLUListElement>('#problems'),
  export: required<HTMLButtonElement>('#export'),
};

let extraction: ExtractionResult | null = null;
let labelled: LabelledRep[] = [];

els.file.addEventListener('change', () => {
  els.extract.disabled = !els.file.files?.length;
});

els.extract.addEventListener('click', () => void runExtraction());
els.expectedReps.addEventListener('input', renderProblems);
els.subjectId.addEventListener('input', renderProblems);
els.export.addEventListener('click', doExport);

async function runExtraction(): Promise<void> {
  const file = els.file.files?.[0];
  if (!file) return;

  els.extract.disabled = true;
  els.progress.hidden = false;
  els.progress.textContent = 'Memuat model…';

  try {
    extraction = await extractFromVideo({
      file,
      exercise: els.exercise.value as ExerciseKind,
      model: els.model.value as ModelVariant,
      onProgress: (p) => {
        const pct = p.durationMs > 0 ? Math.min(100, (p.currentMs / p.durationMs) * 100) : 0;
        els.progress.textContent =
          `${pct.toFixed(0)}% · ${p.processedFrames} frame · ${p.repsSoFar} repetisi terdeteksi`;
      },
    });

    labelled = extraction.reps.map((r) => toLabelledRep(r.event, r.suggested));
    // Seed with the segmented count, but the annotator is expected to correct
    // it from the video — the difference is the rep-accuracy measurement.
    els.expectedReps.value = String(labelled.length);

    els.progress.textContent = `Selesai — ${extraction.frames.length} frame tersimpan.`;
    renderStats();
    renderReps();
    els.reviewPanel.hidden = false;
    els.exportPanel.hidden = false;
    renderProblems();
  } catch (error) {
    els.progress.textContent =
      error instanceof Error ? `Gagal: ${error.message}` : 'Gagal mengekstrak video.';
  } finally {
    els.extract.disabled = false;
  }
}

function renderStats(): void {
  if (!extraction) return;
  const rate = (extraction.detectionRate * 100).toFixed(0);
  const seconds = (extraction.durationMs / 1000).toFixed(1);
  els.stats.innerHTML = '';

  const items: [string, string][] = [
    ['Durasi', `${seconds} s`],
    ['Frame diproses', String(extraction.frameCount)],
    ['Pose terdeteksi', `${rate}%`],
    ['Repetisi tersegmentasi', String(labelled.length)],
  ];

  for (const [label, value] of items) {
    const box = document.createElement('div');
    box.className = 'stat';
    const v = document.createElement('span');
    v.className = 'stat__value';
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'stat__label';
    l.textContent = label;
    box.append(v, l);
    els.stats.append(box);
  }
}

function renderReps(): void {
  const exercise = els.exercise.value as ExerciseKind;
  const applicable = LABELS.filter((l) => l.forExercise.includes(exercise));
  els.reps.innerHTML = '';

  labelled.forEach((rep, i) => {
    const card = document.createElement('article');
    card.className = 'rep';
    if (rep.rejected) card.classList.add('rep--rejected');

    const head = document.createElement('header');
    head.className = 'rep__head';

    const title = document.createElement('span');
    title.className = 'rep__index';
    title.textContent = `Rep ${rep.index}`;

    const meta = document.createElement('span');
    meta.className = 'rep__meta';
    meta.textContent =
      `${(rep.startMs / 1000).toFixed(1)}–${(rep.endMs / 1000).toFixed(1)} s · ` +
      `dalam ${rep.minAngle.toFixed(0)}° · atas ${rep.maxAngle.toFixed(0)}° · ` +
      `turun ${rep.eccentricMs} ms / naik ${rep.concentricMs} ms`;

    head.append(title, meta);

    if (rep.suggested.length > 0) {
      const hint = document.createElement('span');
      hint.className = 'rep__suggested';
      hint.textContent = `rule menduga: ${rep.suggested.join(', ')}`;
      head.append(hint);
    }

    const choices = document.createElement('div');
    choices.className = 'rep__labels';

    for (const label of applicable) {
      const id = `rep${i}-${label.code}`;
      const wrap = document.createElement('label');
      wrap.className = 'choice';
      wrap.htmlFor = id;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = rep.labels.includes(label.code);
      box.addEventListener('change', () => {
        rep.labels = box.checked
          ? [...rep.labels, label.code]
          : rep.labels.filter((c) => c !== label.code);
        renderProblems();
      });

      const text = document.createElement('span');
      text.textContent = label.text;
      wrap.append(box, text);
      choices.append(wrap);
    }

    const reject = document.createElement('label');
    reject.className = 'choice choice--reject';
    const rejectBox = document.createElement('input');
    rejectBox.type = 'checkbox';
    rejectBox.checked = rep.rejected;
    rejectBox.addEventListener('change', () => {
      rep.rejected = rejectBox.checked;
      card.classList.toggle('rep--rejected', rep.rejected);
      renderProblems();
    });
    const rejectText = document.createElement('span');
    rejectText.textContent = 'Buang (salah segmentasi / terpotong)';
    reject.append(rejectBox, rejectText);
    choices.append(reject);

    card.append(head, choices);
    els.reps.append(card);
  });
}

function buildSession(): AnnotatedSession | null {
  if (!extraction) return null;
  return {
    formatVersion: SESSION_FORMAT_VERSION,
    source: els.file.files?.[0]?.name ?? 'unknown',
    subjectId: els.subjectId.value.trim(),
    exercise: extraction.exercise,
    model: extraction.model,
    annotatedAt: new Date().toISOString(),
    durationMs: extraction.durationMs,
    frameCount: extraction.frameCount,
    detectionRate: Number(extraction.detectionRate.toFixed(3)),
    expectedReps: Number(els.expectedReps.value) || 0,
    frames: extraction.frames,
    reps: labelled,
  };
}

function renderProblems(): void {
  const session = buildSession();
  if (!session) return;

  const problems = validateSession(session);
  els.problems.innerHTML = '';
  for (const problem of problems) {
    const li = document.createElement('li');
    li.textContent = problem;
    els.problems.append(li);
  }
  els.export.disabled = problems.length > 0;
}

function doExport(): void {
  const session = buildSession();
  if (!session) return;
  if (validateSession(session).length > 0) return;
  downloadSession(session);
}
