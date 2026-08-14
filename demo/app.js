(() => {
  'use strict';

  const fixturePages = [
    { kicker: 'Generated fixture / page 01', title: 'Acquisition brief', copy: 'This sanitized two-page sample stands in for a local PDF. It contains no personal, customer, host, or document data.', footer: 'Generated for the static Platen demo · no source file exists' },
    { kicker: 'Generated fixture / page 02', title: 'Review scope', list: ['Inspect source facts before an operation.', 'Keep the selected source immutable.', 'Validate a distinct output against the operation boundary.'], footer: 'Illustrative fixture content · no operation has run' }
  ];
  const coverage = [
    ['Inspection', 'Page count and local metadata inventory', 'Proven'],
    ['Composition', 'Validated extraction for admitted PDFs', 'Bounded'],
    ['Accessibility', 'Heuristic review, not conformance', 'Bounded'],
    ['Redaction', 'Full-page object redaction only', 'Bounded'],
    ['AI', 'No executable demo capability', 'Unavailable']
  ];
  let selectedPage = 1;
  const paper = document.querySelector('#paper');
  const feedback = document.querySelector('#feedback');
  const pagePosition = document.querySelector('#page-position');
  const stagePage = document.querySelector('#stage-page');

  function renderPage() {
    const page = fixturePages[selectedPage - 1];
    paper.innerHTML = `<div class="document-kicker">${page.kicker}</div><h2 class="document-title">${page.title}</h2><div class="document-rule"></div>${page.copy ? `<p class="document-copy">${page.copy}</p>` : `<ul class="document-list">${page.list.map((item) => `<li>${item}</li>`).join('')}</ul>`}<footer>${page.footer}</footer>`;
    pagePosition.textContent = `${selectedPage} / ${fixturePages.length}`;
    stagePage.textContent = `Page ${selectedPage} of ${fixturePages.length}`;
    document.querySelector('#previous-page').disabled = selectedPage === 1;
    document.querySelector('#next-page').disabled = selectedPage === fixturePages.length;
    document.querySelectorAll('.page-thumb').forEach((button) => {
      const current = Number(button.dataset.page) === selectedPage;
      button.classList.toggle('is-selected', current);
      button.toggleAttribute('aria-current', current);
    });
  }

  function setPage(page) {
    selectedPage = Math.min(fixturePages.length, Math.max(1, page));
    renderPage();
    feedback.textContent = `Showing generated fixture page ${selectedPage} of ${fixturePages.length}. No file activity is possible.`;
  }

  function setRoute(route) {
    const validRoute = document.querySelector(`[data-view="${route}"]`) ? route : 'workspace';
    document.querySelectorAll('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== validRoute; });
    document.querySelectorAll('[data-route]').forEach((link) => { link.toggleAttribute('aria-current', link.dataset.route === validRoute); });
    document.title = `${validRoute[0].toUpperCase()}${validRoute.slice(1)} · Platen static demo`;
  }

  function renderCoverage(query = '') {
    const normalized = query.trim().toLowerCase();
    const matches = coverage.filter((row) => row.join(' ').toLowerCase().includes(normalized));
    document.querySelector('#coverage-rows').innerHTML = matches.length
      ? matches.map(([area, boundary, status]) => `<tr><td>${area}</td><td>${boundary}</td><td><span class="badge ${status === 'Proven' ? 'neutral' : ''}">${status}</span></td></tr>`).join('')
      : '<tr><td colspan="3">No generated examples match this filter.</td></tr>';
  }

  document.querySelectorAll('.page-thumb').forEach((button) => button.addEventListener('click', () => setPage(Number(button.dataset.page))));
  document.querySelector('#previous-page').addEventListener('click', () => setPage(selectedPage - 1));
  document.querySelector('#next-page').addEventListener('click', () => setPage(selectedPage + 1));
  document.querySelectorAll('.simulated-action').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.action;
    feedback.textContent = `Simulated: ${action} was not run. This static demo cannot process, export, or change files.`;
  }));
  document.querySelector('#coverage-filter').addEventListener('input', (event) => renderCoverage(event.target.value));
  window.addEventListener('hashchange', () => setRoute(location.hash.slice(1)));
  renderPage();
  renderCoverage();
  setRoute(location.hash.slice(1) || 'workspace');
})();
