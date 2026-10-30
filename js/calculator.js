// Custom package calculator
// Mirrors the same style of calculation ThriceZed uses for real invoices,
// recalibrated to student-affordable rates for the public quote tool.

const RATES = {
  homeGame: 60,
  awayGame: 65,
  extraTime: 15,   // per additional 30s block
  cgi: 10,        // per effects/CGI scene
  rush: 5,        // per day faster than standard turnaround
};

const ELITE_MIN_GAMES = 5;
const RUSH_MAX_DAYS = 7; // can't rush delivery more than a week early

const state = {
  homeGames: 3,
  awayGames: 2,
  extraTime: 0,
  cgi: 0,
  rush: 0,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bulkDiscount(totalGames) {
  if (totalGames < ELITE_MIN_GAMES) return 0;
  return 40 * Math.log10(totalGames);
}

function calculateTotal() {
  const totalGames = state.homeGames + state.awayGames;

  const subtotal =
    state.homeGames * RATES.homeGame +
    state.awayGames * RATES.awayGame +
    state.extraTime * RATES.extraTime +
    state.cgi * RATES.cgi +
    state.rush * RATES.rush;

  const discount = bulkDiscount(totalGames);
  const total = Math.max(0, subtotal - discount);

  return { totalGames, subtotal, discount, total };
}

function updateDisplay() {
  document.querySelectorAll('[data-field]').forEach((el) => {
    const field = el.dataset.field;
    el.textContent = state[field];
  });

  const { totalGames, discount, total } = calculateTotal();

  const totalEl = document.getElementById('calc-total-amount');
  if (totalEl) totalEl.textContent = `$${total.toFixed(0)}`;

  const discountEl = document.getElementById('calc-discount-line');
  if (discountEl) {
    if (discount > 0) {
      discountEl.textContent = `Includes volume discount: -$${discount.toFixed(0)}`;
      discountEl.style.display = 'block';
    } else {
      discountEl.style.display = 'none';
    }
  }

  const flagEl = document.getElementById('calc-elite-flag');
  if (flagEl) {
    if (totalGames < ELITE_MIN_GAMES) {
      flagEl.textContent = `Add ${ELITE_MIN_GAMES - totalGames} more game${ELITE_MIN_GAMES - totalGames === 1 ? '' : 's'} to unlock Custom package pricing.`;
      flagEl.classList.add('show');
    } else {
      flagEl.classList.remove('show');
    }
  }

  const requestBtn = document.getElementById('request-custom-btn');
  if (requestBtn) {
    const belowMinimum = totalGames < ELITE_MIN_GAMES;
    requestBtn.classList.toggle('disabled', belowMinimum);
    requestBtn.setAttribute('aria-disabled', String(belowMinimum));
    requestBtn.tabIndex = belowMinimum ? -1 : 0;
  }
}

const CONTACT_PHONE = '+13163504148';

function buildRequestSms() {
  const parts = [
    `${state.homeGames} home`,
    `${state.awayGames} away`,
  ];
  if (state.extraTime) parts.push(`+${state.extraTime} x 30s length`);
  if (state.cgi) parts.push(`${state.cgi} CGI scene${state.cgi === 1 ? '' : 's'}`);
  if (state.rush) parts.push(`rush ${state.rush} day${state.rush === 1 ? '' : 's'}`);

  const { total } = calculateTotal();
  const body = `Hi ThriceZed, I'd like a custom package: ${parts.join(', ')}. `
    + `Estimated total $${total.toFixed(0)}.`;

  return `sms:${CONTACT_PHONE}?&body=${encodeURIComponent(body)}`;
}

function bindStepper(fieldName, { min = 0, max = 99 } = {}) {
  const row = document.querySelector(`[data-stepper="${fieldName}"]`);
  if (!row) return;

  row.querySelector('.step-down').addEventListener('click', () => {
    state[fieldName] = clamp(state[fieldName] - 1, min, max);
    updateDisplay();
  });

  row.querySelector('.step-up').addEventListener('click', () => {
    state[fieldName] = clamp(state[fieldName] + 1, min, max);
    updateDisplay();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.querySelector('.calculator')) return;

  bindStepper('homeGames', { min: 0, max: 30 });
  bindStepper('awayGames', { min: 0, max: 30 });
  bindStepper('extraTime', { min: 0, max: 20 });
  bindStepper('cgi', { min: 0, max: 20 });
  bindStepper('rush', { min: 0, max: RUSH_MAX_DAYS });

  const requestBtn = document.getElementById('request-custom-btn');
  if (requestBtn) {
    requestBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const { totalGames } = calculateTotal();
      if (totalGames < ELITE_MIN_GAMES) return;
      window.location.href = buildRequestSms();
    });
  }

  updateDisplay();
});
