/* BloodSync extras: the "out of the box" features.
 *   - blood compatibility explorer      - "Am I eligible?" checker
 *   - live homepage counters            - "how many donors will be alerted" estimate
 *   - share a request (WhatsApp etc.)   - donor levels + downloadable donor card
 *   - install-as-app button             - scroll reveal animations
 * Pure logic lives in BloodSync.logic (no DOM), so it can be unit tested. Everything that touches
 * the page is wired in init() and quietly skips elements that are not on the current page.
 */
(function (global) {
  'use strict';
  const BS = global.BloodSync;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => BS.esc(v);

  // ======================= pure logic (no DOM) =======================
  const GROUPS = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
  // Who each group can give red blood cells to.
  const GIVES_TO = {
    'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    'O+': ['O+', 'A+', 'B+', 'AB+'],
    'A-': ['A-', 'A+', 'AB-', 'AB+'],
    'A+': ['A+', 'AB+'],
    'B-': ['B-', 'B+', 'AB-', 'AB+'],
    'B+': ['B+', 'AB+'],
    'AB-': ['AB-', 'AB+'],
    'AB+': ['AB+']
  };
  const canDonateTo = (group) => (GIVES_TO[group] || []).slice();
  const canReceiveFrom = (group) => GROUPS.filter((g) => GIVES_TO[g].includes(group));

  const REST_DAYS = 90; // the same 3-month gap the server enforces

  // Mirrors the server's registration rules (age 18 to 65, weight 50 kg or more, 90 days between
  // donations) plus the common temporary reasons to wait. It is guidance only: the final decision
  // is always made by the medical staff on the day.
  function checkEligibility({ age, weightKg, gender, lastDonation, flags = {}, now = new Date() }) {
    const no = [], wait = [];
    let retryOn = null;
    const retryAfter = (date) => { if (!retryOn || date > retryOn) retryOn = date; };

    if (!(age >= 18)) no.push('You must be at least 18 years old to donate.');
    else if (age > 65) no.push('Donors must be 65 or younger to register.');
    if (!(weightKg >= 50)) no.push('You need to weigh at least 50 kg so that donating is safe for you.');

    if (lastDonation) {
      const next = new Date(lastDonation.getTime() + REST_DAYS * 86400000);
      if (next > now) {
        const days = Math.ceil((next - now) / 86400000);
        wait.push(`Your last donation was too recent. Your body needs ${REST_DAYS} days to recover, so you can donate again in ${days} day${days === 1 ? '' : 's'}.`);
        retryAfter(next);
      }
    }
    if (flags.ill) wait.push('Wait until you have fully recovered from any fever, cold or flu (at least a week without symptoms).');
    if (flags.tattoo) wait.push('A tattoo, piercing or surgery in the last 6 months means waiting until 6 months have passed.');
    if (flags.antibiotics) wait.push('Finish your course of antibiotics and wait a few days before donating.');
    if (flags.alcohol) wait.push('Avoid donating within 48 hours of alcohol. Wait two days.');
    if (flags.vaccine) wait.push('Wait about two weeks after a vaccination.');
    if (flags.pregnant && gender === 'Female') wait.push('Donation is not possible during pregnancy or while breastfeeding. You are welcome to register afterwards.');

    const status = no.length ? 'no' : wait.length ? 'wait' : 'eligible';
    return { status, reasons: no.concat(wait), retryOn };
  }

  // Short, privacy-friendly message people can post in family and WhatsApp groups.
  // It never includes the patient's name.
  function buildShareText({ type, bloodGroup, units, hospitalName, hospitalArea, contact, origin }) {
    const need = type === 'direct-need' ? `${bloodGroup} blood` : 'a replacement blood donor (any compatible group)';
    const lines = [
      `URGENT: ${need} needed (${units} unit${Number(units) === 1 ? '' : 's'}).`,
      `Hospital: ${hospitalName}, ${hospitalArea}.`
    ];
    if (contact) lines.push(`Contact: ${contact}`);
    lines.push(`Can you donate, or forward this? Register as a donor or help at ${origin}`);
    return lines.join('\n');
  }
  const whatsAppUrl = (text) => 'https://wa.me/?text=' + encodeURIComponent(text);

  const LEVELS = [
    { at: 0, name: 'Ready Donor' },
    { at: 1, name: 'First Drop' },
    { at: 3, name: 'Life Saver' },
    { at: 5, name: 'Hero' },
    { at: 10, name: 'Guardian' }
  ];
  function donorLevel(count) {
    const n = Math.max(0, Number(count) || 0);
    let idx = 0;
    LEVELS.forEach((l, i) => { if (n >= l.at) idx = i; });
    const next = LEVELS[idx + 1] || null;
    const base = LEVELS[idx].at;
    return {
      name: LEVELS[idx].name,
      count: n,
      livesImpacted: n * 3, // one donation can help up to three patients
      nextName: next ? next.name : null,
      toNext: next ? next.at - n : 0,
      pct: next ? Math.round(((n - base) / (next.at - base)) * 100) : 100
    };
  }

  BS.logic = { GROUPS, GIVES_TO, canDonateTo, canReceiveFrom, checkEligibility, buildShareText, whatsAppUrl, donorLevel };

  // ======================= page features =======================

  // ---- live homepage counters ----
  function countUp(el, to, formatter) {
    const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fmt = formatter || ((n) => n.toLocaleString());
    if (reduce || to === 0) { el.textContent = fmt(to); return; }
    const start = performance.now(), dur = 1100;
    const step = (t) => {
      const p = Math.min(1, (t - start) / dur);
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function initStats() {
    const targets = document.querySelectorAll('[data-stat]');
    if (!targets.length) return;
    try {
      const stats = await BS.api('/api/stats');
      targets.forEach((el) => {
        const key = el.dataset.stat;
        if (key === 'avgMatchMinutes') {
          if (stats.avgMatchMinutes) countUp(el, stats.avgMatchMinutes, (n) => `${n} min`);
          else el.textContent = 'Fast';
        } else if (typeof stats[key] === 'number') {
          countUp(el, stats[key]);
        }
      });
    } catch (_) { /* keep the placeholder text if the server is unreachable */ }
  }

  // ---- blood compatibility explorer ----
  function initCompat() {
    const root = $('compat');
    if (!root) return;
    let mode = 'give', group = 'O-';
    const groupsEl = $('compatGroups'), resultEl = $('compatResult'), noteEl = $('compatNote');

    function notes() {
      const give = canDonateTo(group), get = canReceiveFrom(group);
      if (mode === 'give') {
        if (group === 'O-') return 'O negative is the universal donor: your blood can be given to anyone, which is why emergency teams ask for it first.';
        if (group === 'AB+') return 'AB positive can only donate to other AB+ patients, but it is the universal recipient (see "I need blood").';
        return `${group} red cells can help ${give.length} blood group${give.length === 1 ? '' : 's'}.`;
      }
      if (group === 'AB+') return 'AB positive is the universal recipient: you can receive red cells from any blood group.';
      if (group === 'O-') return 'O negative patients can only receive O negative blood, which is why O- donors are so precious.';
      return `A ${group} patient can safely receive blood from ${get.length} group${get.length === 1 ? '' : 's'}.`;
    }

    function render() {
      groupsEl.innerHTML = GROUPS.map((g) => `<button type="button" class="chip-btn${g === group ? ' on' : ''}" data-group="${esc(g)}" aria-pressed="${g === group}">${esc(g)}</button>`).join('');
      const matches = mode === 'give' ? canDonateTo(group) : canReceiveFrom(group);
      resultEl.innerHTML = GROUPS.map((g) => `<span class="compat-chip${matches.includes(g) ? ' yes' : ''}" title="${matches.includes(g) ? 'Compatible' : 'Not compatible'}">${esc(g)}</span>`).join('');
      noteEl.textContent = notes();
      $('compatLabel').textContent = mode === 'give' ? `If you are ${group}, you can give to:` : `If you are ${group}, you can receive from:`;
      root.querySelectorAll('[data-mode]').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    }
    root.addEventListener('click', (e) => {
      const g = e.target.closest('[data-group]'); if (g) { group = g.dataset.group; render(); return; }
      const m = e.target.closest('[data-mode]'); if (m) { mode = m.dataset.mode; render(); }
    });
    render();
  }

  // ---- "Am I eligible?" ----
  function initEligibility() {
    const form = $('eligForm');
    if (!form) return;
    const genderEl = $('eligGender'), pregRow = $('eligPregRow');
    genderEl.addEventListener('change', () => { pregRow.style.display = genderEl.value === 'Female' ? '' : 'none'; });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const flags = {};
      form.querySelectorAll('input[name="flag"]').forEach((c) => { flags[c.value] = c.checked; });
      const last = $('eligLast').value ? new Date($('eligLast').value) : null;
      const result = checkEligibility({ age: Number($('eligAge').value), weightKg: Number($('eligWeight').value), gender: genderEl.value, lastDonation: last, flags });
      const box = $('eligResult');
      const head = { eligible: 'You are very likely eligible to donate', wait: 'Not just yet, but you can donate soon', no: 'You are not able to donate right now' }[result.status];
      box.className = `elig-result ${result.status}`;
      box.innerHTML = `<strong>${esc(head)}</strong>` +
        (result.reasons.length ? `<ul>${result.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p>Nothing stands in your way. Register as a donor and we will alert you when someone nearby needs your group.</p>') +
        (result.retryOn ? `<p class="muted">Come back on ${esc(result.retryOn.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}.</p>` : '') +
        '<p class="muted small">This is a quick guide only. Medical staff make the final decision on the day, including a haemoglobin check.</p>';
      box.style.display = 'block';
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // ---- how many donors will be alerted ----
  let reachTimer = null, reachSeq = 0;
  async function updateReach({ coordinates, type, bloodGroup, areaLabel }) {
    const box = $('reachBox');
    if (!box) return;
    clearTimeout(reachTimer);
    reachTimer = setTimeout(async () => {
      const seq = ++reachSeq;
      try {
        const q = `lng=${coordinates[0]}&lat=${coordinates[1]}&type=${type}` + (type === 'direct-need' ? `&bloodGroup=${encodeURIComponent(bloodGroup)}` : '');
        const r = await BS.api('/api/reach?' + q);
        if (seq !== reachSeq) return; // an older answer arrived late
        const group = type === 'direct-need' ? bloodGroup : 'any compatible group';
        let msg;
        if (r.total === 0) msg = `No ${group} donors are registered yet. Your request will still be queued and shared as new donors join.`;
        else if (r.within5km > 0) msg = `About <strong>${r.within5km}</strong> ${r.within5km === 1 ? 'donor is' : 'donors are'} within 5 km of ${esc(areaLabel)} (${r.within15km} within 15 km).`;
        else if (r.within15km > 0) msg = `About <strong>${r.within15km}</strong> ${r.within15km === 1 ? 'donor is' : 'donors are'} within 15 km of ${esc(areaLabel)}. We will widen the search automatically.`;
        else msg = `None within 15 km of ${esc(areaLabel)}, but <strong>${r.total}</strong> are registered in the network and we will widen the search automatically.`;
        box.className = `reach-box ${r.within15km > 0 ? 'good' : 'warn'}`;
        box.innerHTML = `<span class="reach-ico" aria-hidden="true"></span><span>${msg}</span>`;
        box.style.display = 'flex';
      } catch (_) { box.style.display = 'none'; }
    }, 450);
  }

  // ---- share a request ----
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (__) { /* ignore */ }
      ta.remove(); return ok;
    }
  }
  // Wires the three share buttons inside `scope` to a function that returns the message text.
  function wireShare(scope, getText, notify) {
    const wa = scope.querySelector('[data-share="whatsapp"]'), cp = scope.querySelector('[data-share="copy"]'), nat = scope.querySelector('[data-share="native"]');
    if (wa) wa.addEventListener('click', () => global.open(whatsAppUrl(getText()), '_blank', 'noopener'));
    if (cp) cp.addEventListener('click', async () => notify((await copyText(getText())) ? 'Message copied. Paste it anywhere.' : 'Could not copy automatically. Select the text and copy it.'));
    if (nat) {
      if (navigator.share) nat.addEventListener('click', () => navigator.share({ text: getText() }).catch(() => {}));
      else nat.style.display = 'none';
    }
  }

  // ---- donor level panel + downloadable donor card ----
  function renderDonorPanel(donor) {
    const lvl = donorLevel(donor.donationCount);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('levelName', lvl.name);
    set('levelCount', `${lvl.count} donation${lvl.count === 1 ? '' : 's'}`);
    set('livesCount', lvl.livesImpacted);
    set('levelNext', lvl.nextName ? `${lvl.toNext} more to reach ${lvl.nextName}` : 'Top level reached. Thank you!');
    // A small minimum so a donor who has just reached a level sees a visible start, not an empty bar.
    const bar = $('levelBar'); if (bar) bar.style.width = `${lvl.count > 0 ? Math.max(lvl.pct, 6) : 0}%`;

    const chip = $('donorStatusChip');
    if (chip) {
      const label = { active: 'Alerts on', inactive: 'Alerts paused', cooldown: 'Resting' }[donor.status] || donor.status;
      chip.textContent = label; chip.dataset.state = donor.status;
    }
    const pause = $('pauseBtn');
    if (pause) {
      pause.style.display = donor.status === 'cooldown' ? 'none' : '';
      pause.textContent = donor.status === 'inactive' ? 'Resume alerts' : 'Pause alerts';
      pause.dataset.next = donor.status === 'inactive' ? 'active' : 'inactive';
    }
    const note = $('cooldownNote');
    if (note) {
      if (donor.status === 'cooldown' && donor.cooldownUntil) {
        note.textContent = `You are resting after your last donation. Alerts resume on ${new Date(donor.cooldownUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.`;
        note.style.display = '';
      } else if (donor.status === 'inactive') {
        note.textContent = 'You will not receive any alerts until you resume.';
        note.style.display = '';
      } else note.style.display = 'none';
    }
  }

  function drawDonorCard(canvas, donor) {
    const W = 1012, H = 638, ctx = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1c2127'); g.addColorStop(1, '#14181c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W - 170, 150, 10, W - 170, 150, 420);
    glow.addColorStop(0, 'rgba(214,48,43,.55)'); glow.addColorStop(1, 'rgba(214,48,43,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d6302b'; ctx.fillRect(0, 0, 14, H);

    const dropAt = (cx, cy, s, fill) => {
      ctx.fillStyle = fill; ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.bezierCurveTo(cx, cy - s, cx - s * 0.95, cy + s * 0.05, cx - s * 0.95, cy + s * 0.45);
      ctx.arc(cx, cy + s * 0.45, s * 0.95, Math.PI, 0, true);
      ctx.bezierCurveTo(cx + s * 0.95, cy + s * 0.05, cx, cy - s, cx, cy - s);
      ctx.fill();
    };
    dropAt(W - 170, 170, 84, '#ec4038');
    ctx.fillStyle = '#fff'; ctx.font = '800 66px Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(donor.bloodGroup, W - 170, 205);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#d6302b'; ctx.beginPath(); ctx.arc(72, 76, 10, 0, 7); ctx.fill();
    ctx.fillStyle = '#f1ede6'; ctx.font = '700 36px Arial, sans-serif'; ctx.fillText('BloodSync', 94, 90);
    ctx.fillStyle = '#8b93a1'; ctx.font = '600 20px Arial, sans-serif'; ctx.fillText('VERIFIED BLOOD DONOR', 72, 150);
    ctx.fillStyle = '#f1ede6'; ctx.font = '700 62px Arial, sans-serif';
    let name = donor.name; while (ctx.measureText(name).width > 600 && name.length > 4) name = name.slice(0, -2);
    ctx.fillText(name === donor.name ? name : name + '...', 72, 270);
    ctx.fillStyle = '#8b93a1'; ctx.font = '600 24px Arial, sans-serif'; ctx.fillText(`${donor.city}  |  Donor since ${new Date(donor.createdAt || Date.now()).getFullYear()}`, 72, 322);

    const lvl = donorLevel(donor.donationCount);
    ctx.fillStyle = 'rgba(241,237,230,.08)'; ctx.fillRect(72, 380, W - 144, 2);
    ctx.fillStyle = '#8b93a1'; ctx.font = '600 18px Arial, sans-serif';
    ctx.fillText('DONOR ID', 72, 430); ctx.fillText('LEVEL', 380, 430); ctx.fillText('LIVES HELPED', 690, 430);
    ctx.fillStyle = '#f1ede6'; ctx.font = '700 36px "Courier New", monospace'; ctx.fillText(donor.donorId, 72, 480);
    ctx.font = '700 36px Arial, sans-serif'; ctx.fillText(lvl.name, 380, 480); ctx.fillStyle = '#ec4038'; ctx.fillText(String(lvl.livesImpacted), 690, 480);
    ctx.fillStyle = '#8b93a1'; ctx.font = '500 18px Arial, sans-serif';
    ctx.fillText('Show this card at the hospital or blood bank. Always bring a valid ID.', 72, 568);
    return canvas;
  }

  function downloadDonorCard(donor) {
    const canvas = drawDonorCard(document.createElement('canvas'), donor);
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bloodsync-donor-${donor.donorId}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }

  // ---- install as an app ----
  let installPrompt = null;
  function initInstall() {
    const buttons = document.querySelectorAll('[data-install]');
    global.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); installPrompt = e;
      buttons.forEach((b) => { b.style.display = ''; });
    });
    global.addEventListener('appinstalled', () => { installPrompt = null; buttons.forEach((b) => { b.style.display = 'none'; }); });
    buttons.forEach((b) => b.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => {});
      installPrompt = null; buttons.forEach((x) => { x.style.display = 'none'; });
    }));
  }

  // ---- scroll reveal ----
  function initReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in global)) { els.forEach((el) => el.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
    // Elements inside sections that are hidden at load get observed again when shown.
    global.__bsReveal = () => document.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el));
  }

  function init() { initStats(); initCompat(); initEligibility(); initInstall(); initReveal(); }

  BS.extras = { updateReach, wireShare, copyText, renderDonorPanel, drawDonorCard, downloadDonorCard, initReveal, countUp };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
