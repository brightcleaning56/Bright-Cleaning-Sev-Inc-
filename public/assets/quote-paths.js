(function(){
  var sets={construction:['Post-construction final cleaning','Rough / progress cleaning','Punch-list / touch-up cleaning','Interior / exterior window cleaning'],
    commercial:['Commercial janitorial','Commercial restroom cleaning','Commercial floor care','Power washing','Parking lot pickup / maintenance','Valet trash'],
    multifamily:['Apartment common-area cleaning','Unit turnover cleaning']};
  document.querySelectorAll('.qpath').forEach(function(b){
    b.addEventListener('click',function(){
      var key=b.getAttribute('data-path');
      document.querySelectorAll('.qpath').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});
      document.querySelectorAll('input[name=service]').forEach(function(cb){cb.checked=sets[key].indexOf(cb.value)>-1;});
    });
  });
})();
