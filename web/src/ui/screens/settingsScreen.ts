/**
 * Pengaturan — body profile, schedule, reminders.
 *
 * Not in the design document, which has no settings screen. But the body
 * profile drives the energy target, the schedule drives the weekly plan, and
 * reminders need a switch; leaving them without a home would mean features that
 * exist and cannot be reached.
 *
 * Everything here stays on the device. The profile in particular is the only
 * genuinely personal data the product touches, and the calorie target derived
 * from it is computed locally too — so the numbers reach the meal endpoint
 * without the measurements that produced them ever leaving the phone.
 */

import { ACTIVITY_LABELS, INPUT_LIMITS, type BodyProfile } from '../../core/energy.ts';
import {
  MAX_DAYS_PER_WEEK,
  MIN_DAYS_PER_WEEK,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  buildWeeklyPlan,
  explainPlan,
  normaliseWeekdays,
  planWeekdays,
} from '../../core/plan.ts';
import { backupFilename, exportBackup, importBackup } from '../../session/backup.ts';
import { TrainingHistory } from '../../session/history.ts';
import {
  loadPreferences,
  loadProfile,
  savePreferences,
  saveProfile,
} from '../../session/profile.ts';
import { currentSplit } from '../../session/planner.ts';
import { describeSession, estimatedMinutes } from '../../core/split.ts';
import {
  ReminderError,
  disableReminders,
  enableReminders,
  fetchServerConfig,
  reminderSupport,
  remindersActive,
} from '../../session/reminders.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';

export interface SettingsDeps {
  history: TrainingHistory;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label', text: label }),
    control,
  );
}

function select(
  id: string,
  options: [value: string, label: string][],
  value: string,
): HTMLSelectElement {
  const node = el('select', { class: 'field__input', id });
  for (const [v, label] of options) {
    node.append(el('option', { value: v, text: label, selected: v === value }));
  }
  node.value = value;
  return node;
}

function numberInput(id: string, value: number | '', min: number, max: number, step = 1) {
  return el('input', {
    class: 'field__input',
    id,
    type: 'number',
    inputmode: 'decimal',
    min,
    max,
    step,
    value: value === '' ? '' : String(value),
  });
}

