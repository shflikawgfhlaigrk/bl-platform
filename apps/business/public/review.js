const content = document.querySelector('#review-content'), notice = document.querySelector('#notice'), token = location.hash.slice(1);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const destinations = platforms => {
  const links = (platforms || []).filter(platform => /^https:\/\//.test(platform.url || platform.targetUrl || ''))
    .map(platform => `<p><a href="${esc(platform.url || platform.targetUrl)}" rel="noopener noreferrer" target="_blank">${esc(platform.name || 'Share your experience')}</a></p>`).join('');
  return links ? `<section aria-label="Public review destinations"><h2>Share your experience publicly</h2><p>You can leave an honest public review at any time. Private feedback below is optional.</p>${links}</section>` : '';
};
async function request(action = '', body) {
  const response = await fetch(`/api/reviews/public/requests/${encodeURIComponent(token)}${action}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'Review request failed.');
  return result.data;
}
function bindOptOut() {
  const button = document.querySelector('#opt-out');
  if (!button) return;
  button.onclick = async () => {
    button.disabled = true;
    try { await request('/opt-out', {}); await render(); }
    catch (error) { notice.textContent = error.message; notice.className = 'error'; button.disabled = false; }
  };
}
async function render() {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) { content.textContent = 'Open the review link provided by your business.'; return; }
  try {
    const state = await request(), links = destinations(state.platforms);
    if (state.optedOut || state.status === 'opted_out') {
      content.innerHTML = `<p>You have opted out of review requests from this business.</p>${links}`;
      return;
    }
    if (state.submitted) {
      content.innerHTML = `<h2>Feedback recorded</h2><p>Your feedback has been recorded. Thank you.</p>${links}<button type="button" id="opt-out" class="quiet">Opt out of future review requests</button>`;
      bindOptOut();
      return;
    }
    content.innerHTML = links + '<form id="review-form"><h2>Send private feedback to the business</h2><label>Rating<select name="rating" required><option value="">Choose a rating</option><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Fair</option><option value="2">2 — Poor</option><option value="1">1 — Very poor</option></select></label><label>Your feedback<textarea name="comment" maxlength="5000"></textarea></label><div class="actions"><button>Submit feedback</button><button type="button" id="opt-out" class="quiet">Opt out of future review requests</button></div></form>';
    document.querySelector('#review-form').onsubmit = async event => {
      event.preventDefault();
      const buttons = content.querySelectorAll('button');
      for (const button of buttons) button.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(event.currentTarget));
        const result = await request('/submit', { rating: Number(data.rating), comment: data.comment });
        content.innerHTML = `<h2>Feedback recorded</h2><p>${esc(result.message)}</p>${destinations(result.platforms)}<button type="button" id="opt-out" class="quiet">Opt out of future review requests</button>`;
        bindOptOut();
      } catch (error) {
        notice.textContent = error.message; notice.className = 'error';
        for (const button of buttons) button.disabled = false;
      }
    };
    bindOptOut();
  } catch (error) { content.textContent = error.message; }
}
render();
