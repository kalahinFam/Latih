/**
 * 7b · Tanya gizi.
 *
 * ## Why an answer here comes with its receipts
 *
 * Every other number in this product is computed from a table the user can
 * check. A chat bubble is the one place a plausible sentence could smuggle in a
 * figure nobody verified, which is exactly what the grounding pipeline exists
 * to prevent — so the rows an answer was built from are rendered under it, and
 * the verifier's finding is shown whether it passed or failed. A "✓ 3 angka
 * cocok" line only means something to a reader who has seen the app report the
 * other case.
 *
 * When verification fails the endpoint withholds the prose and returns the raw
 * rows instead. That is not an error to apologise for; it is the product
 * working, and this screen presents it as such.
 *
 * ## Why there are two ways to ask
 *
 * Typing reaches the whole table — 1.144 foods, and nobody is going to browse
 * a menu that long. It can also miss: retrieval decides whether a question can
 * be answered at all, and a question about something not in the table comes
 * back as a refusal.
 *
 * The offered questions cannot miss. They come from
 * `core/nutritionQuestions.ts`, every entry of which is checked against the
 * shipped TKPI table in `test/nutritionQuestions.test.ts`, so a suggestion that
 * cannot be answered breaks the build rather than the conversation. They are
 * also what makes the first visit start somewhere rather than at a blank box,
 * and after an answer they are built from the rows that answer actually cited.
 *
 * ## Why the conversation outlives the screen
 *
 * Leaving for the menus and coming back is the normal path, and a log that
 * reset on the way would throw away the answer the user left to act on. It
 * lives for the lifetime of the page instead — cleared by a reload, never
 * written to storage, because a question about food is still a question about
 * a person.
 */

import { followUpQuestions, openingQuestions } from '../../core/nutritionQuestions.ts';
import { MAX_QUESTION_CHARS, type ChatContext } from '../../core/nutritionChat.ts';
import {
  NutritionChatError,
  askNutrition,
  type Citation,
  type NutritionAnswer,
} from '../../nutrition/chatClient.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';

/** One exchange as the screen draws it. */
interface Bubble {
  role: 'user' | 'assistant';
  text: string;
  answer?: NutritionAnswer;
  /** Could not reach the endpoint — distinct from an answer that was refused. */
  failed?: boolean;
}

/**
 * Page-lifetime, deliberately not persisted.
 *
 * Module scope rather than screen scope so it survives navigation to the menus
 * and back, which is the reason this screen exists as its own route.
 */
const conversation: Bubble[] = [];
const asked: string[] = [];

/**
 * A question handed over by another screen, asked as soon as this one opens.
 *
 * The Gizi page offers a few of these; tapping one should land the user in a
 * conversation that has already started, not in a box they have to press again.
 * Held in a variable rather than a route parameter so a reload does not re-send
 * the question — and re-spend the tokens — behind their back.
 */
let queued: string | null = null;

export function queueQuestion(question: string): void {
  queued = question;
}

export interface NutritionChatDeps {
  /** Targets computed on the device. Never body measurements. */
  getContext: () => ChatContext;
}