export function createSettingsScreen(deps: SettingsDeps): Screen {
  const body = required('#settingsBody');

  function render(): void {
    const prefs = loadPreferences();
    const profile = loadProfile();
    body.replaceChildren();

    /* ------------------------------------------------------------- schedule */

    // Which days, not how many: the count is what the picked days add up to.
    // Offering both would let the two disagree, and then one of them is wrong.
    let chosenDays = planWeekdays(prefs);
    const dayChips = el('div', { class: 'chipwrap' });
    const dayNote = el('p', { class: 'card__foot' });

    const daysValid = () =>
      chosenDays.length >= MIN_DAYS_PER_WEEK && chosenDays.length <= MAX_DAYS_PER_WEEK;

    function renderDays(): void {
      dayChips.replaceChildren(
        ...WEEKDAY_SHORT.map((label, weekday) => {
          const chosen = chosenDays.includes(weekday);
          const chip = el('button', {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(chosen),
            'aria-label': `Latihan hari ${WEEKDAY_LABELS[weekday]}`,
            text: label,
          });
          chip.addEventListener('click', () => {
            chosenDays = normaliseWeekdays(
              chosen ? chosenDays.filter((d) => d !== weekday) : [...chosenDays, weekday],
            );
            renderDays();
          });
          return chip;
        }),
      );

      dayNote.textContent =
        chosenDays.length < MIN_DAYS_PER_WEEK
          ? `Pilih minimal ${MIN_DAYS_PER_WEEK} hari.`
          : chosenDays.length > MAX_DAYS_PER_WEEK
            ? 'Sisakan minimal satu hari istirahat.'
            : `${chosenDays.length}× seminggu — ${chosenDays
                .map((day) => WEEKDAY_LABELS[day])
                .join(', ')}`;
      saveSchedule.disabled = !daysValid();
    }

    const time = el('input', {
      class: 'field__input',
      id: 'setTime',
      type: 'time',
      value: prefs.timeOfDay,
    });
    const sets = select(
      'setSets',
      [2, 3, 4, 5].map((n) => [String(n), `${n} set`] as [string, string]),
      String(prefs.setsPerExercise),
    );

    const planSummary = el('p', { class: 'card__foot' });
    // The split the saved schedule produces. Shown here because this is the
    // screen that changes it: pick a fourth day and the week stops being
    // full-body, and finding that out on the home screen tomorrow would be a
    // surprise rather than a decision.
    const splitList = el('div', { class: 'splitlist' });

    const refreshPlanSummary = () => {
      const saved = loadPreferences();
      planSummary.textContent = explainPlan(buildWeeklyPlan(saved, deps.history.all()));

      const split = currentSplit();
      splitList.replaceChildren(
        ...split.sessions.map((session) =>
          el(
            'div',
            { class: 'splitlist__row' },
            el('span', { class: 'splitlist__day', text: WEEKDAY_SHORT[session.weekday] }),
            el(
              'span',
              { class: 'splitlist__body' },
              el('span', { class: 'splitlist__focus', text: session.label }),
              el('span', { class: 'splitlist__moves', text: describeSession(session) }),
            ),
            el('span', { class: 'splitlist__time', text: `±${estimatedMinutes(split, session)}′` }),
          ),
        ),
      );
    };
    refreshPlanSummary();

    const saveSchedule = el('button', {
      class: 'btn btn--outline',
      type: 'button',
      text: 'Simpan jadwal',
    });
    renderDays();

    saveSchedule.addEventListener('click', () => {
      if (!daysValid()) return;
      savePreferences({
        ...prefs,
        daysPerWeek: chosenDays.length,
        trainingDays: chosenDays,
        timeOfDay: time.value || prefs.timeOfDay,
        setsPerExercise: Number(sets.value),
      });
      refreshPlanSummary();
      saveSchedule.textContent = 'Tersimpan';
      window.setTimeout(() => (saveSchedule.textContent = 'Simpan jadwal'), 1400);
    });

    body.append(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card__eyebrow', text: 'JADWAL LATIHAN' }),
        el('div', { class: 'fieldlabel', text: 'HARI LATIHAN' }),
        dayChips,
        dayNote,
        el(
          'div',
          { class: 'fields' },
          field('Jam latihan', time),
          field('Set per gerakan', sets),
        ),
        saveSchedule,
        planSummary,
        el('div', { class: 'fieldlabel', text: 'ISI TIAP SESI' }),
        splitList,
      ),
    );

    /* -------------------------------------------------------------- profile */

    const weight = numberInput('setWeight', profile?.weightKg ?? '', INPUT_LIMITS.weightKg.min, INPUT_LIMITS.weightKg.max, 0.5);
    const height = numberInput('setHeight', profile?.heightCm ?? '', INPUT_LIMITS.heightCm.min, INPUT_LIMITS.heightCm.max);
    const age = numberInput('setAge', profile?.ageYears ?? '', INPUT_LIMITS.ageYears.min, INPUT_LIMITS.ageYears.max);
    const sex = select(
      'setSex',
      [
        ['male', 'Laki-laki'],
        ['female', 'Perempuan'],
      ],
      profile?.sex ?? 'male',
    );
    const activity = select(
      'setActivity',
      Object.entries(ACTIVITY_LABELS) as [string, string][],
      profile?.activity ?? 'light',
    );
    const goal = select(
      'setGoal',
      [
        ['lose', 'Turun berat'],
        ['maintain', 'Jaga berat'],
        ['gain', 'Naik berat'],
      ],
      profile?.goal ?? 'maintain',
    );

    const profileError = el('p', { class: 'card__foot', style: 'color:var(--danger)' });
    const saveBody = el('button', {
      class: 'btn btn--outline',
      type: 'button',
      text: 'Simpan data tubuh',
    });

    saveBody.addEventListener('click', () => {
      const next: BodyProfile = {
        weightKg: Number(weight.value),
        heightCm: Number(height.value),
        ageYears: Number(age.value),
        sex: sex.value as BodyProfile['sex'],
        activity: activity.value as BodyProfile['activity'],
        goal: goal.value as BodyProfile['goal'],
      };

      // Validated on save as well as on read: these values feed a published
      // equation, and one outside its range would produce a confident number
      // it was never validated for.
      const invalid =
        !Number.isFinite(next.weightKg) ||
        !Number.isFinite(next.heightCm) ||
        !Number.isFinite(next.ageYears);
      if (invalid) {
        profileError.textContent = 'Lengkapi berat, tinggi, dan usia.';
        return;
      }

      profileError.textContent = '';
      saveProfile(next);
      saveBody.textContent = 'Tersimpan';
      window.setTimeout(() => (saveBody.textContent = 'Simpan data tubuh'), 1400);
    });

    body.append(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card__eyebrow', text: 'DATA TUBUH' }),
        el('p', {
          class: 'sheet__note',
          text: 'Dipakai untuk menghitung kebutuhan energi dengan persamaan Mifflin-St Jeor, di perangkat ini. Tidak pernah dikirim ke mana pun.',
        }),
        el(
          'div',
          { class: 'fields' },
          field('Berat (kg)', weight),
          field('Tinggi (cm)', height),
          field('Usia', age),
          field('Jenis kelamin', sex),
          field('Aktivitas harian', activity),
          field('Tujuan', goal),
        ),
        saveBody,
        profileError,
      ),
    );

    /* ------------------------------------------------------------ reminders */

    const reminderStatus = el('p', { class: 'card__foot' });
    const reminderToggle = el('button', {
      class: 'btn btn--outline',
      type: 'button',
      text: 'Aktifkan pengingat',
    });
    const reminderCard = el(
      'section',
      { class: 'card' },
      el('div', { class: 'card__eyebrow', text: 'PENGINGAT' }),
      reminderToggle,
      reminderStatus,
    );
    body.append(reminderCard);

    void (async () => {
      const support = reminderSupport();
      if (!support.supported) {
        reminderToggle.hidden = true;
        reminderStatus.textContent = support.reason;
        return;
      }

      try {
        const config = await fetchServerConfig();
        if (!config.configured) {
          reminderToggle.hidden = true;
          reminderStatus.textContent =
            'Pengingat belum dikonfigurasi di server. Jalankan npm run gen:vapid lalu isi VAPID_PUBLIC_KEY dan VAPID_PRIVATE_KEY.';
          return;
        }

        let on = await remindersActive();
        const paint = () => {
          reminderToggle.textContent = on ? 'Matikan pengingat' : 'Aktifkan pengingat';
          reminderStatus.textContent = on
            ? `Aktif — pukul ${loadPreferences().timeOfDay} pada hari latihan.`
            : 'Belum aktif.';
          if (config.storage === 'memory') {
            reminderStatus.textContent +=
              ' Server belum punya penyimpanan tetap, jadi pengingat hilang saat di-deploy ulang.';
          }
        };
        paint();

        reminderToggle.addEventListener('click', () => {
          void (async () => {
            reminderToggle.disabled = true;
            try {
              if (on) await disableReminders();
              else await enableReminders(loadPreferences());
              on = !on;
              paint();
            } catch (error) {
              reminderStatus.textContent =
                error instanceof ReminderError ? error.message : 'Pengingat gagal diubah.';
            } finally {
              reminderToggle.disabled = false;
            }
          })();
        });
      } catch {
        reminderToggle.hidden = true;
        reminderStatus.textContent = 'Status pengingat tidak bisa dibaca.';
      }
    })();

    /* --------------------------------------------------------------- backup */

    // History lives on this device and nowhere else, which is the promise the
    // rest of the product keeps. The cost of keeping it is that clearing site
    // data destroys everything with no way back — and browsers do that on
    // storage pressure without asking. A file the user holds is the way out
    // that does not move the data somewhere we said it would never go.

    const backupStatus = el('p', { class: 'card__foot' });

    const download = el('button', {
      class: 'btn btn--outline',
      type: 'button',
      text: 'Unduh cadangan',
    });
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(exportBackup());
      const link = el('a', { href: url, download: backupFilename() });
      link.click();
      // Freed on the next tick: revoking immediately can cancel the download
      // in Safari before it has read the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      backupStatus.textContent = 'Cadangan diunduh. Simpan di tempat yang tidak ikut terhapus.';
    });

    const picker = el('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
    });
    const restore = el('button', {
      class: 'btn btn--outline',
      type: 'button',
      text: 'Pulihkan dari file',
    });

    restore.addEventListener('click', () => {
      if (
        window.confirm(
          'Riwayat, profil, dan preferensi di perangkat ini akan diganti isi cadangan. Lanjutkan?',
        )
      ) {
        picker.click();
      }
    });

    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (!file) return;

      void (async () => {
        const result = importBackup(await file.text());
        // Reset either way: picking the same file twice fires no change event.
        picker.value = '';

        if (!result.ok) {
          backupStatus.textContent = result.reason;
          return;
        }
        // Every screen already rendered is holding the old data, and the
        // session loop reads history at startup. Reloading is cheaper and more
        // honest than re-rendering each of them from here.
        backupStatus.textContent = 'Cadangan dipulihkan. Memuat ulang…';
        window.setTimeout(() => location.reload(), 600);
      })();
    });

    body.append(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card__eyebrow', text: 'CADANGAN DATA' }),
        el('p', {
          class: 'sheet__note',
          text: 'Riwayat latihan hanya tersimpan di perangkat ini. Menghapus data situs atau berganti HP akan menghilangkannya, jadi simpan cadangan sesekali.',
        }),
        download,
        restore,
        picker,
        backupStatus,
      ),
    );

    /* -------------------------------------------------------------- privacy */

    body.append(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card__eyebrow', text: 'PRIVASI' }),
        el('p', {
          class: 'sheet__note',
          text: 'Gambar dari kamera diproses di perangkat ini dan tidak pernah dikirim ke mana pun. Yang keluar setelah satu set selesai hanyalah angka ringkasannya: jumlah repetisi, sudut sendi dalam derajat, durasi, dan kode kesalahan.',
        }),
        el('p', {
          class: 'sheet__note',
          text: 'Berat, tinggi, dan usia tetap di perangkat. Yang sampai ke saran menu hanya angka kalori hasil hitungannya, bukan ukuran tubuh yang menghasilkannya.',
        }),
        // The one exception, stated as an exception. An app whose argument is
        // "the processing happens here" owes the user a plain sentence at the
        // point where that stops being true.
        el('p', {
          class: 'sheet__note',
          text: 'Satu pengecualian: kalau kamu memakai tombol bicara saat istirahat, suaramu dikirim ke layanan pengenal suara milik browser untuk diubah jadi teks. Ketik kalau tidak mau. Keluhan yang tercatat tetap tersimpan di perangkat dan tidak pernah dikirim.',
        }),
        el('p', {
          class: 'card__foot',
          text: 'LATIH bukan alat medis dan tidak memberi diagnosis. Kalau ada nyeri atau kondisi kesehatan tertentu, tanyakan ke tenaga kesehatan sebelum mengikuti programnya.',
        }),
      ),
    );
  }

  return { enter: render };
}
