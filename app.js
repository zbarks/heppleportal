/* ============================================================
   HEPPLE · ANALYTICS PORTAL — client
   Fetches /api/metrics, /api/orders, /api/analytics in parallel,
   renders KPIs, charts, tables; wires fulfilment toggle.
   Vanilla JS, no build step.
   ============================================================ */
(function () {
  'use strict';

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---- formatting helpers ----
  var GBP0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  var GBP2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var NUM  = new Intl.NumberFormat('en-GB');
  function money(n, dp) { n = Number(n) || 0; return (dp === 2 ? GBP2 : GBP0).format(n); }
  function num(n) { return NUM.format(Number(n) || 0); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function shortDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  var state = { orders: [], filter: 'all', anyDemo: false };

  function getJSON(url, opts) {
    return fetch(url, opts || {}).then(function (r) { return r.json(); })
      .catch(function () { return { demo: true, error: 'fetch_failed' }; });
  }

  // ============================================================
  //  BOOT
  // ============================================================
  function boot() {
    Promise.all([
      getJSON('/api/metrics'),
      getJSON('/api/orders'),
      getJSON('/api/analytics'),
    ]).then(function (res) {
      var metrics = res[0], orders = res[1], analytics = res[2];
      state.anyDemo = !!(metrics.demo || orders.demo || analytics.demo);

      renderSourcePill(metrics, orders, analytics);
      renderKPIs(metrics, analytics);
      renderRevenue(metrics);
      renderProductSplit(metrics);

      state.orders = (orders.orders || []).slice();
      renderFulfil(orders.summary || summarise(state.orders));
      renderOrders();
      renderCustomers(state.orders);

      renderFunnel(analytics);
      renderTopPages(analytics);
      renderSources(analytics);
      renderAbandon(analytics);

      if (state.anyDemo) {
        var b = $('#demoBanner'); if (b) b.hidden = false;
      }
      var lu = $('#lastUpdated');
      if (lu) lu.textContent = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    });
  }

  function renderSourcePill(m, o, a) {
    var pill = $('#sourcePill'); if (!pill) return;
    if (state.anyDemo) { pill.textContent = 'Demo data'; pill.setAttribute('data-state', 'demo'); }
    else { pill.textContent = 'Live'; pill.setAttribute('data-state', 'live'); }
  }

  // ============================================================
  //  KPIs
  // ============================================================
  function renderKPIs(m, a) {
    var conv = (a && a.conversionRate != null) ? a.conversionRate : null;
    var cards = [
      { label: 'Revenue (gross)', value: money(m.revenue, 0), sub: num(m.units) + ' units sold', cls: '' },
      { label: 'Net (after fees)', value: money(m.net, 0), sub: 'est. card + transfer fees', cls: 'kpi--green' },
      { label: 'Orders', value: num(m.orders), sub: money(m.aov, 2) + ' avg order', cls: 'kpi--teal' },
      { label: 'Customers', value: num(m.customers), sub: 'unique buyers', cls: '' },
      { label: 'Avg order value', value: money(m.aov, 2), sub: 'per checkout', cls: '' },
      { label: 'Conversion', value: conv != null ? conv + '%' : '—', sub: 'visitor → purchase', cls: 'kpi--pink' },
    ];
    var html = cards.map(function (c) {
      return '<div class="kpi ' + c.cls + '">' +
        '<p class="kpi__label">' + esc(c.label) + '</p>' +
        '<div class="kpi__value">' + esc(c.value) + '</div>' +
        '<div class="kpi__sub">' + esc(c.sub) + '</div></div>';
    }).join('');
    $('#kpis').innerHTML = html;
  }

  // ============================================================
  //  REVENUE CHART
  // ============================================================
  function renderRevenue(m) {
    var daily = m.daily || [];
    var canvas = $('#revenueChart');
    if (!canvas || typeof Chart === 'undefined' || !daily.length) return;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, 280);
    grad.addColorStop(0, 'rgba(0,48,135,.22)');
    grad.addColorStop(1, 'rgba(0,48,135,0)');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: daily.map(function (d) { return shortDate(d.date); }),
        datasets: [{
          label: 'Revenue',
          data: daily.map(function (d) { return d.revenue; }),
          borderColor: '#003087', borderWidth: 2,
          backgroundColor: grad, fill: true,
          tension: .32, pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: '#003087',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1b1a2e', padding: 10, displayColors: false,
            callbacks: { label: function (c) { return money(c.parsed.y, 2); } },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#6b6457', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
          y: { grid: { color: '#e4ddd1' }, ticks: { color: '#6b6457', font: { size: 10 }, callback: function (v) { return '£' + num(v); } } },
        },
      },
    });
  }

  function renderProductSplit(m) {
    var ul = $('#productSplit'); if (!ul) return;
    var rows = m.byProduct || [];
    if (!rows.length) { ul.innerHTML = '<li class="splitlist__empty">No product breakdown in live mode — see orders.</li>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.revenue; }).concat([1]));
    ul.innerHTML = rows.map(function (r) {
      var pct = Math.round((r.revenue / max) * 100);
      return '<li class="splitlist__row">' +
        '<div class="splitlist__top"><span class="splitlist__name">' + esc(r.name) + '</span>' +
        '<span class="splitlist__rev">' + money(r.revenue, 0) + '</span></div>' +
        '<div class="splitlist__meter"><i style="width:' + pct + '%"></i></div>' +
        '<span class="splitlist__units">' + num(r.units) + ' units</span></li>';
    }).join('');
  }

  // ============================================================
  //  FULFILMENT
  // ============================================================
  function summarise(orders) {
    var fulfilled = orders.filter(function (o) { return o.fulfilled; }).length;
    var outstanding = orders.length - fulfilled;
    var outstandingValue = orders.filter(function (o) { return !o.fulfilled; })
      .reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
    return { total: orders.length, fulfilled: fulfilled, outstanding: outstanding, outstandingValue: outstandingValue };
  }
  function renderFulfil(sum) {
    var pct = sum.total ? Math.round((sum.fulfilled / sum.total) * 100) : 0;
    $('#fulfilFill').style.width = pct + '%';
    $('#fulDone').textContent = num(sum.fulfilled);
    $('#fulOpen').textContent = num(sum.outstanding);
    $('#fulVal').textContent = money(sum.outstandingValue, 0);
    var hint = $('#fulSummaryHint');
    if (hint) hint.textContent = pct + '% dispatched';
  }

  // ============================================================
  //  ORDERS TABLE
  // ============================================================
  function renderOrders() {
    var body = $('#ordersBody'); if (!body) return;
    var list = state.orders.filter(function (o) {
      if (state.filter === 'fulfilled') return o.fulfilled;
      if (state.filter === 'outstanding') return !o.fulfilled;
      return true;
    });
    if (!list.length) { body.innerHTML = '<tr><td colspan="7" class="otable__empty">No orders in this view.</td></tr>'; return; }
    body.innerHTML = list.map(function (o) {
      var ref = (o.stripe_session_id || '').replace(/^cs_(test_|live_|demo_)?/, '').slice(0, 10) || '—';
      var items = o.cart_summary || (o.items || []).map(function (i) { return i.qty + '× ' + (i.name || i.slug); }).join(', ');
      var status = o.fulfilled
        ? '<span class="pill pill--done">Fulfilled</span>'
        : '<span class="pill pill--open">Outstanding</span>';
      var action = o.fulfilled
        ? '<button class="fbtn fbtn--undo" data-id="' + esc(o.stripe_session_id) + '" data-to="0">Mark unsent</button>'
        : '<button class="fbtn" data-id="' + esc(o.stripe_session_id) + '" data-to="1">Mark fulfilled</button>';
      return '<tr>' +
        '<td><span class="otable__order">#' + esc(ref) + '</span></td>' +
        '<td>' + esc(o.customer_name || '—') + '<span class="otable__sub">' + esc(o.customer_email || '') + '</span></td>' +
        '<td class="otable__items">' + esc(items) + '</td>' +
        '<td class="num">' + money(o.total, 2) + '</td>' +
        '<td>' + shortDate(o.created_at) + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="act">' + action + '</td>' +
        '</tr>';
    }).join('');
    $$('#ordersBody .fbtn').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleFulfil(btn); });
    });
  }

  function toggleFulfil(btn) {
    var id = btn.getAttribute('data-id');
    var to = btn.getAttribute('data-to') === '1';
    btn.disabled = true; btn.textContent = '…';
    getJSON('/api/fulfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripe_session_id: id, fulfilled: to }),
    }).then(function (resp) {
      // optimistic update on success OR demo acknowledgement
      var ok = resp && (resp.updated || resp.demo || resp.order);
      if (ok) {
        state.orders.forEach(function (o) {
          if (o.stripe_session_id === id) {
            o.fulfilled = to;
            o.fulfilled_at = to ? new Date().toISOString() : null;
          }
        });
        renderFulfil(summarise(state.orders));
        renderOrders();
      } else {
        btn.disabled = false; btn.textContent = to ? 'Mark fulfilled' : 'Mark unsent';
      }
    });
  }

  // ============================================================
  //  CUSTOMERS (derived from orders — works in every mode)
  // ============================================================
  function renderCustomers(orders) {
    var body = $('#custBody'); if (!body) return;
    var map = {};
    orders.forEach(function (o) {
      var key = (o.customer_email || o.customer_name || 'unknown').toLowerCase();
      if (!map[key]) map[key] = { name: o.customer_name || '—', email: o.customer_email || '', orders: 0, spent: 0, last: null };
      map[key].orders += 1;
      map[key].spent += Number(o.total) || 0;
      if (!map[key].last || new Date(o.created_at) > new Date(map[key].last)) map[key].last = o.created_at;
    });
    var rows = Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.spent - a.spent; }).slice(0, 8);
    if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="otable__empty">No customers yet.</td></tr>'; return; }
    body.innerHTML = rows.map(function (c) {
      return '<tr>' +
        '<td><b>' + esc(c.name) + '</b></td>' +
        '<td>' + esc(c.email) + '</td>' +
        '<td class="num">' + num(c.orders) + '</td>' +
        '<td class="num">' + money(c.spent, 2) + '</td>' +
        '<td>' + shortDate(c.last) + '</td>' +
        '</tr>';
    }).join('');
  }

  // ============================================================
  //  FUNNEL / PAGES / SOURCES / ABANDON
  // ============================================================
  function renderFunnel(a) {
    var ul = $('#funnel'); if (!ul) return;
    var f = a.funnel || [];
    if (!f.length) { ul.innerHTML = '<li class="funnel__empty">No funnel data.</li>'; return; }
    var top = f[0].count || 1;
    ul.innerHTML = f.map(function (s, i) {
      var pct = Math.round((s.count / top) * 100);
      var stepPct = i === 0 ? 100 : Math.round((s.count / (f[i - 1].count || 1)) * 100);
      return '<li class="funnel__row">' +
        '<div class="funnel__top"><span class="funnel__step">' + esc(s.step) + '</span>' +
        '<span class="funnel__n">' + num(s.count) + '</span></div>' +
        '<div class="funnel__track"><i style="width:' + Math.max(pct, 2) + '%"></i></div>' +
        (i > 0 ? '<span class="funnel__pct">' + stepPct + '% of previous step</span>' : '') +
        '</li>';
    }).join('');
  }

  function renderTopPages(a) {
    var ul = $('#topPages'); if (!ul) return;
    var rows = a.topPages || [];
    if (!rows.length) { ul.innerHTML = '<li class="barlist__empty">No page data.</li>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.views; }).concat([1]));
    ul.innerHTML = rows.map(function (r) {
      var pct = Math.round((r.views / max) * 100);
      return '<li class="barlist__row">' +
        '<div class="barlist__top"><span class="barlist__label">' + esc(r.path || '/') + '</span>' +
        '<span class="barlist__val">' + num(r.views) + '</span></div>' +
        '<div class="barlist__track"><i style="width:' + Math.max(pct, 3) + '%"></i></div></li>';
    }).join('');
  }

  function renderSources(a) {
    var ul = $('#sources'); if (!ul) return;
    var rows = (a.sources || []).map(function (s) {
      return { label: s.source, val: (s.sessions != null ? s.sessions : s.visitors) || 0 };
    });
    if (!rows.length) { ul.innerHTML = '<li class="barlist__empty">No source data.</li>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.val; }).concat([1]));
    ul.innerHTML = rows.map(function (r) {
      var pct = Math.round((r.val / max) * 100);
      return '<li class="barlist__row">' +
        '<div class="barlist__top"><span class="barlist__label">' + esc(r.label) + '</span>' +
        '<span class="barlist__val">' + num(r.val) + '</span></div>' +
        '<div class="barlist__track"><i style="width:' + Math.max(pct, 3) + '%"></i></div></li>';
    }).join('');
  }

  function renderAbandon(a) {
    var box = $('#abandon'); if (!box) return;
    if (a.abandonedCarts == null) return;
    box.hidden = false;
    $('#abandonN').textContent = num(a.abandonedCarts);
    var v = $('#abandonV');
    if (v) v.textContent = a.abandonedValue != null ? money(a.abandonedValue, 0) + ' in lost baskets' : '';
  }

  // ---- segmented filter ----
  $$('.seg__btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $$('.seg__btn').forEach(function (b) { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('is-active'); btn.setAttribute('aria-selected', 'true');
      state.filter = btn.getAttribute('data-filter');
      renderOrders();
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
