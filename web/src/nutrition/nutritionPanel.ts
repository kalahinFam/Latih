/**
 * Nutrition question panel.
 *
 * Renders the answer *and* the rows it was built from. Showing the citations
 * is not decoration: it is what makes the grounding claim checkable by the
 * person reading the answer, rather than something they have to take on trust.
 */

export interface Citation {
  code: string;
  name: string;
  basisG: number;
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG?: number;
  source: string;
  verified: boolean;
}

export interface NutritionResponse {
  answer: string;
  citations: Citation[];
  verification: { passed: boolean; checked: number; unmatched: string[]; regenerated: boolean };
  dataWarning: string | null;
}

export interface NutritionElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
  submit: HTMLButtonElement;
  answer: HTMLElement;
  warning: HTMLElement;
  citations: HTMLElement;
  verify: HTMLElement;
}

export class NutritionPanel {
  private readonly el: NutritionElements;

  constructor(el: NutritionElements) {
    this.el = el;
    el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.ask();
    });
  }

  private async ask(): Promise<void> {
    const question = this.el.input.value.trim();
    if (question.length === 0) return;

    this.el.submit.disabled = true;
    this.show(this.el.answer, 'Mencari di tabel TKPI…');
    this.hide(this.el.citations, this.el.verify, this.el.warning);

    try {
      const response = await fetch('/api/nutrition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        this.show(this.el.answer, detail?.error ?? 'Asisten gizi sedang tidak bisa dihubungi.');
        return;
      }

      this.render((await response.json()) as NutritionResponse);
    } catch {
      this.show(this.el.answer, 'Gagal menghubungi asisten gizi. Periksa koneksi.');
    } finally {
      this.el.submit.disabled = false;
    }
  }

  private render(data: NutritionResponse): void {
    this.show(this.el.answer, data.answer);

    if (data.dataWarning) this.show(this.el.warning, `⚠️ ${data.dataWarning}`);
    else this.hide(this.el.warning);

    this.renderCitations(data.citations);

    if (data.citations.length === 0) {
      this.hide(this.el.verify);
      return;
    }

    // Stated either way. "Verified" is only meaningful to a reader who has
    // seen the failure case reported too.
    const { passed, checked, unmatched, regenerated } = data.verification;
    const retry = regenerated ? ' (setelah satu kali tulis ulang)' : '';
    this.show(
      this.el.verify,
      passed
        ? `✓ ${checked} angka diperiksa, semuanya cocok dengan tabel di atas${retry}.`
        : `✗ Angka tidak cocok dengan tabel: ${unmatched.join(', ')}. Narasi ditahan${retry}.`,
    );
    this.el.verify.dataset.passed = String(passed);
  }

  private renderCitations(citations: Citation[]): void {
    this.el.citations.innerHTML = '';
    if (citations.length === 0) {
      this.hide(this.el.citations);
      return;
    }

    for (const row of citations) {
      const card = document.createElement('article');
      card.className = 'citation';

      const head = document.createElement('h3');
      head.className = 'citation__name';
      head.textContent = `${row.name} — per ${row.basisG} g`;

      const values = document.createElement('dl');
      values.className = 'citation__values';
      const entries: [string, string][] = [
        ['Energi', `${row.energyKcal} kkal`],
        ['Protein', `${row.proteinG} g`],
        ['Lemak', `${row.fatG} g`],
        ['Karbohidrat', `${row.carbG} g`],
      ];
      if (row.fiberG !== undefined) entries.push(['Serat', `${row.fiberG} g`]);

      for (const [term, value] of entries) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        values.append(dt, dd);
      }

      const source = document.createElement('p');
      source.className = 'citation__source';
      source.textContent = row.verified
        ? `Sumber: ${row.source}`
        : `Sumber: ${row.source} — belum diverifikasi`;

      card.append(head, values, source);
      this.el.citations.append(card);
    }

    this.el.citations.hidden = false;
  }

  private show(el: HTMLElement, text: string): void {
    el.textContent = text;
    el.hidden = false;
  }

  private hide(...els: HTMLElement[]): void {
    for (const el of els) el.hidden = true;
  }
}
