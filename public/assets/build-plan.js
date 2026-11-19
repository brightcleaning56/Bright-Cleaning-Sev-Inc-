// Build Your Plan: estimates a monthly price from the chosen rooms and tasks.
// Prices come from the approved draft: task price per visit, $60 minimum per visit, frequency = visits per month.
(function () {
  var MIN_PER_VISIT = 60;
  var monthlyEl = document.getElementById('monthly'), perVisitEl = document.getElementById('perVisit');
  var deepNote = document.getElementById('deepNote'), sendPlan = document.getElementById('sendPlan');
  var inputs = document.querySelectorAll('[data-task]');
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function freq() {
    var r = document.querySelector('input[name="freq"]:checked');
    return r ? Number(r.value) : 1;
  }
  function deep() {
    var r = document.querySelector('input[name="deep"]:checked');
    return r ? r.value : 'no';
  }
  function summary() {
    var parts = [];
    inputs.forEach(function (el) {
      if (el.type === 'checkbox' && el.checked) parts.push(el.getAttribute('data-label'));
      if (el.type !== 'checkbox' && Number(el.value) > 0) parts.push(el.getAttribute('aria-label').replace('Number of ','') + ': ' + el.value);
    });
    return (parts.join(', ') || 'no rooms selected') + '. ' + (freq() === 1 ? 'Monthly' : freq() === 2 ? 'Biweekly' : 'Weekly') + ' (' + monthlyEl.textContent + '). Deep clean: ' + deep() + '.';
  }
  function update() {
    var perVisit = 0, count = 0;
    inputs.forEach(function (el) {
      var price = Number(el.getAttribute('data-price')) || 0;
      if (el.type === 'checkbox') {
        if (el.checked) { perVisit += price; count++; }
      } else {
        var qty = Math.max(0, Math.min(Number(el.max) || 0, Math.floor(Number(el.value) || 0)));
        if (qty > 0) { perVisit += price * qty; count += qty; }
      }
    });
    if (count === 0) {
      monthlyEl.textContent = '$0';
      perVisitEl.textContent = 'Choose at least one room or task.';
    } else {
      var visit = Math.max(perVisit, MIN_PER_VISIT);
      var monthly = visit * freq();
      monthlyEl.textContent = money(monthly) + ' / month';
      perVisitEl.textContent = money(visit) + ' per visit' + (perVisit < MIN_PER_VISIT ? ' (minimum applied)' : '') + ', ' + freq() + ' visit' + (freq() === 1 ? '' : 's') + ' a month';
    }
    deepNote.hidden = deep() === 'no';
    sendPlan.href = '/request-a-quote.html?plan=' + encodeURIComponent(summary());
  }
  inputs.forEach(function (el) { el.addEventListener('input', update); el.addEventListener('change', update); });
  document.querySelectorAll('input[name="freq"], input[name="deep"]').forEach(function (el) { el.addEventListener('change', update); });
  update();
})();
