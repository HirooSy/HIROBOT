
(function(){
  document.querySelectorAll('a[data-enc]').forEach(function(el){
    el.addEventListener('click', function(e){
      e.preventDefault();
      window.open(atob(el.getAttribute('data-enc')), '_blank', 'noopener');
    });
  });
})();
(async () => {
  try {
    const res = await safeFetch('/api/discord/config')
    const data = await res.json()
    if (data.enabled) document.querySelectorAll('.discord-login-btn').forEach(btn => { btn.style.display = '' })
  } catch {}
})()

function startDiscordLogin() {
  location.href = '/api/discord/login'
}