export function createNutritionChatScreen(deps: NutritionChatDeps): Screen {
  const log = required('#chatLog');
  const suggestions = required('#chatSuggestions');
  const form = required<HTMLFormElement>('#chatForm');
  const input = required<HTMLInputElement>('#chatInput');
  const send = required<HTMLButtonElement>('#chatSend');

  let pending = false;
  /** Rotates the opening set between visits, without reading a clock. */
  let visit = 0;

  function citationCard(row: Citation): HTMLElement {
    const values: [string, string][] = [
      ['Energi', `${row.energyKcal} kkal`],
      ['Protein', `${row.proteinG} g`],
      ['Lemak', `${row.fatG} g`],
      ['Karbo', `${row.carbG} g`],
    ];
    if (row.fiberG !== undefined) values.push(['Serat', `${row.fiberG} g`]);

    return el(
      'div',
      { class: 'citation' },
      el('div', { class: 'citation__name', text: `${row.name} — per ${row.basisG} g` }),
      el(
        'div',
        { class: 'citation__values' },
        ...values.map(([term, value]) =>
          el(
            'span',
            { class: 'citation__pair' },
            el('span', { class: 'citation__term', text: term }),
            el('span', { class: 'citation__value', text: value }),
          ),
        ),
      ),
      el('div', {
        class: 'citation__source',
        text: row.verified ? `Sumber: ${row.source}` : `Sumber: ${row.source} — belum diverifikasi`,
      }),
    );
  }

  /** The verifier's finding, stated either way. */
  function verificationLine(answer: NutritionAnswer): HTMLElement | null {
    if (answer.citations.length === 0) return null;

    const { passed, checked, unmatched, regenerated } = answer.verification;
    const retry = regenerated ? ' (setelah satu kali tulis ulang)' : '';

    return el('div', {
      class: 'verify',
      'data-passed': String(passed),
      text: passed
        ? `✓ ${checked} angka dicek ke tabel di atas, semuanya cocok${retry}.`
        : `✗ Ada angka yang tidak cocok dengan tabel: ${unmatched.join(', ')}. Narasinya ditahan${retry}.`,
    });
  }

  function bubbleNode(bubble: Bubble): HTMLElement {
    if (bubble.role === 'user') {
      return el('div', { class: 'chatbubble chatbubble--user', text: bubble.text });
    }

    const node = el(
      'div',
      { class: 'chatbubble chatbubble--bot', 'data-failed': String(Boolean(bubble.failed)) },
      el('p', { class: 'chatbubble__text', text: bubble.text }),
    );

    const answer = bubble.answer;
    if (!answer) return node;

    if (answer.dataWarning) {
      node.append(el('div', { class: 'chatbubble__warning', text: `⚠️ ${answer.dataWarning}` }));
    }
    if (answer.citations.length > 0) {
      node.append(el('div', { class: 'citations' }, ...answer.citations.map(citationCard)));
    }
    const verify = verificationLine(answer);
    if (verify) node.append(verify);

    return node;
  }

  function renderLog(): void {
    log.replaceChildren();

    if (conversation.length === 0) {
      log.append(
        el('p', {
          class: 'chatlog__intro',
          text: 'Jawabannya diambil dari Tabel Komposisi Pangan Indonesia, dan baris yang dipakai ikut ditampilkan supaya bisa kamu cek sendiri. Angka yang tidak ada di tabel tidak akan ditampilkan.',
        }),
      );
    } else {
      log.append(...conversation.map(bubbleNode));
    }

    if (pending) {
      log.append(el('div', { class: 'chatbubble chatbubble--bot', text: 'Sedang berpikir...' }));
    }

    // The newest exchange is what the user came back for.
    //
    // Next frame, not now: the router resets every screen body to the top
    // *after* `enter` runs, so that the rest of the app never drops somebody
    // part-way down a page they have not seen. A conversation is the one place
    // where the bottom is the beginning, so this deliberately lands after it.
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  function renderSuggestions(): void {
    suggestions.replaceChildren();

    if (pending) {
      suggestions.append(el('p', { class: 'chatsuggest__note', text: 'Sedang mencari jawabannya…' }));
      return;
    }

    const context = deps.getContext();
    const last = conversation[conversation.length - 1];
    const questions =
      last && last.role === 'assistant' && !last.failed
        ? followUpQuestions({
            question: asked[asked.length - 1] ?? '',
            citedNames: (last.answer?.citations ?? []).map((citation) => citation.name),
            asked,
            context,
            seed: visit,
          })
        : openingQuestions(context, visit);

    suggestions.append(
      el('p', {
        class: 'chatsuggest__note',
        text: conversation.length === 0 ? 'Pilih pertanyaan:' : 'Lanjutkan:',
      }),
    );

    for (const question of questions) {
      const button = el('button', { class: 'chatsuggest__item', type: 'button', text: question });
      button.addEventListener('click', () => void ask(question));
      suggestions.append(button);
    }
  }

  function render(): void {
    renderLog();
    renderSuggestions();
  }

  /**
   * History sent to the endpoint.
   *
   * Only the prose: a refused answer still shows the rows it retrieved, but
   * feeding "narasinya ditahan" back as context would have the model explain
   * the refusal instead of answering the next question.
   */
  function historyForRequest() {
    return conversation
      .filter((bubble) => !bubble.failed)
      .map((bubble) => ({ role: bubble.role, content: bubble.text }));
  }

  async function ask(raw: string): Promise<void> {
    const question = raw.trim().slice(0, MAX_QUESTION_CHARS);
    if (question.length === 0 || pending) return;

    const history = historyForRequest();
    conversation.push({ role: 'user', text: question });
    asked.push(question);
    pending = true;
    input.value = '';
    send.disabled = true;
    render();

    try {
      const answer = await askNutrition({ question, history, context: deps.getContext() });
      conversation.push({ role: 'assistant', text: answer.answer, answer });
    } catch (error) {
      conversation.push({
        role: 'assistant',
        text: error instanceof NutritionChatError ? error.message : 'Asisten gizi tidak bisa dihubungi.',
        failed: true,
      });
    } finally {
      pending = false;
      send.disabled = false;
      render();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask(input.value);
  });

  return {
    enter() {
      visit += 1;
      render();

      // Sent from the Gizi page: land in a conversation that has already
      // started rather than in a box that still needs pressing. Taken, not
      // read, so returning to this screen later does not ask it again.
      const handover = queued;
      queued = null;
      if (handover) void ask(handover);
    },
  };
}

/** Whether anything has been asked yet, for the entry card on the Gizi screen. */
export function hasConversation(): boolean {
  return conversation.length > 0;
}
