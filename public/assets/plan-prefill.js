// Request a Quote: if the visitor came from Build Your Plan, fill the details box with their plan summary.
(function () {
  var plan = new URLSearchParams(location.search).get('plan');
  if (!plan) return;
  var box = document.querySelector('textarea[name="details"]');
  if (!box || box.value) return;
  box.value = 'Plan from the Build Your Plan page:\n' + plan + '\n\nPlease confirm this plan and the deep-clean question with us.';
})();
