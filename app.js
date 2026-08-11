/* ============================================================
   HEPPLE PORTAL v2 — client app
   Sidebar SPA: Overview / Orders / Products / Fulfilment /
   Traffic / Customers
   ============================================================ */
(function () {
  'use strict';

  // ---- formatting ----
  var GBP0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  var GBP2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var NUM  = new Intl.NumberFormat('en-GB');
  function gbp(n, dp) { return (dp === 2 ? GBP2 : GBP0).format(Number(n) || 0); }
  function num(n) { return NUM.format(Number(n) || 0); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function shortDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  }
  function timeAgo(iso) {
    if (!iso) return '—';
    var d = new Date(iso); var now = Date.now();
    var diff = Math.round((now - d.getTime()) / 60000);
    if (diff < 60) return diff + 'm ago';
    diff = Math.round(diff / 60);
    if (diff < 24) return diff + 'h ago';
    diff = Math.round(diff / 24);
    if (diff < 7) return diff + 'd ago';
    return shortDate(iso);
  }

  // ---- state ----
  var state = {
    metrics: null, orders: null, analytics: null,
    activeSection: 'overview',
    orderFilter: 'all', orderSearch: '',
    windowDays: 90,
    rangeMode: 'days',   // 'days' | 'all' | 'custom'
    rangeFrom: null, rangeTo: null,
    selectedOrder: null,
    chartsBuilt: {},
    anyDemo: false,
  };

  // Build the query string for the current range (used by metrics + orders)
  function rangeQS() {
    if (state.rangeMode === 'all') return 'all=1';
    if (state.rangeMode === 'custom') {
      var p = [];
      if (state.rangeFrom) p.push('from=' + state.rangeFrom);
      if (state.rangeTo) p.push('to=' + state.rangeTo);
      return p.join('&') || ('days=' + state.windowDays);
    }
    return 'days=' + state.windowDays;
  }

  // Human label for KPI subtitles
  function rangeLabel() {
    if (state.rangeMode === 'all') return 'all time';
    if (state.rangeMode === 'custom') {
      if (state.rangeFrom && state.rangeTo) return state.rangeFrom + ' → ' + state.rangeTo;
      if (state.rangeFrom) return 'since ' + state.rangeFrom;
      if (state.rangeTo) return 'up to ' + state.rangeTo;
    }
    return 'last ' + state.windowDays + 'd';
  }

  // ---- fetch ----
  function api(url) {
    return fetch(url).then(function(r){ return r.json(); })
      .catch(function(){ return { demo: true, error: 'fetch_failed' }; });
  }

  // ============================================================
  //  BOOT
  // ============================================================
  function boot() {
    bootDiscounts();

    // Nav
    document.querySelectorAll('.sidebar__link').forEach(function(a) {
      a.addEventListener('click', function(e) {
        e.preventDefault();
        navigateTo(a.dataset.section);
        closeSidebar();
      });
    });

    // Mobile menu
    var menuBtn = document.getElementById('menuBtn');
    if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
    var overlay = document.getElementById('drawerOverlay');
    if (overlay) overlay.addEventListener('click', function() {
      closeDrawer();
      closeSidebar();
    });

    // Window picker
    document.querySelectorAll('.wp-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.wp-btn').forEach(function(b){ b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        if (btn.dataset.range === 'all') {
          state.rangeMode = 'all';
        } else {
          state.rangeMode = 'days';
          state.windowDays = parseInt(btn.dataset.days, 10);
        }
        loadMetrics();
        loadOrders();
      });
    });

    // Custom date range
    var applyBtn = document.getElementById('rangeApply');
    if (applyBtn) applyBtn.addEventListener('click', function() {
      var f = document.getElementById('rangeFrom').value;
      var t = document.getElementById('rangeTo').value;
      if (!f && !t) return;
      state.rangeMode = 'custom';
      state.rangeFrom = f || null;
      state.rangeTo = t || null;
      document.querySelectorAll('.wp-btn').forEach(function(b){ b.classList.remove('is-active'); });
      loadMetrics();
      loadOrders();
    });

    // Order filter tabs
    document.querySelectorAll('.seg-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.seg-btn').forEach(function(b){ b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        state.orderFilter = btn.dataset.filter;
        renderOrdersList();
      });
    });

    // Order search
    var srch = document.getElementById('orderSearch');
    if (srch) srch.addEventListener('input', function() {
      state.orderSearch = srch.value.toLowerCase();
      renderOrdersList();
    });

    // Drawer close
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);

    // Load data — dismiss splash once first response arrives
    var splashDismissed = false;
    function dismissSplash() {
      if (splashDismissed) return;
      splashDismissed = true;
      var splash = document.getElementById('splash');
      if (splash) {
        setTimeout(function() { splash.classList.add('is-hidden'); }, 400);
      }
    }
    loadMetrics(dismissSplash);
    loadOrders(dismissSplash);
    loadAnalytics();
  }

  // ============================================================
  //  NAV
  // ============================================================
  function navigateTo(section) {
    state.activeSection = section;
    document.querySelectorAll('.page').forEach(function(p){ p.hidden = true; });
    var target = document.getElementById(section);
    if (target) target.hidden = false;
    document.querySelectorAll('.sidebar__link').forEach(function(a){
      a.classList.toggle('is-active', a.dataset.section === section);
    });
    // Build charts lazily
    if (section === 'overview' && !state.chartsBuilt.overview && state.metrics) buildOverviewCharts();
    if (section === 'products' && !state.chartsBuilt.products && state.metrics) buildProductChart();
    if (section === 'traffic' && !state.chartsBuilt.traffic && state.analytics) buildTrafficChart();
    if (section === 'fulfilment' && state.orders) renderFulfilment();
    if (section === 'customers' && state.orders) renderCustomers();
    if (section === 'products' && state.orders) renderProductLeaderboard();
    if (section === 'discounts') loadDiscounts();
  }

  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('is-open');
  }
  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('is-open');
  }

  // ============================================================
  //  LOAD METRICS
  // ============================================================
  function loadMetrics(cb) {
    api('/api/metrics?' + rangeQS()).then(function(m) {
      if (cb) cb();
      state.metrics = m;
      if (m.demo) state.anyDemo = true;
      updateStatus(m);
      renderKPIs(m);
      state.chartsBuilt.overview = false;
      if (state.activeSection === 'overview') buildOverviewCharts();
      if (state.activeSection === 'products') {
        renderProductCards(m);
        state.chartsBuilt.products = false;
        buildProductChart();
      }
    });
  }

  // ============================================================
  //  LOAD ORDERS
  // ============================================================
  function loadOrders(cb) {
    api('/api/orders?' + rangeQS()).then(function(o) {
      if (cb) cb();
      state.orders = o;
      if (o.demo) state.anyDemo = true;
      renderOrdersList();
      if (state.activeSection === 'fulfilment') renderFulfilment();
      if (state.activeSection === 'customers') renderCustomers();
      if (state.activeSection === 'products') renderProductLeaderboard();
      if (state.activeSection === 'overview' && state.metrics) renderProductCards(state.metrics);
    });
  }

  // ============================================================
  //  LOAD ANALYTICS
  // ============================================================
  function loadAnalytics() {
    api('/api/analytics').then(function(a) {
      state.analytics = a;
      if (a.demo) state.anyDemo = true;
      renderTrafficKPIs(a);
      renderFunnel(a);
      renderTopPages(a);
      renderSources(a);
      state.chartsBuilt.traffic = false;
      if (state.activeSection === 'traffic') buildTrafficChart();
    });
  }

  // ============================================================
  //  STATUS
  // ============================================================
  function updateStatus(m) {
    var dot = document.getElementById('statusDot');
    var lbl = document.getElementById('statusLabel');
    var topTag = document.getElementById('topbarStatus');
    if (false) {
      // demo banner removed
    } else {
      if (dot) { dot.className = 'status-dot live'; }
      if (lbl) lbl.textContent = 'Live · ' + (m.source || 'stripe');
      if (topTag) topTag.textContent = 'Live';
    }
    var lu = document.getElementById('lastUpdated');
    if (lu) lu.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // ============================================================
  //  KPIs
  // ============================================================
  function renderKPIs(m) {
    var a = state.analytics || {};
    var rl = rangeLabel();
    var cards = [
      { label: 'Revenue', value: gbp(m.revenue, 0), sub: rl + ' · all sources', cls: '' },
      { label: 'Avg order', value: gbp(m.aov, 2), sub: 'per order', cls: 'kpi-card--blue' },
      { label: 'Orders', value: num(m.orders), sub: rl, cls: '' },
      { label: 'Customers', value: num(m.customers), sub: 'unique buyers', cls: 'kpi-card--blue' },
      { label: 'Units sold', value: num(m.units), sub: 'across all products', cls: '' },
      { label: 'Conversion', value: a.conversionRate != null ? a.conversionRate + '%' : '—', sub: 'visitor → purchase', cls: '' },
    ];
    var html = cards.map(function(c) {
      return '<div class="kpi-card ' + c.cls + '">' +
        '<p class="kpi__label">' + esc(c.label) + '</p>' +
        '<div class="kpi__value">' + esc(c.value) + '</div>' +
        '<div class="kpi__sub">' + esc(c.sub) + '</div></div>';
    }).join('');
    document.getElementById('kpiGrid').innerHTML = html;
  }

  // ============================================================
  //  OVERVIEW CHARTS
  // ============================================================
  var revenueChartInst = null, monthlyChartInst = null;
  function buildOverviewCharts() {
    if (!state.metrics) return;
    var m = state.metrics;
    state.chartsBuilt.overview = true;

    // Daily revenue
    var daily = m.daily || [];
    var ctx1 = document.getElementById('revenueChart');
    if (ctx1) {
      if (revenueChartInst) revenueChartInst.destroy();
      revenueChartInst = new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: daily.map(function(d){ return d.date.slice(5); }),
          datasets: [{
            label: 'Revenue',
            data: daily.map(function(d){ return d.revenue; }),
            backgroundColor: 'rgba(1,48,136,0.08)',
            borderColor: '#013088',
            borderWidth: 1,
            borderRadius: 3,
          }]
        },
        options: chartDefaults('£', false)
      });
    }

    // Monthly
    var monthly = m.monthly || [];
    var ctx2 = document.getElementById('monthlyChart');
    if (ctx2) {
      if (monthlyChartInst) monthlyChartInst.destroy();
      monthlyChartInst = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: monthly.map(function(d){ return d.month.slice(2); }),
          datasets: [{
            label: 'Revenue',
            data: monthly.map(function(d){ return d.revenue; }),
            borderColor: '#013088',
            backgroundColor: 'rgba(1,48,136,0.08)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: 'rgba(163,196,188,.9)',
          }]
        },
        options: chartDefaults('£', false)
      });
    }
  }

  // ============================================================
  //  ORDERS LIST
  // ============================================================
  function renderOrdersList() {
    var container = document.getElementById('ordersList');
    if (!state.orders) {
      container.innerHTML = '<div class="orders-list__loading">Loading orders…</div>';
      return;
    }
    var orders = (state.orders.orders || []).slice();
    // Filter
    if (state.orderFilter === 'outstanding') orders = orders.filter(function(o){ return !o.fulfilled; });
    if (state.orderFilter === 'fulfilled')   orders = orders.filter(function(o){ return !!o.fulfilled; });
    // Search
    if (state.orderSearch) {
      var q = state.orderSearch;
      orders = orders.filter(function(o) {
        return (o.customer_name || '').toLowerCase().indexOf(q) !== -1 ||
               (o.customer_email || '').toLowerCase().indexOf(q) !== -1 ||
               (o.stripe_session_id || '').toLowerCase().indexOf(q) !== -1 ||
               (o.cart_summary || '').toLowerCase().indexOf(q) !== -1;
      });
    }

    if (!orders.length) {
      container.innerHTML = '<p class="empty-state">No orders match this filter.</p>';
      return;
    }

    var html = orders.map(function(o) {
      var statusBadge = o.fulfilled
        ? '<span class="badge badge--done">Fulfilled</span>'
        : '<span class="badge badge--open">Outstanding</span>';
      var items = o.items && o.items.length
        ? o.items.map(function(it){ return it.qty + '× ' + ((it.name || '').replace('Hepple ','') || it.sku || 'Unknown item'); }).join(', ')
        : (o.cart_summary || '—');
      return '<div class="order-card" data-id="' + esc(o.stripe_session_id) + '">' +
        '<div>' +
          '<span class="order-card__ref">' + esc((o.stripe_session_id || '').slice(-12)) + '</span>' +
          '<div class="order-card__name">' + esc(o.customer_name || 'Unknown') + '</div>' +
          '<div class="order-card__email">' + esc(o.customer_email || '') + '</div>' +
        '</div>' +
        '<div class="order-card__items">' + esc(items) + '</div>' +
        '<div class="order-card__total">' + gbp(o.total, 2) + '</div>' +
        '<div class="order-card__date">' + timeAgo(o.created_at) + '</div>' +
        '<div class="order-card__status">' + statusBadge + '</div>' +
      '</div>';
    }).join('');
    container.innerHTML = html;

    // Click to open drawer
    container.querySelectorAll('.order-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var id = card.dataset.id;
        var order = (state.orders.orders || []).find(function(o){ return o.stripe_session_id === id; });
        if (order) openDrawer(order);
      });
    });
  }

  // ============================================================
  //  ORDER DRAWER
  // ============================================================
  function openDrawer(order) {
    state.selectedOrder = order;
    var content = document.getElementById('drawerContent');
    var addr = order.shipping_address || {};
    var recipient = addr.name || order.customer_name || '';
    var addrLines = [addr.line1, addr.line2, addr.city, addr.postal_code, addr.country]
      .filter(Boolean).join('<br>');

    var lineItemsHtml = '';
    if (order.items && order.items.length) {
      lineItemsHtml = order.items.map(function(it) {
        return '<div class="drawer-item">' +
          '<div><div class="drawer-item__name">' + esc(it.name) + '</div>' +
          '<div class="drawer-item__sku">' + esc(it.sku || '') + '</div></div>' +
          '<div class="drawer-item__right">' +
            '<div class="drawer-item__price">' + gbp(it.price * it.qty, 2) + '</div>' +
            '<div class="drawer-item__qty">× ' + it.qty + ' @ ' + gbp(it.price, 2) + '</div>' +
          '</div></div>';
      }).join('');
    } else if (order.cart_summary) {
      lineItemsHtml = '<p style="color:var(--text2);font-size:.82rem;">' + esc(order.cart_summary) + '</p>';
    } else {
      lineItemsHtml = '<p class="drawer-empty">Line items not available (Supabase/Stripe line items needed)</p>';
    }

    var fulfilBtn = order.fulfilled
      ? '<button class="drawer-fulfill-btn drawer-fulfill-btn--unmark" id="drawerFulBtn">Mark as outstanding</button>'
      : '<button class="drawer-fulfill-btn drawer-fulfill-btn--mark" id="drawerFulBtn">✓ Mark as fulfilled</button>';

    content.innerHTML =
      '<div class="drawer-section">' +
        '<div class="drawer-ref">' + esc(order.stripe_session_id || '') + '</div>' +
        '<div class="drawer-name">' + esc(order.customer_name || 'Unknown') + '</div>' +
        '<div class="drawer-email">' + esc(order.customer_email || '') + '</div>' +
        (order.customer_phone ? '<div class="drawer-phone" style="font-size:.85rem;color:var(--text2);margin-top:2px;">📞 ' + esc(order.customer_phone) + '</div>' : '') +
      '</div>' +

      '<div class="drawer-section">' +
        '<div class="drawer-total">' + gbp(order.total, 2) + '</div>' +
        '<div class="drawer-total-sub">subtotal ' + gbp(order.subtotal, 2) +
          (order.shipping ? ' + ' + gbp(order.shipping, 2) + ' shipping' : ' · free shipping') + '</div>' +
      '</div>' +

      (addrLines ? '<div class="drawer-section"><div class="drawer-label">Shipping address</div>' +
        '<div class="drawer-address">' + (recipient ? '<strong>' + esc(recipient) + '</strong><br>' : '') + addrLines + '</div></div>' : '') +

      '<div class="drawer-section">' +
        '<div class="drawer-label">Items</div>' +
        '<div class="drawer-line-items">' + lineItemsHtml + '</div>' +
      '</div>' +

      (order.gift_message || order.has_gift_card ?
        '<div class="drawer-section">' +
          '<div class="drawer-label">Gift</div>' +
          (order.has_gift_card ? '<div class="drawer-gift-badge">🎁 Gift card included</div>' : '') +
          (order.gift_message ? '<div class="drawer-gift-note">' + esc(order.gift_message) + '</div>' : '') +
        '</div>' : '') +

      (order.tracking_number ?
        '<div class="drawer-section">' +
          '<div class="drawer-label">Tracking</div>' +
          '<div style="font-size:14px;line-height:1.6;">' +
            esc(order.tracking_carrier || 'Carrier') + ' · ' +
            '<span style="font-family:ui-monospace,Menlo,Consolas,monospace;">' + esc(order.tracking_number) + '</span>' +
            (order.tracking_url ? '<br><a href="' + esc(order.tracking_url) + '" target="_blank" rel="noopener" style="color:var(--navy,#003087);">Track parcel ↗</a>' : '') +
          '</div>' +
        '</div>' : '') +

      '<div class="drawer-section">' +
        '<div class="drawer-label">Details</div>' +
        '<div class="drawer-meta-grid">' +
          '<div class="drawer-meta-item"><div class="drawer-meta-item__label">Placed</div>' +
            '<div class="drawer-meta-item__val">' + shortDate(order.created_at) + '</div></div>' +
          '<div class="drawer-meta-item"><div class="drawer-meta-item__label">Status</div>' +
            '<div class="drawer-meta-item__val">' + (order.fulfilled ? '✓ Fulfilled' : 'Outstanding') + '</div></div>' +
          (order.fulfilled_at ? '<div class="drawer-meta-item"><div class="drawer-meta-item__label">Fulfilled</div>' +
            '<div class="drawer-meta-item__val">' + shortDate(order.fulfilled_at) + '</div></div>' : '') +
          '<div class="drawer-meta-item"><div class="drawer-meta-item__label">Payment</div>' +
            '<div class="drawer-meta-item__val">' + esc(order.payment_status || 'paid') + '</div></div>' +
        '</div>' +
      '</div>' +

      '<div class="drawer-section">' + fulfilBtn + '</div>';

    document.getElementById('drawerOverlay').classList.add('is-open');
    document.getElementById('orderDrawer').classList.add('is-open');

    var btn = document.getElementById('drawerFulBtn');
    if (btn) btn.addEventListener('click', function() {
      toggleFulfil(order, !order.fulfilled, btn);
    });
  }

  function closeDrawer() {
    document.getElementById('drawerOverlay').classList.remove('is-open');
    document.getElementById('orderDrawer').classList.remove('is-open');
    state.selectedOrder = null;
  }

  function toggleFulfil(order, fulfilled, btn, extra) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var payload = { stripe_session_id: order.stripe_session_id, fulfilled: fulfilled };
    if (extra && extra.tracking_carrier) payload.tracking_carrier = extra.tracking_carrier;
    if (extra && extra.tracking_number)  payload.tracking_number  = extra.tracking_number;
    fetch('/api/fulfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function(r){ return r.json(); }).then(function(result) {
      order.fulfilled = fulfilled;
      order.fulfilled_at = fulfilled ? new Date().toISOString() : null;
      if (result && result.order) {
        order.tracking_carrier = result.order.tracking_carrier;
        order.tracking_number  = result.order.tracking_number;
        order.tracking_url     = result.order.tracking_url;
        order.shipped_at       = result.order.shipped_at;
      } else if (!fulfilled) {
        order.tracking_carrier = order.tracking_number = order.tracking_url = order.shipped_at = null;
      }
      renderOrdersList();
      renderFulfilment();
      openDrawer(order); // re-render drawer
    }).catch(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Error — retry'; }
    });
  }

  // ============================================================
  //  PRODUCTS
  // ============================================================
  var PRODUCT_IMAGES = {
    'hepple-wild-juniper-gin':  './assets/products/hepple-gin.jpg',
    'hepple-douglas-fir-vodka': './assets/products/douglas-fir-scene.jpg',
    'hepple-moorland-vodka':    './assets/products/wheat-vodka.jpg',
  };

  function renderProductCards(m) {
    var grid = document.getElementById('productsGrid');
    if (!grid || !m) return;
    var by = (m.byProduct || []).slice();
    var maxRev = Math.max.apply(null, by.map(function(p){ return p.revenue; })) || 1;
    grid.innerHTML = by.map(function(p, i) {
      var pct = Math.round(p.revenue / maxRev * 100);
      var img = PRODUCT_IMAGES[p.slug] || '';
      var imgHtml = img
        ? '<div class="product-card__img-wrap"><img class="product-card__img" src="' + esc(img) + '" alt="' + esc(p.name) + '" /></div>'
        : '';
      return '<div class="product-card">' +
        imgHtml +
        '<div class="product-card__rank">' + (i + 1) + '</div>' +
        '<div class="product-card__name">' + esc(p.name) + '</div>' +
        '<div class="product-card__stats">' +
          '<div class="product-card__stat">' +
            '<div class="product-card__stat-label">Units</div>' +
            '<div class="product-card__stat-val">' + num(p.units) + '</div>' +
          '</div>' +
          '<div class="product-card__stat">' +
            '<div class="product-card__stat-label">Revenue</div>' +
            '<div class="product-card__stat-val">' + gbp(p.revenue, 0) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="product-card__bar-wrap">' +
          '<div class="product-card__bar" style="width:' + pct + '%"></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderProductLeaderboard() {
    var el = document.getElementById('productLeaderboard');
    if (!el || !state.orders) return;
    var lb = state.orders.productLeaderboard || [];
    if (!lb.length) { el.innerHTML = '<p class="empty-state">No product data yet.</p>'; return; }
    var maxUnits = Math.max.apply(null, lb.map(function(p){ return p.units; })) || 1;
    el.innerHTML = lb.map(function(p, i) {
      var art = productArt(p.sku, p.name);
      return '<div class="leader-row">' +
        '<span class="leader-row__pos">' + (i + 1) + '</span>' +
        (art
          ? '<a class="leader-row__thumb" href="' + esc(art.href) + '" target="_blank" rel="noopener"' +
              ' title="View ' + esc(p.name) + ' on the shop">' +
              '<img src="' + esc(art.img) + '" alt="' + esc(p.name) + '" loading="lazy"' +
              ' onerror="this.parentNode.style.display=\'none\'" /></a>'
          : '<span class="leader-row__thumb"></span>') +
        '<div><div class="leader-row__name">' + esc(p.name) + '</div>' +
          '<div class="leader-row__sku">' + esc(p.sku || '') + '</div></div>' +
        '<div class="leader-row__units">' + num(p.units) + ' units</div>' +
        '<div class="leader-row__rev">' + gbp(p.revenue, 2) + '</div>' +
        '<div class="leader-row__orders">' + p.orders + ' orders</div>' +
      '</div>';
    }).join('');

    // Also render product cards if on products page
    if (state.metrics) renderProductCards(state.metrics);
    if (!state.chartsBuilt.products) buildProductChart();
  }

  var productChartInst = null;
  function buildProductChart() {
    if (!state.orders) return;
    var lb = state.orders.productLeaderboard || [];
    if (!lb.length) return;
    state.chartsBuilt.products = true;
    var ctx = document.getElementById('productChart');
    if (!ctx) return;
    if (productChartInst) productChartInst.destroy();
    productChartInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: lb.map(function(p){ return ((p.name || '').replace('Hepple ','') || p.sku || 'Unknown'); }),
        datasets: [{
          label: 'Units sold',
          data: lb.map(function(p){ return p.units; }),
          backgroundColor: ['rgba(1,48,136,0.7)', 'rgba(1,48,136,0.45)', 'rgba(1,48,136,0.25)'],
          borderRadius: 4,
        }]
      },
      options: chartDefaults('', true)
    });
  }

  // ============================================================
  //  FULFILMENT
  // ============================================================
  // ---- Admin gift availability switch ----
  function renderGiftSwitch() {
    var btn = document.getElementById('giftSwitchBtn');
    var hint = document.getElementById('giftSwitchHint');
    if (!btn) return;
    var on = state.giftEnabled !== false;
    btn.textContent = on ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.style.background = on ? '#003087' : '#b8b2a4';
    if (hint) hint.textContent = on
      ? 'Customers can add a gift card & message at checkout.'
      : 'Gift option is hidden from the shop — customers can’t add cards.';
    btn.onclick = function () {
      var next = !(state.giftEnabled !== false);
      btn.disabled = true;
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gift_enabled: next }),
      }).then(function (r) { return r.json(); }).then(function (s) {
        state.giftEnabled = s && s.gift_enabled !== false;
        btn.disabled = false;
        renderGiftSwitch();
      }).catch(function () {
        btn.disabled = false;
        renderGiftSwitch();
      });
    };
  }

  function loadGiftSwitch() {
    fetch('/api/settings')
      .then(function (r) { return r.json(); })
      .then(function (s) { state.giftEnabled = s && s.gift_enabled !== false; renderGiftSwitch(); })
      .catch(function () { renderGiftSwitch(); });
  }

  function renderFulfilment() {
    loadGiftSwitch();
    if (!state.orders) return;
    var orders = state.orders.orders || [];
    var summary = state.orders.summary || {};

    document.getElementById('fulOpen').textContent = num(summary.outstanding || 0);
    document.getElementById('fulDone').textContent = num(summary.fulfilled || 0);
    document.getElementById('fulVal').textContent = gbp(summary.outstandingValue || 0, 2);

    var total = summary.total || 1;
    var pct = Math.round(((summary.fulfilled || 0) / total) * 100);
    document.getElementById('fulFill').style.width = pct + '%';

    // Outstanding only
    var outstanding = orders.filter(function(o){ return !o.fulfilled; });
    var el = document.getElementById('fulfilList');
    if (!outstanding.length) {
      el.innerHTML = '<p class="empty-state">All orders fulfilled 🎉</p>';
      return;
    }
    var CARRIERS = ['Royal Mail','Parcelforce','DPD','Evri','UPS','DHL','FedEx'];
    el.innerHTML = outstanding.map(function(o) {
      var addr = o.shipping_address || {};
      var recipient = (addr.name && addr.name !== o.customer_name) ? addr.name : '';
      var addrLines = [addr.line1, addr.line2, addr.city, addr.postal_code, addr.country]
        .filter(Boolean).join(', ');
      var items = o.items && o.items.length
        ? o.items.map(function(it){ return it.qty + '× ' + ((it.name || '').replace('Hepple ','') || it.sku || 'Unknown item'); }).join(', ')
        : (o.cart_summary || '—');
      var carrierOpts = '<option value="">Carrier…</option>' +
        CARRIERS.map(function(c){ return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
      return '<div class="fulfil-card">' +
        '<div class="fulfil-card__info">' +
          '<div class="fulfil-card__name">' + esc(o.customer_name || 'Unknown') + '</div>' +
          '<div class="fulfil-card__email">' + esc(o.customer_email || '') + '</div>' +
          (o.customer_phone ? '<div class="fulfil-card__phone" style="font-size:.8rem;color:var(--text2);">📞 ' + esc(o.customer_phone) + '</div>' : '') +
          (addrLines ? '<div class="fulfil-card__addr">📍 ' + (recipient ? '<strong>' + esc(recipient) + '</strong> — ' : '') + esc(addrLines) + '</div>' : '<div class="fulfil-card__addr fulfil-card__addr--missing">⚠️ No shipping address</div>') +
        '</div>' +
        '<div class="fulfil-card__items">' + esc(items) + '</div>' +
        '<div class="fulfil-card__total">' + gbp(o.total, 2) + '</div>' +
        '<div class="fulfil-card__date">' + shortDate(o.created_at) + '</div>' +
        '<div class="fulfil-card__ship" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;">' +
          '<select data-carrier style="padding:7px 9px;border:1px solid #d8d2c4;border-radius:8px;background:#fff;font-size:13px;">' + carrierOpts + '</select>' +
          '<input data-track type="text" placeholder="Tracking no. (optional)" autocomplete="off" style="flex:1;min-width:130px;padding:7px 10px;border:1px solid #d8d2c4;border-radius:8px;font-size:13px;" />' +
          '<button class="fulfil-card__btn" data-id="' + esc(o.stripe_session_id) + '">Mark fulfilled</button>' +
        '</div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('.fulfil-card__btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.dataset.id;
        var order = orders.find(function(o){ return o.stripe_session_id === id; });
        var card = btn.closest('.fulfil-card');
        var sel = card && card.querySelector('[data-carrier]');
        var inp = card && card.querySelector('[data-track]');
        var extra = {
          tracking_carrier: sel ? sel.value : '',
          tracking_number:  inp ? inp.value.trim() : '',
        };
        if (extra.tracking_number && !extra.tracking_carrier) {
          if (sel) { sel.style.borderColor = '#c00'; sel.focus(); }
          return; // a tracking number needs a carrier to build the link
        }
        if (order) toggleFulfil(order, true, btn, extra);
      });
    });
  }

  // ============================================================
  //  TRAFFIC
  // ============================================================
  function renderTrafficKPIs(a) {
    var el = document.getElementById('trafficKpis');
    if (!el) return;
    var stats = [
      { label: 'Pageviews',    val: num(a.pageviews || 0) },
      { label: 'Unique visitors', val: num(a.uniqueVisitors || 0) },
      { label: 'Conversion',   val: (a.conversionRate || 0) + '%' },
      { label: 'Abandoned carts', val: num(a.abandonedCarts || 0) },
    ];
    el.innerHTML = stats.map(function(s) {
      return '<div class="traffic-kpi"><div class="traffic-kpi__label">' + esc(s.label) +
        '</div><div class="traffic-kpi__val">' + esc(s.val) + '</div></div>';
    }).join('');
  }

  var visitorsChartInst = null;
  function buildTrafficChart() {
    if (!state.analytics) return;
    state.chartsBuilt.traffic = true;
    var dv = state.analytics.dailyVisitors || [];
    var ctx = document.getElementById('visitorsChart');
    if (!ctx) return;
    if (visitorsChartInst) visitorsChartInst.destroy();
    visitorsChartInst = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dv.map(function(d){ return d.date ? d.date.slice(5) : ''; }),
        datasets: [{
          label: 'Visitors',
          data: dv.map(function(d){ return d.visitors || 0; }),
          borderColor: '#013088',
          backgroundColor: 'rgba(1,48,136,0.06)',
          fill: true, tension: 0.4, pointRadius: 2,
          pointBackgroundColor: 'rgba(91,141,238,.9)',
        }]
      },
      options: chartDefaults('', false)
    });
  }

  function renderFunnel(a) {
    var el = document.getElementById('funnelList');
    if (!el || !a) return;
    var funnel = a.funnel || [];
    var max = funnel.length ? funnel[0].count || 1 : 1;
    el.innerHTML = funnel.map(function(step, i) {
      var pct = max ? Math.round(step.count / max * 100) : 0;
      var cvr = i > 0 && funnel[i-1].count ? Math.round(step.count / funnel[i-1].count * 100) : null;
      return '<div class="funnel-step">' +
        '<div class="funnel-step__header">' +
          '<span class="funnel-step__name">' + esc(step.step) + '</span>' +
          '<span><span class="funnel-step__count">' + num(step.count) + '</span>' +
            (cvr !== null ? '<span class="funnel-step__pct">(' + cvr + '%)</span>' : '') +
          '</span>' +
        '</div>' +
        '<div class="funnel-step__bar-bg"><div class="funnel-step__bar" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  function renderTopPages(a) {
    var el = document.getElementById('topPagesList');
    if (!el || !a) return;
    var pages = a.topPages || [];
    var max = pages.length ? pages[0].views || 1 : 1;
    el.innerHTML = pages.map(function(p) {
      var pct = Math.round(p.views / max * 100);
      return '<div class="bar-item">' +
        '<div class="bar-item__header">' +
          '<span class="bar-item__name">' + esc(p.path || '/') + '</span>' +
          '<span class="bar-item__count">' + num(p.views) + '</span>' +
        '</div>' +
        '<div class="bar-item__bar-bg"><div class="bar-item__bar" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  function renderSources(a) {
    var el = document.getElementById('sourcesList');
    if (!el || !a) return;
    var sources = a.sources || [];
    var max = sources.length ? sources[0].visitors || 1 : 1;
    el.innerHTML = sources.map(function(s) {
      var pct = Math.round(s.visitors / max * 100);
      return '<div class="bar-item">' +
        '<div class="bar-item__header">' +
          '<span class="bar-item__name">' + esc(s.source) + '</span>' +
          '<span class="bar-item__count">' + num(s.visitors) + '</span>' +
        '</div>' +
        '<div class="bar-item__bar-bg"><div class="bar-item__bar" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  // ============================================================
  //  CUSTOMERS
  // ============================================================
  function renderCustomers() {
    var el = document.getElementById('custList');
    if (!el || !state.orders) return;
    var custs;
    // Prefer whole-history figures from the customer_summary RPC.
    if (state.orders.customers && state.orders.customers.length) {
      custs = state.orders.customers.map(function(c){
        return { email: c.email, name: c.name, orders: c.orders, spent: +(+c.spent).toFixed(2), last: c.last_order };
      }).slice(0, 20);
    } else {
      // Fallback: aggregate from the windowed orders list (pre-RPC behaviour).
      var orders = state.orders.orders || [];
      var map = new Map();
      orders.forEach(function(o) {
        var k = o.customer_email;
        if (!k) return;
        var cur = map.get(k) || { email: k, name: o.customer_name, orders: 0, spent: 0, last: o.created_at };
        cur.orders += 1; cur.spent += o.total;
        if (o.created_at > cur.last) cur.last = o.created_at;
        map.set(k, cur);
      });
      custs = Array.from(map.values())
        .map(function(c){ return Object.assign({}, c, { spent: +c.spent.toFixed(2) }); })
        .sort(function(a, b){ return b.spent - a.spent })
        .slice(0, 20);
    }

    if (!custs.length) { el.innerHTML = '<p class="empty-state">No customer data yet.</p>'; return; }
    el.innerHTML = custs.map(function(c, i) {
      var rankCls = i === 0 ? 'cust-card__rank--gold' : '';
      return '<div class="cust-card">' +
        '<div class="cust-card__rank ' + rankCls + '">' + (i + 1) + '</div>' +
        '<div><div class="cust-card__name">' + esc(c.name || 'Unknown') + '</div>' +
          '<div class="cust-card__email">' + esc(c.email) + '</div></div>' +
        '<div class="cust-card__orders"><div>' + c.orders + '</div><div class="cust-card__orders-label">orders</div></div>' +
        '<div class="cust-card__spent">' + gbp(c.spent, 2) + '</div>' +
        '<div class="cust-card__last">' + timeAgo(c.last) + '</div>' +
      '</div>';
    }).join('');
  }

  // ============================================================
  //  CHART DEFAULTS
  // ============================================================
  function chartDefaults(prefix, integers) {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: '#e2dace',
          borderWidth: 1,
          titleColor: '#4a4a6a',
          bodyColor: '#1a1a2e',
          padding: 10,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              if (prefix === '£') return ' ' + gbp(v, 2);
              return ' ' + (integers ? Math.round(v) : v);
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { color: '#8888a8', font: { family: 'DM Mono', size: 11 }, maxRotation: 0 },
          border: { display: false }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: {
            color: '#8888a8', font: { family: 'DM Mono', size: 11 },
            callback: function(v) {
              if (prefix === '£') return v >= 1000 ? '£' + (v/1000).toFixed(1) + 'k' : '£' + v;
              return integers ? Math.round(v) : v;
            }
          },
          border: { display: false }
        }
      }
    };
  }


  // ============================================================
  //  PRODUCT ART
  //  Thumbnails for the leaderboard, served straight off the live shop so
  //  there's nothing to keep in sync here. Clicking one opens that product's
  //  page. Change SHOP_ORIGIN if the storefront ever moves.
  // ============================================================
  var SHOP_ORIGIN = 'https://www.hepplespirits.com';

  var PRODUCT_ART = {
    'HEP-GIN-70':    { slug: 'hepple-wild-juniper-gin', file: 'hepple-gin.jpg' },
    'HEP-DFV-70':    { slug: 'hepple-douglas-fir-vodka', file: 'douglas-fir.jpg' },
    'HEP-WHV-70':    { slug: 'hepple-moorland-vodka',    file: 'wheat-vodka.jpg' },
    'HEP-SLO-50':    { slug: 'hepple-sloe-hawthorn',     file: 'sloe-hawthorn-main.jpg' },
    'HEP-AQV-70':    { slug: 'hepple-aquavit',           file: 'aquavit-main.jpg' },
    'HEP-NEG-70':    { slug: 'hepple-negroni',           file: 'negroni-main.jpg' },
    // Historic / alternate SKUs seen on older Shopify orders
    'SLOE-HAWTHORN': { slug: 'hepple-sloe-hawthorn',     file: 'sloe-hawthorn-main.jpg' },
    'AQUAVIT':       { slug: 'hepple-aquavit',           file: 'aquavit-main.jpg' }
  };

  // Fallback for rows whose SKU we don't recognise — match on the name instead.
  var ART_BY_WORD = [
    { test: /juniper|hepple gin/i, sku: 'HEP-GIN-70' },
    { test: /douglas/i,            sku: 'HEP-DFV-70' },
    { test: /moorland|wheat/i,     sku: 'HEP-WHV-70' },
    { test: /sloe|hawthorn/i,      sku: 'HEP-SLO-50' },
    { test: /aquavit/i,            sku: 'HEP-AQV-70' },
    { test: /negroni/i,            sku: 'HEP-NEG-70' }
  ];

  function productArt(sku, name) {
    var art = PRODUCT_ART[String(sku || '').toUpperCase()];
    if (!art) {
      for (var i = 0; i < ART_BY_WORD.length; i++) {
        if (ART_BY_WORD[i].test.test(String(name || ''))) { art = PRODUCT_ART[ART_BY_WORD[i].sku]; break; }
      }
    }
    if (!art) return null;   // gift card and anything unknown get no thumbnail
    return {
      img:  SHOP_ORIGIN + '/assets/products/' + art.file,
      href: SHOP_ORIGIN + '/#/shop/' + art.slug
    };
  }

  // ============================================================
  //  DISCOUNTS
  // ============================================================
  var discLoaded = false;

  function discMsg(kind, text) {
    var el = document.getElementById('discMsg');
    if (!el) return;
    el.hidden = false;
    el.className = 'disc-msg disc-msg--' + kind;
    el.textContent = text;
    if (kind === 'ok') setTimeout(function(){ el.hidden = true; }, 4000);
  }

  function discTerms(c) {
    var t = c.kind === 'percent'
      ? (Number(c.value) + '% off')
      : (gbp(c.value, 2) + ' off');
    if (c.free_shipping) t += ' + free delivery';
    if (!c.once_per_customer) t += ' · reusable';
    if (c.stripe_coupon_id) t += ' · stripe coupon';
    return t;
  }

  function discDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  }

  function loadDiscounts(force) {
    if (discLoaded && !force) return;
    discLoaded = true;
    api('/api/discounts').then(function (d) {
      if (d && d.demo) state.anyDemo = true;
      renderDiscounts((d && d.codes) || []);
    });
  }

  function renderDiscounts(codes) {
    var el = document.getElementById('discList');
    if (!el) return;
    if (!codes.length) {
      el.innerHTML = '<p class="empty-state">No codes yet — add one above.</p>';
      return;
    }
    el.innerHTML = codes.map(function (c) {
      var used = Number(c.times_used || 0);
      return '' +
        '<div class="disc-row' + (c.active ? '' : ' disc-row--off') + '">' +
          '<div>' +
            '<div class="disc-row__code">' + esc(c.code) + '</div>' +
            '<div class="disc-row__terms">' + esc(discTerms(c)) +
              (c.description ? ' — ' + esc(c.description) : '') + '</div>' +
          '</div>' +
          '<div class="disc-row__stat">' + num(used) + '<span>USED</span></div>' +
          '<div class="disc-row__stat">' + gbp(c.total_discount, 2) + '<span>GIVEN</span></div>' +
          '<div class="disc-row__stat disc-row__rev">' + gbp(c.total_revenue, 2) + '<span>' +
            (used ? esc(discDate(c.last_used_at)) : 'REVENUE') + '</span></div>' +
          '<div class="disc-row__acts">' +
            '<button class="disc-mini" data-disc-orders="' + esc(c.code) + '"' +
              (used ? '' : ' disabled') + '>Orders</button>' +
            '<button class="disc-mini" data-disc-toggle="' + c.id + '" data-active="' +
              (c.active ? '1' : '0') + '">' + (c.active ? 'Turn off' : 'Turn on') + '</button>' +
            '<button class="disc-mini disc-mini--danger" data-disc-del="' + c.id +
              '" data-used="' + used + '">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="disc-orders" id="discOrders-' + c.id + '" hidden></div>';
    }).join('');
  }

  function showDiscOrders(code, id, btn) {
    var box = document.getElementById('discOrders-' + id);
    if (!box) return;
    if (!box.hidden) { box.hidden = true; btn.textContent = 'Orders'; return; }

    btn.disabled = true; btn.textContent = 'Loading…';
    api('/api/discounts?code=' + encodeURIComponent(code)).then(function (d) {
      var orders = (d && d.orders) || [];
      box.innerHTML = orders.length
        ? '<table><thead><tr>' +
            '<th>Order</th><th>Date</th><th>Customer</th>' +
            '<th class="num">Discount</th><th class="num">Paid</th><th>Status</th>' +
          '</tr></thead><tbody>' +
          orders.map(function (o) {
            return '<tr>' +
              '<td>#' + esc(o.order_id) + '</td>' +
              '<td>' + esc(discDate(o.created_at)) + '</td>' +
              '<td>' + esc(o.customer_name || o.customer_email || '—') + '</td>' +
              '<td class="num">−' + gbp(o.discount_amount, 2) + '</td>' +
              '<td class="num">' + gbp(o.total, 2) + '</td>' +
              '<td>' + (o.fulfilled ? 'Fulfilled' : esc(o.payment_status || 'Pending')) + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>'
        : '<p class="empty-state">No orders yet.</p>';
      box.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Hide';
    });
  }

  function bootDiscounts() {
    var form = document.getElementById('discForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = document.getElementById('discAdd');
        btn.disabled = true; btn.textContent = 'Adding…';
        fetch('/api/discounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code:              document.getElementById('discCode').value,
            kind:              document.getElementById('discKind').value,
            value:             document.getElementById('discValue').value,
            description:       document.getElementById('discDesc').value,
            free_shipping:     document.getElementById('discShip').checked,
            once_per_customer: document.getElementById('discOnce').checked
          })
        }).then(function (r) { return r.json(); }).then(function (d) {
          btn.disabled = false; btn.textContent = 'Add code';
          if (d && d.error) return discMsg('err', d.error);
          discMsg('ok', (d.code ? d.code.code : 'Code') + ' added and live on the shop.');
          form.reset();
          document.getElementById('discOnce').checked = true;
          loadDiscounts(true);
        }).catch(function () {
          btn.disabled = false; btn.textContent = 'Add code';
          discMsg('err', 'Could not reach the server.');
        });
      });
    }

    var list = document.getElementById('discList');
    if (!list) return;
    list.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button');
      if (!btn) return;

      if (btn.dataset.discOrders) {
        var row = btn.closest('.disc-row').nextElementSibling;
        return showDiscOrders(btn.dataset.discOrders, row.id.replace('discOrders-', ''), btn);
      }

      if (btn.dataset.discToggle) {
        btn.disabled = true;
        fetch('/api/discounts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(btn.dataset.discToggle), active: btn.dataset.active !== '1' })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.error) { discMsg('err', d.error); btn.disabled = false; return; }
          loadDiscounts(true);
        }).catch(function () { btn.disabled = false; });
        return;
      }

      if (btn.dataset.discDel) {
        var used = Number(btn.dataset.used || 0);
        var warn = used
          ? 'This code has been used on ' + used + ' order' + (used === 1 ? '' : 's') + '.\n\n' +
            'Deleting keeps those orders but the report loses the code\'s type and value. ' +
            'Turning it off instead keeps the history intact.\n\nDelete anyway?'
          : 'Delete this code?';
        if (!confirm(warn)) return;
        btn.disabled = true;
        fetch('/api/discounts?id=' + encodeURIComponent(btn.dataset.discDel), { method: 'DELETE' })
          .then(function (r) { return r.json(); }).then(function (d) {
            if (d && d.error) { discMsg('err', d.error); btn.disabled = false; return; }
            loadDiscounts(true);
          }).catch(function () { btn.disabled = false; });
      }
    });
  }

  // ---- kickoff ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
